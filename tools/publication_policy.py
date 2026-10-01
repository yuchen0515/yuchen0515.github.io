"""Explicit public source policy. Unlisted operational files stay local."""

from __future__ import annotations

import re

POLICY_VERSION = '2026-10-02.1'

# Keep this list reviewable. Adding a tool, test, config, or public document is
# a publication decision; being tracked by Git alone is not that decision.
PUBLIC_FILES = frozenset('''
.github/dependabot.yml
.github/workflows/pages.yml
.gitignore
.nvmrc
README.md
_config.yml
_config.preview.yml
package.json
package-lock.json
docs/ASSETS.md
docs/COMMENTS.md
docs/licenses/primer-MIT.txt
lib/markdown.cjs
lib/public-assets.cjs
scaffolds/draft.md
scaffolds/page.md
scaffolds/post.md
scripts/markdown.cjs
scripts/site.cjs
services/likes/.dev.vars.example
services/likes/.gitignore
services/likes/README.md
services/likes/migrations/0001_likes.sql
services/likes/package.json
services/likes/package-lock.json
services/likes/scripts/setup-local.mjs
services/likes/scripts/smoke.mjs
services/likes/scripts/sync-posts.mjs
services/likes/src/posts.mjs
services/likes/src/worker.mjs
services/likes/test/sync-posts.test.mjs
services/likes/test/worker.test.mjs
services/likes/wrangler.example.jsonc
services/likes/wrangler.local.jsonc
source/.nojekyll
source/robots.txt
tests/browser.mjs
tests/comments-browser.mjs
tests/comments-live.mjs
tests/comments.test.cjs
tests/editorial-isolation.test.cjs
tests/english.test.cjs
tests/markdown.test.cjs
tests/navigation-browser.mjs
tests/post.test.cjs
tests/public-assets.test.cjs
tests/writer-recovery.test.cjs
tests/fixtures/chinese-preservation.json
tests/fixtures/published-compatibility.json
tests/fixtures/author-originals/MIRlab-owen-lin-RD-page.md
tests/fixtures/author-originals/賽後心得-「看見你的聲音-語音辨識後修正」.md
tests/fixtures/author-originals/那些路過的-me-因們.md
tests/fixtures/author-originals/～關於我的文章規劃～.md
tests/fixtures/editorial-20261002/MIRlab-owen-lin-RD-page.md
tests/fixtures/editorial-20261002/README.md
tests/fixtures/editorial-20261002/about.md
tests/fixtures/editorial-20261002/links.md
tests/fixtures/editorial-20261002/賽後心得-「看見你的聲音-語音辨識後修正」.md
tests/fixtures/editorial-20261002/那些路過的-me-因們.md
tests/fixtures/editorial-20261002/～關於我的文章規劃～.md
themes/.gitkeep
themes/owen/_config.yml
themes/owen/source/favicon.svg
themes/owen/source/font/OFL.txt
tools/build.mjs
tools/check-site.mjs
tools/post.mjs
tools/prepare-source.py
tools/publication_policy.py
tools/preview.mjs
tools/report-test-status.py
tools/git-history/README.md
tools/git-history/check-authorship.py
tools/git-history/check-publication.py
tools/git-history/install-hooks.py
tools/git-history/rebuild-history.py
tools/git-history/test_authorship.py
tools/git-history/test_hooks.py
tools/git-history/test_release.py
tools/writer/.gitignore
tools/writer/README.md
tools/writer/app.js
tools/writer/browser-check.mjs
tools/writer/index.html
tools/writer/preview.css
tools/writer/recovery-browser.mjs
tools/writer/recovery.js
tools/writer/server.mjs
tools/writer/storage.mjs
tools/writer/test.mjs
tools/writer/writer.css
'''.strip().splitlines())

