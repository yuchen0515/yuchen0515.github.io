#!/usr/bin/env python3
"""Build a separate Git directory with signature-only commit reconstruction."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import shutil
import subprocess
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("authorship", Path(__file__).with_name("check-authorship.py"))
AUTH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUTH)


def git(repo: Path, *args: str, data: bytes | None = None) -> bytes:
    result = subprocess.run(["git", "--git-dir=" + str(repo), *args], input=data, capture_output=True)
    if result.returncode:
        # Do not print arbitrary config or commit contents on failure.
        raise RuntimeError(f"Git {' '.join(args[:2])} failed with exit {result.returncode}")
    return result.stdout


def manifest(directory: Path) -> dict[str, str]:
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(directory.rglob("*")) if p.is_file()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-git", required=True, type=Path)
    parser.add_argument("--destination-git", required=True, type=Path)
    parser.add_argument("--audit-dir", required=True, type=Path)
    args = parser.parse_args()
    source, destination, audit = args.source_git.resolve(), args.destination_git.resolve(), args.audit_dir.resolve()
    if destination.exists() or source == destination or source in destination.parents or destination in source.parents:
        raise SystemExit("Destination must be new and separate from the immutable source Git directory.")
    audit.mkdir(parents=True, exist_ok=True)
    original_manifest = manifest(source)
    objects = git(source, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").decode().splitlines()
    hashes = sorted(line.split()[0] for line in objects if line.endswith(" commit"))
    commits = {h: git(source, "cat-file", "commit", h) for h in hashes}
    refs = dict(line.split(" ", 1)[::-1] for line in git(source, "show-ref").decode().splitlines())
    reachable = set(git(source, "rev-list", "--all").decode().splitlines())
    dangling = sorted(set(hashes) - reachable)
    bundle = audit / "original-history.bundle"
    if bundle.exists():
        raise SystemExit("Original evidence bundle already exists; do not overwrite it.")
    git(source, "bundle", "create", str(bundle), "--all", *dangling)

    subprocess.run(["git", "-c", "init.templateDir=", "init", "--bare", "--quiet", str(destination)], check=True)
    shutil.copytree(source / "objects", destination / "objects", dirs_exist_ok=True)
    mapping, records, processing = {}, {}, set()

    def rebuild(old: str) -> str:
        if old in mapping:
            return mapping[old]
        if old in processing or old not in commits:
            raise RuntimeError("Invalid or incomplete commit graph.")
        processing.add(old)
        raw = commits[old]
        header, message = raw.split(b"\n\n", 1)
        fields = header.split(b"\n")
        parents = [line[7:].decode() for line in fields if line.startswith(b"parent ")]
        mapped_parents = [rebuild(parent) for parent in parents]
        clean, removed = AUTH.clean_message(message)
        rebuilt_header = b"\n".join(b"parent " + mapping[line[7:].decode()].encode() if line.startswith(b"parent ") else line for line in fields)
        new_raw = rebuilt_header + b"\n\n" + clean
        if new_raw != raw and any(line.startswith(b"gpgsig ") for line in fields):
            raise RuntimeError("A signed commit would change; require a separate explicit decision.")
        new = git(destination, "hash-object", "-t", "commit", "-w", "--stdin", data=new_raw).decode().strip()
        if AUTH.commit_violations(new_raw):
            raise RuntimeError("A rebuilt commit still contains assistant attribution or identity.")
        mapping[old] = new
        records[old] = {
            "old": old, "new": new, "changed": old != new,
            "tree": next(line[5:].decode() for line in fields if line.startswith(b"tree ")),
            "old_parents": parents, "new_parents": mapped_parents,
            "removed_signature_lines": removed,
            "identity_and_dates_equal": True, "non_signature_message_bytes_equal": True,
            "signed_commit_unchanged": old == new if b"\ngpgsig " in b"\n" + header else None,
        }
        processing.remove(old)
        return new

    for old in hashes:
        rebuild(old)
    mapped_refs = {ref: mapping[old] for ref, old in refs.items()}
    # Only transformed refs enter this repository; never add original audit refs.
    git(destination, "update-ref", "--stdin", data="".join(f"create {ref} {new}\n" for ref, new in mapped_refs.items()).encode())
    symbolic_head = git(source, "symbolic-ref", "HEAD").decode().strip()
    git(destination, "symbolic-ref", "HEAD", symbolic_head)

    clean_reachable = git(destination, "rev-list", "--all").decode().splitlines()
    for new in clean_reachable:
        if AUTH.commit_violations(git(destination, "cat-file", "commit", new)):
            raise RuntimeError("Clean refs reach a prohibited attribution.")
    for old, new in mapping.items():
        old_header, old_message = commits[old].split(b"\n\n", 1)
        new_header, new_message = git(destination, "cat-file", "commit", new).split(b"\n\n", 1)
        old_fields = [line for line in old_header.splitlines() if not line.startswith(b"parent ")]
        new_fields = [line for line in new_header.splitlines() if not line.startswith(b"parent ")]
        if old_fields != new_fields or AUTH.clean_message(old_message)[0] != new_message:
            raise RuntimeError("Identity/tree/header or retained-message invariant failed.")
    if manifest(source) != original_manifest:
        raise RuntimeError("Immutable source Git directory changed.")
    git(destination, "fsck", "--connectivity-only")
    report = {
        "source_git": str(source), "clean_git": str(destination), "original_bundle": str(bundle),
        "stored_original_commit_count": len(hashes), "original_reachable_count": len(reachable),
        "rebuilt_reachable_count": len(clean_reachable),
        "signature_commit_count": sum(bool(r["removed_signature_lines"]) for r in records.values()),
        "changed_commit_count": sum(r["changed"] for r in records.values()),
        "original_refs": refs, "clean_refs": mapped_refs,
        "original_unreachable_commits": dangling,
        "rebuilt_unreachable_commits": [mapping[h] for h in dangling],
        "all_invariants_passed": True, "original_snapshot_unchanged": True,
        "mapping": records,
    }
    (audit / "history-reconstruction.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    (audit / "original-git-sha256-manifest.json").write_text(json.dumps(original_manifest, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ["stored_original_commit_count", "signature_commit_count", "changed_commit_count", "rebuilt_reachable_count", "all_invariants_passed", "original_snapshot_unchanged"]}))


if __name__ == "__main__":
    main()
