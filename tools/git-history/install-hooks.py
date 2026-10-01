#!/usr/bin/env python3
"""Install portable local hooks without replacing existing user hooks."""

import argparse
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("repo", type=Path)
parser.add_argument("--publication", action="store_true", help="Require the website publication policy before every push.")
args = parser.parse_args()
repo = args.repo.resolve()
git_dir = Path(subprocess.check_output(["git", "-C", str(repo), "rev-parse", "--absolute-git-dir"], text=True).strip())
custom = subprocess.run(["git", "-C", str(repo), "config", "--get", "core.hooksPath"], capture_output=True, text=True)
if custom.returncode == 0 and custom.stdout.strip():
    raise SystemExit("Existing core.hooksPath requires explicit integration; no hooks were overwritten.")
hooks = git_dir / "hooks"
hooks.mkdir(exist_ok=True)
prefix = '#!/bin/sh\nset -eu\nrepo=$(git rev-parse --show-toplevel)\nchecker="$repo/tools/git-history/check-authorship.py"\n'
content = {
    "commit-msg": prefix + 'exec python3 "$checker" message --repo "$repo" --message-file "$1"\n',
    "pre-push": prefix + 'while read -r local_ref local_sha remote_ref remote_sha; do\n  case "$local_sha" in\n    0000000000000000000000000000000000000000) continue ;;\n  esac\n  python3 "$checker" history --repo "$repo" --revision "$local_sha" || exit $?\ndone\n',
}
if args.publication:
    gate = repo / "tools/git-history/check-publication.py"
    policy = repo / "tools/publication_policy.py"
    if not gate.is_file() or not policy.is_file():
        raise SystemExit("Publication policy and checker are required; no hooks were installed.")
    old = '  python3 "$checker" history --repo "$repo" --revision "$local_sha" || exit $?\n'
    content["pre-push"] = content["pre-push"].replace(old, old + '  python3 "$repo/tools/git-history/check-publication.py" --repo "$repo" --revision "$local_sha" --remote-ref "$remote_ref" || exit $?\n')
if any((hooks / name).exists() for name in content):
    raise SystemExit("Existing commit-msg/pre-push hook requires explicit integration; no hooks were overwritten.")
for name, body in content.items():
    p = hooks / name
    p.write_text(body)
    p.chmod(0o755)
print("Installed local commit-msg and pre-push authorship checks; no remote operation performed.")
