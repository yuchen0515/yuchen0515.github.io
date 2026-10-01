#!/usr/bin/env python3
"""Review an explicit public tree and every public ancestor before a release."""
import argparse
import datetime
import json
import subprocess
import sys
from pathlib import Path

# Importing the policy must not create unreviewed files before the clean-tree
# check, including in isolated repositories without a Python ignore rule.
sys.dont_write_bytecode = True
from publication_policy import POLICY_VERSION, classify_path, document_disclosures, internal_path_reason, public_document

root = Path(__file__).resolve().parent.parent
PUBLISHED_BASE = '248457d659c1524f841223856f8cf3ece4c2ca58'


def git(*args, data=None):
    return subprocess.check_output(['git', '-C', str(root), *args], input=data, stderr=subprocess.PIPE)


def entries(revision):
    result = []
    for item in git('ls-tree', '-rz', '--full-tree', revision).split(b'\0'):
        if item:
            info, name = item.split(b'\t', 1)
            mode, kind, sha = info.split()
            result.append((name.decode(), mode.decode(), kind.decode(), sha.decode()))
    return result


def publication(revision):
    helper = root/'lib/public-assets.cjs'
    result = subprocess.check_output(['node', str(helper), '--git-tree-publication', revision], cwd=root, stderr=subprocess.PIPE)
    metadata = json.loads(result)
    return set(metadata['uploads']), set(metadata['private_posts'])


def history_violations(parent, published):
    """Audit all ancestry, including files removed from the latest release."""
    failures = []
    release_commits = set()
    for line in git('rev-list', '--parents', f'{published}..{parent}').decode().splitlines():
        commit_and_parents = line.split()
        commit = commit_and_parents[0]
        release_commits.add(commit)
        if len(commit_and_parents) != 2:
            failures.append({'commit': commit, 'reason': 'source release history contains a merge or unexpected root'})
        paths = entries(commit)
        for name, mode, kind, sha in paths:
            reason = classify_path(name, mode)
            if reason:
                failures.append({'commit': commit, 'path': name, 'reason': reason})
            elif kind != 'blob':
                failures.append({'commit': commit, 'path': name, 'reason': 'public entry is not a regular blob'})
            elif public_document(name):
                for disclosure in document_disclosures(name, git('cat-file', 'blob', sha)):
                    failures.append({'commit': commit, 'path': name, 'reason': disclosure})
        previous_uploads, previous_private_posts = publication(commit)
        for name in sorted(previous_private_posts):
            failures.append({'commit': commit, 'path': name, 'reason': 'unpublished article source'})
        for name, _, _, _ in paths:
            if name.startswith('source/images/uploads/') and name not in previous_uploads:
                failures.append({'commit': commit, 'path': name, 'reason': 'unpublished upload'})
    # The pinned legacy site used a generated-file layout. Keep its assets and
    # URLs intact, but do not exempt internal documents in that older ancestry.
    legacy_commits = git('rev-list', published).decode().splitlines()
    for commit in legacy_commits:
        for name, _, kind, sha in entries(commit):
            reason = internal_path_reason(name)
            if reason:
                failures.append({'commit': commit, 'path': name, 'reason': reason})
            elif kind == 'blob' and public_document(name):
                for disclosure in document_disclosures(name, git('cat-file', 'blob', sha)):
                    failures.append({'commit': commit, 'path': name, 'reason': disclosure})
    return failures, len(release_commits) + len(legacy_commits)


def write_tree(directory):
    rows = []
    for name, item in directory.items():
        if isinstance(item, dict):
            mode, kind, sha = b'040000', b'tree', write_tree(item)
        else:
            mode, kind, sha = item
        rows.append(mode + b' ' + kind + b' ' + sha + b'\t' + name + b'\0')
    return git('mktree', '-z', data=b''.join(rows)).strip()


