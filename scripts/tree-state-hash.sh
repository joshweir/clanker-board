#!/bin/bash
# Deterministic SHA of the working tree's CONTENT (tracked + untracked, honoring
# .gitignore), independent of commit state. Two trees with identical file bytes
# produce the same hash — committing without editing files yields the same hash,
# so a post-check-all commit does not force a pre-push re-run. Any real edit
# (including to pnpm-lock.yaml, which the audit gate reads) changes it.
#
# This is the guarantee behind the pre-push bypass: a stamp written by a passing
# check-all matches at push time ONLY IF nothing that check-all inspected changed.
#
# node_modules is .gitignore'd so write-tree can't see it, yet the checks
# execute code from it — so pnpm's install receipts are folded into the hash
# below. Hand-edits inside node_modules remain invisible (verifying those would
# mean hashing gigabytes); CI's fresh frozen-lockfile install is the backstop.
set -euo pipefail

TMP_INDEX="$(mktemp -u "${TMPDIR:-/tmp}/check-all-index.XXXXXX")"
trap 'rm -f "$TMP_INDEX"' EXIT

# Seed the temp index from the real one so `git add` reuses its stat cache and
# only re-hashes files whose stat changed (fast). The real index is untouched.
cp "$(git rev-parse --git-dir)/index" "$TMP_INDEX" 2>/dev/null || true

# Stage every working-tree change (tracked edits/deletes + untracked adds,
# .gitignore respected) into the temp index, then emit the content-addressed
# tree SHA. `write-tree` is deterministic in file content alone.
GIT_INDEX_FILE="$TMP_INDEX" git add -A 2>/dev/null

# Install-state probe: instead of hashing node_modules itself (gigabytes),
# hash the receipts pnpm writes on every install — .pnpm/lock.yaml is the
# lockfile as last installed, .modules.yaml the layout config. An install from
# a different lockfile (e.g. a branch-hop `pnpm install`) changes the stamp,
# so a bypass can't vouch for checks that ran against a different dep tree.
# Missing receipts (fresh clone, no install) hash as the marker line instead.
{
    GIT_INDEX_FILE="$TMP_INDEX" git write-tree
    git hash-object node_modules/.pnpm/lock.yaml node_modules/.modules.yaml 2>/dev/null || echo "no-install-receipts"
} | git hash-object --stdin
