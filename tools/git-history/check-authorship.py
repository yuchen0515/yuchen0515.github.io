#!/usr/bin/env python3
"""Reject assistant identities and signature trailers; allow ordinary mentions."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

TOOL_NAMES = {
    "claude", "claude code", "claude code assistant", "codex", "openai codex",
    "chatgpt", "copilot", "github copilot", "cursor", "cursor ai", "gemini",
    "anthropic", "openai", "ai assistant", "ai agent",
}
TOOL_EMAILS = {
    "noreply@anthropic.com", "noreply@openai.com", "codex@openai.com",
    "chatgpt@openai.com",
}


def tool_identity(value: str) -> bool:
    value = value.strip()
    match = re.fullmatch(r"(.*?)\s*<([^>]+)>(?:\s+\d+\s+[+-]\d{4})?", value)
    name, email = (match.group(1), match.group(2)) if match else (value, "")
    name = " ".join(name.casefold().split()).removesuffix("[bot]").strip()
    return name in TOOL_NAMES or email.casefold() in TOOL_EMAILS


def signature_line(line: str) -> bool:
    line = line.strip()
    trailer = re.fullmatch(
        r"(?:Co-Authored-By|Signed-Off-By|Authored-By|Author|作者|共同作者)\s*[:：]\s*(.+)",
        line,
        flags=re.IGNORECASE,
    )
    if trailer:
        return tool_identity(trailer.group(1))
    generated = re.fullmatch(
        r"(?:🤖\s*)?(?:Generated|Created|Written|Authored)\s+(?:with|by|using)\s+(.+?)\.?",
        line,
        flags=re.IGNORECASE,
    )
    if not generated:
        return False
    identity = generated.group(1)
    link = re.fullmatch(r"\[([^\]]+)\]\(https?://[^\s)]+\)", identity)
    return tool_identity(link.group(1) if link else identity)


def clean_message(message: bytes) -> tuple[bytes, list[str]]:
    retained, removed = [], []
    for line in message.splitlines(keepends=True):
        decoded = line.rstrip(b"\r\n").decode("utf-8", errors="surrogateescape")
        if signature_line(decoded):
            removed.append(decoded)
        else:
            retained.append(line)
    return b"".join(retained), removed


def git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def commit_violations(raw: bytes) -> list[str]:
    header, message = raw.split(b"\n\n", 1)
    violations = []
    for line in header.splitlines():
        for field in (b"author ", b"committer "):
            if line.startswith(field) and tool_identity(line[len(field):].decode("utf-8", "replace")):
                violations.append(field.decode().strip() + " uses a tool identity")
    for number, line in enumerate(message.decode("utf-8", "replace").splitlines(), 1):
        if signature_line(line):
            violations.append(f"message line {number} contains tool attribution")
    return violations


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("message", "history"))
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--message-file", type=Path)
    parser.add_argument("--revision", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    failures = []
    checked = 0
    try:
        if args.mode == "message":
            if not args.message_file:
                parser.error("message requires --message-file")
            checked = 1
            for field in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
                identity = git(args.repo, "var", field).decode("utf-8", "replace").strip()
                if tool_identity(identity):
                    failures.append({"identity": field, "reason": "tool author/committer identity"})
            for line_number, line in enumerate(args.message_file.read_text().splitlines(), 1):
                if signature_line(line):
                    failures.append({"line": line_number, "reason": "tool attribution signature"})
        else:
            revisions = ["--all"] if args.all else (args.revision or ["HEAD"])
            commits = git(args.repo, "rev-list", *revisions).decode().splitlines()
            for commit in commits:
                checked += 1
                reasons = commit_violations(git(args.repo, "cat-file", "commit", commit))
                if reasons:
                    failures.append({"commit": commit, "reasons": reasons})
    except (subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f"Authorship check could not complete: {type(error).__name__}", file=sys.stderr)
        return 2
    report = {"checked": checked, "failures": failures, "passed": not failures}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    if failures:
        print("Authorship check rejected assistant identity or attribution.", file=sys.stderr)
        for failure in failures:
            print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    print(f"Authorship check passed ({checked} commit/message checks).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
