#!/usr/bin/env python3
"""Exercise real local Git hooks in a retained, isolated test repository."""

import argparse
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--fixture-parent", required=True, type=Path)
args = parser.parse_args()
fixture = args.fixture_parent.resolve() / ("hook-fixture-" + uuid.uuid4().hex[:10])
fixture.mkdir(parents=True)
tools = fixture / "tools/git-history"
tools.mkdir(parents=True)
for name in ["check-authorship.py", "install-hooks.py"]:
    shutil.copy2(Path(__file__).with_name(name), tools / name)


def run(*command, env=None, data=None):
    return subprocess.run(command, cwd=fixture, env=env, input=data, capture_output=True, text=True)


def git(*command, env=None):
    return run("git", "-c", "commit.gpgsign=false", *command, env=env)


for command in [("init", "--quiet"), ("config", "user.name", "Fixture Writer"), ("config", "user.email", "fixture@example.com")]:
    assert git(*command).returncode == 0
assert run("python3", str(tools / "install-hooks.py"), str(fixture)).returncode == 0
(fixture / "example.md").write_text("This article discusses Claude API rendering.\n")
assert git("add", "example.md").returncode == 0
cases = []

ordinary = git("commit", "--quiet", "-m", "Fix Claude API rendering")
assert ordinary.returncode == 0, ordinary.stderr
original_head = git("rev-parse", "HEAD").stdout.strip()
cases.append({"case": "ordinary Claude mention", "expected": "accepted", "passed": True})

for name, command, env in [
    ("tool coauthor trailer", ("commit", "--allow-empty", "-m", "Fixture\n\nCo-Authored-By: Claude <noreply@anthropic.com>"), None),
    ("tool --author identity", ("commit", "--allow-empty", "--author=Claude <noreply@anthropic.com>", "-m", "Fixture"), None),
    ("tool committer environment", ("commit", "--allow-empty", "-m", "Fixture"), {**os.environ, "GIT_COMMITTER_NAME": "Claude", "GIT_COMMITTER_EMAIL": "noreply@anthropic.com"}),
]:
    result = git(*command, env=env)
    assert result.returncode != 0 and "Authorship check rejected" in result.stderr, (name, result.stderr)
    assert git("rev-parse", "HEAD").stdout.strip() == original_head
    cases.append({"case": name, "expected": "rejected before commit", "passed": True})

human = git("commit", "--quiet", "--allow-empty", "-m", "Human collaboration\n\nCo-Authored-By: Fixture Collaborator <human@example.com>")
assert human.returncode == 0, human.stderr
cases.append({"case": "human coauthor", "expected": "accepted", "passed": True})
valid_head = git("rev-parse", "HEAD").stdout.strip()
push_hook = fixture / ".git/hooks/pre-push"
valid = run(str(push_hook), data=f"refs/heads/main {valid_head} refs/heads/main {'0'*40}\n")
assert valid.returncode == 0, valid.stderr
cases.append({"case": "pre-push clean history", "expected": "accepted without network", "passed": True})

tree = git("rev-parse", "HEAD^{tree}").stdout.strip()
raw = (f"tree {tree}\nparent {valid_head}\nauthor Claude <noreply@anthropic.com> 123456 +0800\n"
       "committer Fixture Writer <fixture@example.com> 123456 +0800\n\nAdversarial authorship fixture\n")
bad = run("git", "hash-object", "-t", "commit", "-w", "--stdin", data=raw)
assert bad.returncode == 0
bad_hash = bad.stdout.strip()
rejected = run(str(push_hook), data=f"refs/heads/invalid-fixture {bad_hash} refs/heads/invalid-fixture {'0'*40}\n")
assert rejected.returncode != 0 and "Authorship check rejected" in rejected.stderr
assert git("rev-parse", "HEAD").stdout.strip() == valid_head
cases.append({"case": "pre-push tool author in history", "expected": "rejected without network or ref mutation", "passed": True})

result = {"fixture": str(fixture), "passed": True, "cases": cases,
          "note": "Test repository is retained; no deletion, publication, or remote operation occurred."}
(args.fixture_parent / "hook-validation.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"passed": True, "case_count": len(cases), "fixture": str(fixture)}))
