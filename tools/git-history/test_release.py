#!/usr/bin/env python3
"""Exercise release history/privacy guards against preserved local Git fixtures."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = '248457d659c1524f841223856f8cf3ece4c2ca58'
ENV = dict(os.environ, GIT_AUTHOR_NAME='Fixture Reader', GIT_COMMITTER_NAME='Fixture Reader',
           GIT_AUTHOR_EMAIL='reader@example.com', GIT_COMMITTER_EMAIL='reader@example.com')

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT/'.history/release-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.repo = Path(tempfile.mkdtemp(prefix='release-', dir=parent))
        self.run_git('clone', '--shared', '--no-checkout', str(ROOT), str(self.repo), outside=True)
        self.run_git('branch', '-f', 'master', BASE)
        self.run_git('checkout', '-b', 'reviewed-fixture', BASE)
        (self.repo/'tools/git-history').mkdir(parents=True, exist_ok=True)
        for name in ('prepare-source.py', 'publication_policy.py', 'git-history/check-authorship.py'):
            shutil.copy2(ROOT/'tools'/name, self.repo/'tools'/name)
        (self.repo/'lib').mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/'lib/public-assets.cjs', self.repo/'lib/public-assets.cjs')
        (self.repo/'.gitignore').write_text('.history/\n')
        self.write('source/_drafts/private.md', 'private draft\n\n![Private image](/images/uploads/draft-only.png)\n')
        self.write('source/_posts/public.md', 'public article\n\n![Published image](/images/uploads/published.png)\n')
        self.write('source/images/uploads/published.png', 'published uploaded bytes\n')
        self.write('source/images/uploads/draft-only.png', 'draft-only uploaded bytes\n')
        self.hidden_posts = {
            'source/_posts/hidden-legacy.md': 'title: Hidden legacy\npublished: false\n---\n\nUnpublished legacy body.\n\n![Private](/images/uploads/legacy-private.png)\n',
            'source/_posts/hidden-wrapped.md': '---\ntitle: Hidden wrapped\npublished: false\n---\n\nUnpublished wrapped body.\n\n![Private](/images/uploads/wrapped-private.png)\n![Shared](/images/uploads/shared.png)\n',
        }
        for name, content in self.hidden_posts.items():
            self.write(name, content)
        self.write('source/about/index.md', '---\ntitle: About\n---\n\n![Shared](/images/uploads/shared.png)\n')
        self.write('source/images/uploads/legacy-private.png', 'legacy private uploaded bytes\n')
        self.write('source/images/uploads/wrapped-private.png', 'wrapped private uploaded bytes\n')
        self.write('source/images/uploads/shared.png', 'shared uploaded bytes\n')
        self.run_git('add', '--all')
        self.run_git('commit', '-m', 'Add reviewed fixture')
        self.reviewed = self.run_git('rev-parse', 'HEAD').strip()

    def run_git(self, *args, outside=False):
        command = ['git', *args] if outside else ['git', '-C', str(self.repo), *args]
        return subprocess.check_output(command, env=ENV, stderr=subprocess.PIPE).decode()

    def write(self, name, content):
        path = self.repo/name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def prepare(self, *options):
        return subprocess.run(['python3', str(self.repo/'tools/prepare-source.py'), *options],
                              cwd=self.repo, env=ENV, text=True, capture_output=True)

    def latest_receipt(self):
        receipts = sorted((self.repo/'.history/publication-candidates').glob('*/receipt.json'))
        self.assertTrue(receipts, 'A local review receipt must exist.')
        return json.loads(receipts[-1].read_text())

    def modified_tree(self, tree, additions):
        index_dir = Path(tempfile.mkdtemp(prefix='policy-history-index-', dir=self.repo/'.history'))
        index_env = dict(ENV, GIT_INDEX_FILE=str(index_dir/'index'))
        command = ['git', '-C', str(self.repo)]
        subprocess.check_output([*command, 'read-tree', tree], env=index_env, stderr=subprocess.PIPE)
        for name, content in additions.items():
            blob = subprocess.check_output([*command, 'hash-object', '-w', '--stdin'],
                                           input=content.encode(), env=ENV).decode().strip()
            subprocess.check_output([*command, 'update-index', '--add', '--cacheinfo',
                                     '100644', blob, name], env=index_env, stderr=subprocess.PIPE)
        return subprocess.check_output([*command, 'write-tree'], env=index_env, stderr=subprocess.PIPE).decode().strip()

    def candidate(self, tree, parents, message='Update article\n'):
        args = ['git', '-C', str(self.repo), 'commit-tree', tree]
        for parent in parents:
            args += ['-p', parent]
        sha = subprocess.check_output(args, input=message.encode(), env=ENV).decode().strip()
        self.run_git('update-ref', 'refs/heads/source', sha)
        return sha

    def test_excludes_private_files_without_publishing_private_ancestry(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(self.run_git('rev-parse', 'source^').strip(), BASE)
        files = self.run_git('ls-tree', '-r', '--name-only', 'source').splitlines()
        self.assertIn('source/_posts/public.md', files)
        self.assertNotIn('source/_drafts/private.md', files)
        self.assertIn('source/images/uploads/published.png', files)
        self.assertNotIn('source/images/uploads/draft-only.png', files)
        for name, content in self.hidden_posts.items():
            self.assertNotIn(name, files)
            self.assertEqual((self.repo/name).read_text(), content)
        self.assertNotIn('source/images/uploads/legacy-private.png', files)
        self.assertNotIn('source/images/uploads/wrapped-private.png', files)
        self.assertIn('source/about/index.md', files)
        self.assertIn('source/images/uploads/shared.png', files)
        self.assertEqual((self.repo/'source/images/uploads/legacy-private.png').read_text(), 'legacy private uploaded bytes\n')
        self.assertEqual((self.repo/'source/images/uploads/wrapped-private.png').read_text(), 'wrapped private uploaded bytes\n')
        self.assertEqual((self.repo/'source/images/uploads/shared.png').read_text(), 'shared uploaded bytes\n')
        self.assertEqual((self.repo/'source/images/uploads/published.png').read_text(), 'published uploaded bytes\n')
        self.assertEqual((self.repo/'source/images/uploads/draft-only.png').read_text(), 'draft-only uploaded bytes\n')
        self.assertIn('draft-only.png', (self.repo/'source/_drafts/private.md').read_text())
        receipt = json.loads(next((self.repo/'.history/publication-candidates').glob('*/receipt.json')).read_text())
        self.assertIn('source/images/uploads/draft-only.png', receipt['excluded_paths'])
        self.assertTrue(set(self.hidden_posts).issubset(receipt['excluded_paths']))
        self.assertIn('source/images/uploads/legacy-private.png', receipt['excluded_paths'])
        self.assertIn('source/images/uploads/wrapped-private.png', receipt['excluded_paths'])
        self.assertNotIn('source/images/uploads/shared.png', receipt['excluded_paths'])
        self.assertFalse(receipt['private_source_ancestry_included'])
        self.assertFalse(receipt['external_push_performed'])
        first = self.run_git('rev-parse', 'source').strip()
        self.assertEqual(self.prepare().returncode, 0)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), first)

    def test_rejects_merge_even_with_matching_latest_tree(self):
        self.assertEqual(self.prepare().returncode, 0)
        first = self.run_git('rev-parse', 'source').strip()
        tree = self.run_git('rev-parse', 'source^{tree}').strip()
        merged = self.candidate(tree, [first, self.reviewed])
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('merge', result.stdout+result.stderr)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), merged)

    def test_rejects_private_file_in_previous_release(self):
        private_tree = self.run_git('rev-parse', 'HEAD^{tree}').strip()
        old = self.candidate(private_tree, [BASE])
        clean_tree = self.run_git('rev-parse', 'master^{tree}').strip()
        current = self.candidate(clean_tree, [old])
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous source release', result.stdout+result.stderr)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), current)

    def test_rejects_unreferenced_upload_in_previous_release(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        clean_tree = self.run_git('rev-parse', 'source^{tree}').strip()
        index_dir = Path(tempfile.mkdtemp(prefix='upload-history-index-', dir=self.repo/'.history'))
        index_env = dict(ENV, GIT_INDEX_FILE=str(index_dir/'index'))
        command = ['git', '-C', str(self.repo)]
        subprocess.check_output([*command, 'read-tree', clean_tree], env=index_env, stderr=subprocess.PIPE)
        blob = subprocess.check_output([*command, 'hash-object', '-w', '--stdin'],
                                       input=b'previous private upload\n', env=ENV).decode().strip()
        subprocess.check_output([*command, 'update-index', '--add', '--cacheinfo',
                                 '100644', blob, 'source/images/uploads/unreferenced.png'],
                                env=index_env, stderr=subprocess.PIPE)
        private_tree = subprocess.check_output([*command, 'write-tree'], env=index_env,
                                               stderr=subprocess.PIPE).decode().strip()
        old = self.candidate(private_tree, [BASE])
        current = self.candidate(clean_tree, [old])
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('previous source release', result.stdout+result.stderr)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), current)
        self.assertEqual((self.repo/'source/images/uploads/draft-only.png').read_text(), 'draft-only uploaded bytes\n')

    def test_rejects_unpublished_article_in_previous_release_before_matching_tree_shortcut(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        clean_tree = self.run_git('rev-parse', 'source^{tree}').strip()
        for name, content in self.hidden_posts.items():
            with self.subTest(frontmatter=name):
                index_dir = Path(tempfile.mkdtemp(prefix='private-article-history-index-', dir=self.repo/'.history'))
                index_env = dict(ENV, GIT_INDEX_FILE=str(index_dir/'index'))
                command = ['git', '-C', str(self.repo)]
                subprocess.check_output([*command, 'read-tree', clean_tree], env=index_env, stderr=subprocess.PIPE)
                blob = subprocess.check_output([*command, 'hash-object', '-w', '--stdin'],
                                               input=content.encode(), env=ENV).decode().strip()
                subprocess.check_output([*command, 'update-index', '--add', '--cacheinfo', '100644', blob, name],
                                       env=index_env, stderr=subprocess.PIPE)
                private_tree = subprocess.check_output([*command, 'write-tree'], env=index_env, stderr=subprocess.PIPE).decode().strip()
                old = self.candidate(private_tree, [BASE])
                current = self.candidate(clean_tree, [old])
                result = self.prepare()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('previous source release contains unpublished article source', result.stdout+result.stderr)
                self.assertEqual(self.run_git('rev-parse', 'source').strip(), current)
                self.assertEqual((self.repo/name).read_text(), content)

    def test_includes_article_and_its_upload_after_explicit_publication(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        name = 'source/_posts/hidden-wrapped.md'
        published = self.hidden_posts[name].replace('published: false', 'published: true')
        self.write(name, published)
        self.run_git('add', name)
        self.run_git('commit', '-m', 'Publish reviewed fixture article')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        files = self.run_git('ls-tree', '-r', '--name-only', 'source').splitlines()
        self.assertIn(name, files)
        self.assertIn('source/images/uploads/wrapped-private.png', files)
        self.assertIn('source/images/uploads/shared.png', files)
        self.assertNotIn('source/_posts/hidden-legacy.md', files)
        self.assertNotIn('source/images/uploads/legacy-private.png', files)
        self.assertNotIn('source/_drafts/private.md', files)
        self.assertNotIn('source/images/uploads/draft-only.png', files)
        self.assertEqual(self.run_git('show', 'source:'+name), published)
        self.assertEqual((self.repo/name).read_text(), published)
        self.assertEqual((self.repo/'source/_posts/hidden-legacy.md').read_text(), self.hidden_posts['source/_posts/hidden-legacy.md'])

    def test_rejects_signature_before_matching_tree_shortcut(self):
        self.assertEqual(self.prepare().returncode, 0)
        tree = self.run_git('rev-parse', 'source^{tree}').strip()
        invalid = self.candidate(tree, [BASE], 'Update article\n\nCo-Authored-By: Claude <assistant@example.com>\n')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), invalid)

    def test_refuses_dirty_worktree_without_creating_source(self):
        self.write('source/_posts/public.md', 'unreviewed changes\n')
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Commit the reviewed work', result.stdout+result.stderr)
        refs = self.run_git('for-each-ref', '--format=%(refname)', 'refs/heads/source')
        self.assertEqual(refs.strip(), '')

    def test_internal_names_are_excluded_at_any_depth_and_unknown_files_stay_local(self):
        internal = {
            'AGENTS.md': 'internal operating instructions\n',
            'CLAUDE.md': 'internal operating instructions\n',
            'CLAUDE.local.md': 'private local configuration\n',
            'planning_website_redesign.md': 'private planning\n',
            'pending_user_review.md': 'private review notes\n',
            'source/about/AGENTS.md': 'private embedded instructions\n\n![Private operational image](/images/uploads/agent-private.png)\n',
            'themes/owen/source/js/.claude/settings.json': '{"private":true}\n',
            'tools/writer/.codex/memory.md': 'private memory\n',
            'lib/.agents/instructions.md': 'private instructions\n',
            'tests/fixtures/editorial-20261002/agent-notes.md': 'private operational notes\n',
            'source/images/memory/private.png': 'private operational bytes\n',
            'services/likes/wrangler.production.jsonc': '{"private":true}\n',
            'services/likes/.dev.vars': 'PRIVATE_TEST_VALUE=kept_local\n',
            'source/about/.env.local': 'PRIVATE_TEST_VALUE=kept_local\n',
        }
        unknown = {
            'meeting-record.md': 'unreviewed operational document\n',
            'tools/unknown-helper.py': 'unreviewed helper\n',
            'docs/internal-project-overview.md': 'unreviewed project notes\n',
            'source/about/private-database.sqlite': 'not an approved public asset\n',
            'tests/fixtures/editorial-20261002/unreviewed-note.md': 'not an approved historical snapshot\n',
        }
        for name, content in {**internal, **unknown}.items():
            self.write(name, content)
        self.write('source/images/uploads/agent-private.png', 'private operational image bytes\n')
        self.run_git('add', '--all')
        self.run_git('commit', '-m', 'Add local operational fixture')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        files = set(self.run_git('ls-tree', '-r', '--name-only', 'source').splitlines())
        receipt = self.latest_receipt()
        reasons = {item['path']: item['reason'] for item in receipt['excluded_files']}
        for name, content in {**internal, **unknown}.items():
            with self.subTest(path=name):
                self.assertNotIn(name, files)
                self.assertIn(name, reasons)
                self.assertTrue(reasons[name])
                self.assertEqual((self.repo/name).read_text(), content)
        self.assertEqual(self.run_git('rev-parse', 'source^').strip(), BASE)
        self.assertNotIn('source/images/uploads/agent-private.png', files)
        self.assertEqual(reasons['source/images/uploads/agent-private.png'], 'unpublished upload')
        self.assertEqual((self.repo/'source/images/uploads/agent-private.png').read_text(), 'private operational image bytes\n')
        self.assertTrue(receipt['parent_history_approved'])
        self.assertEqual(receipt['history_violations'], [])

    def test_public_build_writer_and_worker_dependencies_are_retained_byte_exactly(self):
        public = {
            'README.md': '# Public writing guide\n\nWrite Markdown and save explicitly.\n',
            'package.json': '{"scripts":{"build":"node tools/build.mjs"}}\n',
            'package-lock.json': '{"lockfileVersion":3}\n',
            '_config.yml': 'url: https://example.com\n',
            '.github/workflows/pages.yml': 'name: Public build\n',
            'tools/build.mjs': '// public build tool\n',
            'tools/writer/app.js': '// public writer\n',
            'scripts/site.cjs': '// public Hexo integration\n',
            'lib/markdown.cjs': '// public rendering module\n',
            'themes/owen/layout/page.ejs': '<main>Public page</main>\n',
            'themes/owen/source/css/site.css': 'body { font-size: 19px; }\n',
            'themes/owen/source/js/site.js': '// public interaction\n',
            'services/likes/src/worker.mjs': '// public Worker\n',
            'services/likes/src/posts.mjs': 'export const posts = [];\n',
            'services/likes/migrations/0001_likes.sql': 'CREATE TABLE public_fixture (id TEXT);\n',
            'services/likes/package.json': '{"private":true}\n',
            'services/likes/package-lock.json': '{"lockfileVersion":3}\n',
            'services/likes/wrangler.example.jsonc': '{"name":"example"}\n',
            'services/likes/.dev.vars.example': 'LOCAL_TEST_VALUE=example_only\n',
            'tools/writer/README.md': 'Each save preserves a preimage in `.history/writer/`.\n',
            'source/_posts/article-about-language-models.md': 'An authored article can discuss Claude, Codex, and memory.\n',
            'tests/fixtures/editorial-20261002/about.md': 'Public historical author content.\n',
        }
        for name, content in public.items():
            self.write(name, content)
        self.run_git('add', '--all')
        self.run_git('commit', '-m', 'Add public build fixture')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        receipt = self.latest_receipt()
        manifest = {item['path']: item for item in receipt['included_files']}
        for name, content in public.items():
            with self.subTest(path=name):
                self.assertEqual(self.run_git('show', 'source:'+name), content)
                self.assertEqual(manifest[name]['mode'], '100644')
                self.assertEqual(manifest[name]['blob'], self.run_git('rev-parse', 'source:'+name).strip())

    def test_rejects_removed_internal_files_anywhere_in_prior_public_history(self):
        self.assertEqual(self.prepare().returncode, 0)
        clean_tree = self.run_git('rev-parse', 'source^{tree}').strip()
        cases = [
            'AGENTS.md', 'CLAUDE.md', 'pending_user_review.md',
            'source/about/CLAUDE.local.md', 'themes/owen/source/.codex/notes.md',
            'unreviewed-operations.md',
        ]
        for name in cases:
            with self.subTest(path=name):
                private_tree = self.modified_tree(clean_tree, {name: 'private fixture content\n'})
                old = self.candidate(private_tree, [BASE])
                current = self.candidate(clean_tree, [old])
                result = self.prepare()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('previous source release', result.stdout+result.stderr)
                self.assertEqual(self.run_git('rev-parse', 'source').strip(), current)
                receipt = self.latest_receipt()
                self.assertFalse(receipt['parent_history_approved'])
                self.assertFalse(receipt['source_ref_changed'])
                self.assertIn(name, {item.get('path') for item in receipt['history_violations']})

    def test_internal_text_embedded_in_public_readme_blocks_candidate(self):
        cases = [
            'Read AGENTS.md and CLAUDE.md before work.\n',
            'Read planning_website_redesign.md and pending_user_review.md.\n',
            'Shared memory navigation remains at a private location.\n',
            'Private source lives at /Users/private-fixture/project.\n',
        ]
        for content in cases:
            with self.subTest(disclosure=content):
                self.write('README.md', content)
                self.run_git('add', 'README.md')
                self.run_git('commit', '-m', 'Add documentation disclosure fixture')
                result = self.prepare()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('public document contains internal', result.stdout+result.stderr)
                self.assertEqual(self.run_git('for-each-ref', '--format=%(refname)', 'refs/heads/source').strip(), '')
                receipt = self.latest_receipt()
                self.assertEqual(receipt['candidate_violations'][0]['path'], 'README.md')
                self.assertFalse(receipt['source_ref_changed'])
                self.assertEqual((self.repo/'README.md').read_text(), content)

    def test_removed_readme_disclosures_in_old_releases_block_matching_tree(self):
        self.assertEqual(self.prepare().returncode, 0)
        clean_tree = self.run_git('rev-parse', 'source^{tree}').strip()
        private_tree = self.modified_tree(clean_tree, {'README.md': 'Read CLAUDE.md and private shared memory navigation.\n'})
        old = self.candidate(private_tree, [BASE])
        current = self.candidate(clean_tree, [old])
        result = self.prepare()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_git('rev-parse', 'source').strip(), current)
        receipt = self.latest_receipt()
        self.assertTrue(any(item.get('path') == 'README.md' and 'internal' in item['reason']
                            for item in receipt['history_violations']))
        self.assertFalse(receipt['source_ref_changed'])

    def test_review_only_lists_exact_tree_and_exclusions_without_commit_or_ref_change(self):
        before = self.run_git('rev-list', '--all').splitlines()
        result = self.prepare('--review-only')
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertEqual(self.run_git('rev-list', '--all').splitlines(), before)
        self.assertEqual(self.run_git('for-each-ref', '--format=%(refname)', 'refs/heads/source').strip(), '')
        receipt = self.latest_receipt()
        self.assertTrue(receipt['review_only'])
        self.assertFalse(receipt['source_ref_changed'])
        self.assertFalse(receipt['external_push_performed'])
        self.assertNotIn('commit', receipt)
        self.assertTrue(receipt['included_files'])
        self.assertIn('source/_drafts/private.md', receipt['excluded_paths'])
        paths = self.run_git('ls-tree', '-r', '--name-only', receipt['tree']).splitlines()
        self.assertEqual(sorted(item['path'] for item in receipt['included_files']), sorted(paths))

    def test_symlink_cannot_smuggle_private_content_through_public_source(self):
        path = self.repo/'source/about/leaked.md'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to('../_drafts/private.md')
        self.run_git('add', 'source/about/leaked.md')
        self.run_git('commit', '-m', 'Add symlink fixture')
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
        self.assertNotIn('source/about/leaked.md', self.run_git('ls-tree', '-r', '--name-only', 'source').splitlines())
        receipt = self.latest_receipt()
        self.assertTrue(any(item['path'] == 'source/about/leaked.md' and 'symlinks' in item['reason']
                            for item in receipt['excluded_files']))
        self.assertTrue(path.is_symlink())

if __name__ == '__main__':
    unittest.main()
