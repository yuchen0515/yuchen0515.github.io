# Git publication checks

These tools check human author and committer identities, commit messages, and the files proposed for publication.

```sh
python3 tools/git-history/check-authorship.py history --repo . --all
python3 tools/git-history/check-publication.py --repo . --revision source
```

Publication checks apply to the reviewed branch and its history. A tracked file is not automatically approved for publication. Push only after the proposed public files and history pass the checks.

Local hooks run before commits and pushes; no check publishes or modifies a commit. The hook installer refuses to replace existing hooks without an explicit integration.
