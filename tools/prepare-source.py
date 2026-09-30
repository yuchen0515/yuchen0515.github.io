#!/usr/bin/env python3
"""Prepare a local Pages source branch without private drafts or source history."""
import datetime
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
PUBLISHED_BASE = '248457d659c1524f841223856f8cf3ece4c2ca58'

def private_path(name):
    parts = name.split('/')
    return (name.startswith('source/_drafts/') or name == '_llm_scratchpad.md'
            or any(part in {'.history', 'audit', '.claude', '.wrangler', 'node_modules', '.fixtures', '__pycache__'} for part in parts)
            or name.startswith('public/')
            or parts[-1] == '.dev.vars'
            or (parts[-1].startswith('.env') and parts[-1] != '.env.example'))

def git(*args, data=None):
    return subprocess.check_output(['git', '-C', str(root), *args], input=data)

def public_uploads(revision):
    helper = root/'lib/public-assets.cjs'
    result = subprocess.check_output(['node', str(helper), '--git-tree', revision], cwd=root)
    return set(json.loads(result))

if git('status', '--porcelain').strip():
    raise SystemExit('Commit the reviewed work on its feature branch first; no source branch was changed.')
source = git('rev-parse', 'HEAD').decode().strip()
published = git('rev-parse', 'master').decode().strip()
checker = root/'tools/git-history/check-authorship.py'
if published != PUBLISHED_BASE:
    raise SystemExit('The preserved public master changed; review the publication base before preparing another release.')
exists = subprocess.run(['git', '-C', str(root), 'show-ref', '--verify', '--quiet', 'refs/heads/source']).returncode == 0
parent = git('rev-parse', 'source').decode().strip() if exists else published
if subprocess.run(['git','-C',str(root),'merge-base','--is-ancestor',published,parent]).returncode:
    raise SystemExit('The proposed source parent is outside the preserved public history; review it before proceeding.')
# Validate every release above the immutable public base. A merge can make the
# base an ancestor while also bringing private history into the public branch.
for line in git('rev-list', '--parents', f'{published}..{parent}').decode().splitlines():
    commit_and_parents = line.split()
    if len(commit_and_parents) != 2:
        raise SystemExit('Source release history contains a merge or unexpected root; no source branch was changed.')
    previous_commit = commit_and_parents[0]
    previous_paths = git('ls-tree', '-rz', '--full-tree', previous_commit).split(b'\0')
    if any(private_path(item.split(b'\t', 1)[1].decode()) for item in previous_paths if item):
        raise SystemExit('A previous source release contains private files; review its history before proceeding.')
    previous_uploads = public_uploads(previous_commit)
    if any(item.split(b'\t', 1)[1].decode().startswith('source/images/uploads/')
           and item.split(b'\t', 1)[1].decode() not in previous_uploads for item in previous_paths if item):
        raise SystemExit('A previous source release contains unpublished uploads; review its history before proceeding.')
subprocess.run(['python3',str(checker),'history','--repo',str(root),'--revision',parent],check=True)

tree = {}
excluded = []
allowed_uploads = public_uploads(source)
for entry in git('ls-tree', '-rz', '--full-tree', source).split(b'\0'):
    if not entry:
        continue
    info, name = entry.split(b'\t', 1)
    text = name.decode()
    if private_path(text) or (text.startswith('source/images/uploads/') and text not in allowed_uploads):
        excluded.append(text)
        continue
    mode, kind, sha = info.split()
    parts = name.split(b'/')
    cursor = tree
    for part in parts[:-1]:
        cursor = cursor.setdefault(part, {})
    cursor[parts[-1]] = (mode, kind, sha)

def write_tree(directory):
    entries=[]
    for name, item in directory.items():
        if isinstance(item, dict):
            mode,kind,sha=b'040000',b'tree',write_tree(item)
        else:
            mode,kind,sha=item
        entries.append(mode+b' '+kind+b' '+sha+b'\t'+name+b'\0')
    return git('mktree','-z',data=b''.join(entries)).strip()

tree_hash=write_tree(tree).decode()
if exists and git('rev-parse','source^{tree}').decode().strip()==tree_hash:
    print('Source branch already matches the reviewed publication tree; no commit or remote action performed.')
    raise SystemExit(0)
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
receipt_dir=root/'.history/publication-candidates'/stamp
receipt_dir.mkdir(parents=True,exist_ok=False)
message=receipt_dir/'message.txt'
message.write_text('Rebuild Markdown source and reading experience\n' if not exists else 'Update articles and website source\n')
subprocess.run(['python3',str(checker),'message','--repo',str(root),'--message-file',str(message)],check=True)
commit=git('commit-tree',tree_hash,'-p',parent,data=message.read_bytes()).decode().strip()
subprocess.run(['python3',str(checker),'history','--repo',str(root),'--revision',commit],check=True)
# Compare-and-swap protects another working line's ref. No files or old refs are removed.
git('update-ref','refs/heads/source',commit,parent if exists else '0'*40)
receipt={'source_branch':'source','commit':commit,'tree':tree_hash,'parent':parent,'reviewed_feature':source,'preserved_public_master':published,'excluded_paths':sorted(excluded),'private_source_ancestry_included':False,'external_push_performed':False}
(receipt_dir/'receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(receipt,ensure_ascii=False,indent=2))
print('Local source branch prepared. Review it, then obtain publication authority before pushing.')