INTERNAL_DIRECTORIES = frozenset({
    '.git', '.history', 'audit', '.wrangler', 'node_modules', '.fixtures',
    '__pycache__', 'recovered-originals', 'public', '_drafts',
    'memory', 'memories', 'agent-notes', 'agent_notes', 'agentnotes',
    'llm-notes', 'llm_notes',
})
INTERNAL_NAMES = frozenset({
    'agents.md', 'agents.local.md', 'claude.md', 'claude.local.md',
    'memory.md', 'memory.json', 'memory.jsonl',
    'agent-notes.md', 'agent_notes.md', 'agentnotes.md',
    'llm-notes.md', 'llm_notes.md', '_llm_scratchpad.md', 'scratchpad.md',
    'planning_website_redesign.md', 'pending_user_review.md',
    'id_rsa', 'id_ed25519',
})
IMAGE_EXTENSION = re.compile(r'\.(?:png|jpe?g|webp|gif|svg|avif|ico)$', re.I)


def internal_path_reason(name: str) -> str | None:
    """Names that are private even inside otherwise approved public folders."""
    if not isinstance(name, str) or not name or '\\' in name or re.search(r'[\x00-\x1f\x7f]', name):
        return 'invalid publication path'
    parts = name.split('/')
    if any(part in {'', '.', '..'} for part in parts):
        return 'invalid publication path'
    lower = [part.casefold() for part in parts]
    if any(part.startswith(('.claude', '.codex', '.agents')) for part in lower):
        return 'internal agent configuration or memory'
    if any(part in INTERNAL_DIRECTORIES for part in lower):
        return 'private drafts, operational state, or evidence'
    if any(part in INTERNAL_NAMES for part in lower):
        return 'internal operating document or private key'
    leaf = lower[-1]
    if leaf.startswith('.env') and leaf != '.env.example':
        return 'private environment configuration'
    if leaf.startswith('.dev.vars') and leaf != '.dev.vars.example':
        return 'private service credentials'
    if leaf.startswith('wrangler.production'):
        return 'private production service configuration'
    return None


def classify_path(name: str, mode: str = '100644') -> str | None:
    """Return None for an approved file, otherwise a reason for excluding it."""
    reason = internal_path_reason(name)
    if reason:
        return reason
    if mode not in {'100644', '100755'}:
        return 'publication does not allow symlinks or Git submodules'
    if name in PUBLIC_FILES:
        return None
    parts = name.split('/')
    # Hidden paths need an exact allowlist entry, including .env examples.
    if any(part.startswith('.') for part in parts):
        return 'hidden path is outside the public allowlist'
    if name.startswith('source/'):
        if re.search(r'\.(?:md|markdown)$', name, re.I):
            return None
        if 'images' in parts[1:-1] and IMAGE_EXTENSION.search(name):
            return None
        return 'source file type is outside the public allowlist'
    if name.startswith('themes/owen/layout/') and name.endswith('.ejs'):
        return None
    if name.startswith('themes/owen/source/css/') and name.endswith('.css'):
        return None
    if name.startswith('themes/owen/source/js/') and name.endswith('.js'):
        return None
    if name.startswith('themes/owen/source/font/') and re.search(r'\.(?:woff2?|ttf|otf)$', name, re.I):
        return None
    return 'file is outside the reviewed public allowlist'


def public_document(name: str) -> bool:
    """Policy text in executable code/tests is valid; private doc exports are not."""
    return name == 'README.md' or name.endswith('/README.md') or name.startswith('docs/')


def document_disclosures(name: str, content: bytes) -> list[str]:
    """Return disclosure labels, never excerpts from private document content."""
    if not public_document(name):
        return []
    text = content.decode('utf-8', errors='replace')
    reasons = []
    if re.search(r'\b(?:AGENTS(?:\.local)?\.md|CLAUDE(?:\.local)?\.md|planning_website_redesign\.md|pending_user_review\.md)\b', text, re.I):
        reasons.append('public document refers to internal operating documents')
    if re.search(r'(?:shared memory navigation|共用記憶導航|\.claude/memory-shared|\.claude/projects/|\.codex/(?:memory|sessions))', text, re.I):
        reasons.append('public document contains internal memory navigation')
    if re.search(r'(?:^|[\s\"\'`(])(?:/Users/[^/\s]+/|/home/[^/\s]+/|[A-Za-z]:\\Users\\|~/(?:\.claude|\.codex)/)', text, re.M):
        reasons.append('public document contains a private home-directory path')
    return reasons
