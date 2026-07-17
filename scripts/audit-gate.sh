#!/bin/bash
# Dependency security audit gate. Runs `pnpm run audit-ci`
# (`pnpm audit --audit-level=high`) only when the dependency tree
# (pnpm-lock.yaml) or the triage allow-list (pnpm-workspace.yaml) changed vs a
# base ref. Advisories are published against the lockfile, not the diff, so
# scoping to dep-touching changes keeps unrelated work from inheriting triage;
# advisories against untouched deps are caught by a scheduled/nightly audit.
#
# Fails closed: if the diff itself errors (e.g. the base ref is missing on a
# shallow clone or a repo with no remote yet), the audit runs.
#
# Usage: audit-gate.sh <diff-spec>
#   CI (PR):  ./scripts/audit-gate.sh "origin/${TARGET_BRANCH:-main}...HEAD"
#   local:    ./scripts/audit-gate.sh "origin/main"
set -euo pipefail

SPEC="${1:-}"
AUDIT_PATHS=(pnpm-lock.yaml pnpm-workspace.yaml)

run_audit() {
  echo "Running dependency security audit gate (pnpm run audit-ci)..."
  pnpm run audit-ci
}

if [ -z "$SPEC" ]; then
  echo "No diff base supplied - running audit gate (fail closed)."
  run_audit
  exit 0
fi

if CHANGED=$(git diff --name-only "$SPEC" -- "${AUDIT_PATHS[@]}" 2>/dev/null); then
  if [ -z "$CHANGED" ]; then
    echo "No dependency-tree or audit-config changes vs $SPEC - skipping audit gate."
  else
    echo "Dependency tree or audit config changed vs $SPEC - running security audit gate."
    run_audit
  fi
else
  echo "Could not diff against $SPEC - running audit gate (fail closed)."
  run_audit
fi