def tree_from_entries(items):
    tree = {}
    for name, mode, kind, sha in items:
        parts = name.encode().split(b'/')
        cursor = tree
        for part in parts[:-1]:
            cursor = cursor.setdefault(part, {})
        cursor[parts[-1]] = (mode.encode(), kind.encode(), sha.encode())
    return tree


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review-only', action='store_true', help='Write a local review receipt without creating a commit or changing any ref.')
    args = parser.parse_args()
    clean = not git('status', '--porcelain').strip()
    if not clean and not args.review_only:
        raise SystemExit('Commit the reviewed work on its feature branch first; no source branch was changed.')
    source = git('rev-parse', 'HEAD').decode().strip()
    published = git('rev-parse', 'master').decode().strip()
    checker = root/'tools/git-history/check-authorship.py'
    if published != PUBLISHED_BASE:
        raise SystemExit('The preserved public master changed; review the publication base before preparing another release.')
    exists = subprocess.run(['git', '-C', str(root), 'show-ref', '--verify', '--quiet', 'refs/heads/source']).returncode == 0
    parent = git('rev-parse', 'source').decode().strip() if exists else published
    if subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', published, parent]).returncode:
        raise SystemExit('The proposed source parent is outside the preserved public history; review it before proceeding.')

    included = []
    excluded = []
    candidate_failures = []
    source_entries = entries(source)
    policy_entries = [item for item in source_entries if classify_path(item[0], item[1]) is None and item[2] == 'blob']
    # An internal source Markdown file must not make its private images public.
    # Read frontmatter and image references only after applying the path policy.
    policy_tree = write_tree(tree_from_entries(policy_entries)).decode()
    allowed_uploads, private_posts = publication(policy_tree)
    final_entries = []
    for name, mode, kind, sha in source_entries:
        reason = classify_path(name, mode)
        if reason is None and name in private_posts:
            reason = 'unpublished article source'
        elif reason is None and name.startswith('source/images/uploads/') and name not in allowed_uploads:
            reason = 'unpublished upload'
        if reason:
            excluded.append({'path': name, 'reason': reason})
            continue
        if kind != 'blob':
            candidate_failures.append({'path': name, 'reason': 'public entry is not a regular blob'})
            continue
        if public_document(name):
            for disclosure in document_disclosures(name, git('cat-file', 'blob', sha)):
                candidate_failures.append({'path': name, 'reason': disclosure})
        included.append({'path': name, 'mode': mode, 'blob': sha})
        final_entries.append((name, mode, kind, sha))
    tree_hash = write_tree(tree_from_entries(final_entries)).decode()
    failures, checked_commits = history_violations(parent, published)
    authorship = subprocess.run(['python3', str(checker), 'history', '--repo', str(root), '--revision', parent], text=True, capture_output=True)
    if authorship.returncode:
        failures.append({'reason': 'public parent history failed the authorship check'})

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    receipt_dir = root/'.history/publication-candidates'/stamp
    receipt_dir.mkdir(parents=True, exist_ok=False)
    receipt = {
        'policy_version': POLICY_VERSION,
        'source_branch': 'source',
        'tree': tree_hash,
        'parent': parent,
        'reviewed_feature': source,
        'preserved_public_master': published,
        'worktree_clean': clean,
        'included_files': sorted(included, key=lambda item: item['path']),
        'excluded_files': sorted(excluded, key=lambda item: item['path']),
        'excluded_paths': sorted(item['path'] for item in excluded),
        'candidate_violations': candidate_failures,
        'history_checked_commits': checked_commits,
        'history_violations': failures,
        'parent_history_approved': not failures,
        'review_only': args.review_only,
        'source_ref_changed': False,
        'external_push_performed': False,
    }
    receipt_path = receipt_dir/'receipt.json'

    def save_receipt():
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')

    save_receipt()
    print(f'Public-tree review: {len(included)} included files, {len(excluded)} reasoned exclusions, {checked_commits} historical commits checked.')
    print(f'Local review receipt: {receipt_path.relative_to(root)}')
    if candidate_failures:
        raise SystemExit('A public document contains internal operating information; review the local receipt. No source branch was changed.')
    if failures:
        reasons = {item['reason'] for item in failures}
        if any('merge' in reason for reason in reasons):
            raise SystemExit('Source release history contains a merge or unexpected root; no source branch was changed.')
        if 'unpublished article source' in reasons:
            raise SystemExit('A previous source release contains unpublished article source; review its history before proceeding.')
        raise SystemExit('A previous source release or preserved ancestor contains private files or files outside the public allowlist; review its history before proceeding. No source branch was changed.')
    if args.review_only:
        print('Review only: no commit, ref change, push, or remote action performed.')
        return 0
    if exists and git('rev-parse', 'source^{tree}').decode().strip() == tree_hash:
        print('Source branch already matches the reviewed publication tree; no commit or remote action performed.')
        return 0
    message = receipt_dir/'message.txt'
    message.write_text('Rebuild Markdown source and reading experience\n' if not exists else 'Update articles and website source\n')
    subprocess.run(['python3', str(checker), 'message', '--repo', str(root), '--message-file', str(message)], check=True)
    commit = git('commit-tree', tree_hash, '-p', parent, data=message.read_bytes()).decode().strip()
    subprocess.run(['python3', str(checker), 'history', '--repo', str(root), '--revision', commit], check=True)
    # Compare-and-swap protects another working line's ref. Preserve all old
    # objects and local evidence; this script never contacts a remote service.
    git('update-ref', 'refs/heads/source', commit, parent if exists else '0'*40)
    receipt.update(commit=commit, source_ref_changed=True, private_source_ancestry_included=False)
    save_receipt()
    print(f'Local source branch prepared: {commit}. Review the receipt before any public push.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
