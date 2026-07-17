#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Stamp cache ──────────────────────────────────────────────────────────────
# Content-addressed cache of passing runs: one file per green check-all, named
# by the tree+install hash (see tree-state-hash.sh), newest CHECK_ALL_STAMP_SLOTS
# kept (default 1000), evicted least-recently-used first by mtime (a cache hit
# re-touches its entry, so actively revisited trees survive). Hashed BEFORE any
# check runs; on success we re-hash and only record the run if the tree is
# unchanged — this closes the window where a file is edited mid-run. The cache
# lives in the COMMON git dir so all worktrees share it — safe because each
# worktree's own install receipts are part of the hash. Local only: CI
# containers are ephemeral. Best-effort so a non-git checkout still runs checks.
# Agent runners (Claude Code sets CLAUDECODE=1, Codex sets CODEX_CI=1) get a
# QUIET stamp cache: the multi-line hit/miss blocks below are pure transcript
# noise for them — they only need the pass/fail signal. The cache itself is
# untouched; only its logging is gated. Interactive human runs are unchanged.
QUIET_STAMP_LOG=0
if [ "${CLAUDECODE:-}" = "1" ] || [ "${CODEX_CI:-}" = "1" ]; then
    QUIET_STAMP_LOG=1
fi

STAMP_START_HASH=""
STAMP_DIR=""
STAMP_SLOTS="${CHECK_ALL_STAMP_SLOTS:-1000}"
if [ "${CI:-}" != "true" ]; then
    STAMP_START_HASH="$("$SCRIPT_DIR/tree-state-hash.sh" 2>/dev/null || true)"
    [ -n "$STAMP_START_HASH" ] && STAMP_DIR="$(git rev-parse --git-common-dir)/check-all-stamps"
fi

# A red run removes the current tree's cache entry. One can only exist here on
# a CHECK_ALL_FORCE=1 re-run that failed — i.e. the cached green is stale
# evidence (flaky test, or an input outside the hash changed). Failure wins.
evict_stamp() {
    [ -n "$STAMP_DIR" ] && rm -f "$STAMP_DIR/$STAMP_START_HASH" 2>/dev/null || true
}

# Self-skip: this exact tree+install already passed a full check-all (the
# filename is the proof; the entry's content is just metadata). Byte-identical
# inputs → identical result, so re-running is pure waste — the same guarantee
# pre-push rides on. Force a full run with CHECK_ALL_FORCE=1.
if [ -n "$STAMP_DIR" ] && [ "${CHECK_ALL_FORCE:-}" != "1" ] \
    && [ -f "$STAMP_DIR/$STAMP_START_HASH" ]; then
    ENTRY="$STAMP_DIR/$STAMP_START_HASH"
    # stat runs BEFORE the LRU touch — touch rewrites mtime to "now". macOS
    # (BSD stat) first, GNU stat fallback; %SB/%w = file birth time.
    if [ "$QUIET_STAMP_LOG" != "1" ]; then
        ENTRY_CREATED="$(stat -f '%SB' -t '%Y-%m-%d %H:%M:%S' "$ENTRY" 2>/dev/null || stat -c '%w' "$ENTRY" 2>/dev/null || echo '?')"
        ENTRY_USED="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$ENTRY" 2>/dev/null || stat -c '%y' "$ENTRY" 2>/dev/null || echo '?')"
        ENTRY_META="$(cat "$ENTRY" 2>/dev/null || echo '?')"
    fi
    touch "$ENTRY"
    echo "✅ check-all skipped — this exact working tree + install already passed (CHECK_ALL_FORCE=1 to re-run)."
    if [ "$QUIET_STAMP_LOG" != "1" ]; then
        echo "   stamp:        $STAMP_START_HASH"
        echo "   original run: $ENTRY_META (date, branch, duration of the passing check-all)"
        echo "   entry created $ENTRY_CREATED, last used $ENTRY_USED"
    fi
    exit 0
fi

# Create temporary files for output
TEMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# ── Job topology ─────────────────────────────────────────────────────────────
# Three parallel jobs. Each root script fans out across every workspace package
# via turbo (build/test) or a single repo-wide pass (lint), so a NEW package is
# covered organically the moment it declares the matching script — nothing here
# needs editing. Indexed (bash-3.2-safe) parallel arrays: JOB_NAMES for display,
# JOB_CMDS the root package.json script each job runs. Same index everywhere;
# out/time files are keyed by index ($TEMP_DIR/<i>.out / <i>.time).
JOB_NAMES=("lint" "build" "test")
JOB_CMDS=("lint" "build" "test")

echo "Running lint, build, and test in parallel..."
echo ""

# Dependency security audit gate — same shared script CI runs, so a dep-tree
# change fails here before it ever hits the pipeline. Local base is the main
# branch tip as a WORKING-TREE diff so an uncommitted lockfile edit is caught
# too; fail-closed if origin/main isn't fetched (audit is fast). CI runs the
# gate explicitly with the PR destination as base, so skip it here to avoid a
# redundant second pass.
if [ "${CI:-}" != "true" ]; then
    "$SCRIPT_DIR/audit-gate.sh" "${CHECK_ALL_AUDIT_BASE:-origin/main}"
fi

START_TIME=$(date +%s)

# Run one job, capturing output. Each job also records its own wall-clock
# duration so the summary can show per-job timings (jobs finish at different
# times; the total alone hides the critical path).
run_timed() { # <out-file> <time-file> <pnpm-script>
    local out="$1" timef="$2" cmd="$3"
    local job_start job_end rc=0
    job_start=$(date +%s)
    # `|| rc=$?` keeps set -e from exiting the subshell on failure BEFORE the
    # duration is recorded — the time-file must exist for red runs too.
    pnpm "$cmd" > "$out" 2>&1 || rc=$?
    job_end=$(date +%s)
    echo $((job_end - job_start)) > "$timef"
    return $rc
}

JOB_PIDS=()
i=0
while [ $i -lt ${#JOB_CMDS[@]} ]; do
    run_timed "$TEMP_DIR/$i.out" "$TEMP_DIR/$i.time" "${JOB_CMDS[$i]}" &
    JOB_PIDS+=($!)
    i=$((i+1))
done

# Index of the job a reaped pid belongs to (-1 if unknown).
job_index_by_pid() {
    local p="$1" j=0
    while [ $j -lt ${#JOB_PIDS[@]} ]; do
        if [ "${JOB_PIDS[$j]}" = "$p" ]; then echo $j; return; fi
        j=$((j+1))
    done
    echo -1
}

print_output_block() { # <name> <out-file>
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "$(echo "$1" | tr '[:lower:]' '[:upper:]') OUTPUT:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    cat "$2"
}

# Fail fast (CI only): when any job fails, kill the survivors and exit — a
# red run bills time-to-first-failure instead of slowest-job. CI-only BY
# DESIGN, not just by bash version: locally a dev wants ALL failures in one
# pass, and Linux dev machines (bash 5.x) would otherwise get fail-fast by
# accident. Needs `wait -n -p` (bash >= 5.1); macOS bash 3.2 falls back to
# the wait-all path. Opt out anywhere with CHECK_ALL_FAIL_FAST=0.
FAIL_FAST=0
if [ "${CI:-}" = "true" ] && [ "${CHECK_ALL_FAIL_FAST:-1}" = "1" ]; then
    if [ "${BASH_VERSINFO[0]}" -gt 5 ] || { [ "${BASH_VERSINFO[0]}" -eq 5 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
        FAIL_FAST=1
    else
        echo "note: fail-fast requested but DISABLED — bash ${BASH_VERSION} lacks 'wait -n -p' (needs >= 5.1); falling back to wait-all"
    fi
fi

# Wait for all jobs and track failures (indices into the job arrays).
EXIT_CODE=0
FAILED_INDICES=()

if [ "$FAIL_FAST" = "1" ]; then
    # Reap jobs one at a time in COMPLETION order. REMAINING holds exactly the
    # not-yet-reaped PIDs.
    REMAINING="${JOB_PIDS[*]}"
    while [ -n "${REMAINING// /}" ]; do
        RC=0
        REAPED=""
        wait -n -p REAPED $REMAINING || RC=$?
        NEXT=""
        for PID in $REMAINING; do
            [ "$PID" != "$REAPED" ] && NEXT="$NEXT $PID"
        done
        REMAINING="$NEXT"
        if [ "$RC" -ne 0 ]; then
            IDX=$(job_index_by_pid "$REAPED")
            NAME="${JOB_NAMES[$IDX]}"
            EXIT_CODE=$RC
            echo "✖ $NAME failed (exit $RC) after $(cat "$TEMP_DIR/$IDX.time" 2>/dev/null || echo '?')s — fail-fast: stopping remaining jobs"
            echo ""
            for PID in $REMAINING; do
                pkill -TERM -P "$PID" 2>/dev/null || true
                kill "$PID" 2>/dev/null || true
            done
            print_output_block "$NAME" "$TEMP_DIR/$IDX.out"
            evict_stamp
            exit "$EXIT_CODE"
        fi
    done
else
    i=0
    while [ $i -lt ${#JOB_PIDS[@]} ]; do
        wait "${JOB_PIDS[$i]}" || { EXIT_CODE=$?; FAILED_INDICES+=($i); }
        i=$((i+1))
    done
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

SUMMARY=""
i=0
while [ $i -lt ${#JOB_NAMES[@]} ]; do
    [ -n "$SUMMARY" ] && SUMMARY="$SUMMARY, "
    SUMMARY="$SUMMARY${JOB_NAMES[$i]} $(cat "$TEMP_DIR/$i.time" 2>/dev/null || echo '?')s"
    i=$((i+1))
done
echo "Completed in ${DURATION}s ($SUMMARY)"
echo ""

# In CI the buffered outputs are the only record of what ran — echo them even
# on success. Locally keep the terse summary; failures print below either way.
if [ "${CI:-}" = "true" ] && [ $EXIT_CODE -eq 0 ]; then
    i=0
    while [ $i -lt ${#JOB_NAMES[@]} ]; do
        print_output_block "${JOB_NAMES[$i]}" "$TEMP_DIR/$i.out"
        echo ""
        i=$((i+1))
    done
fi

# Display results
if [ $EXIT_CODE -ne 0 ]; then
    FAILED_NAMES=""
    for IDX in "${FAILED_INDICES[@]}"; do
        FAILED_NAMES="$FAILED_NAMES ${JOB_NAMES[$IDX]}"
    done
    echo "Failed:$FAILED_NAMES"
    echo ""

    for IDX in "${FAILED_INDICES[@]}"; do
        print_output_block "${JOB_NAMES[$IDX]}" "$TEMP_DIR/$IDX.out"
        echo ""
    done

    evict_stamp
    exit $EXIT_CODE
fi

# Record the passing run in the stamp cache: this exact tree+install passed.
# Only if the tree is byte-identical to what we hashed at the start (no mid-run
# edits) — otherwise the entry would vouch for content the checks never saw.
# pre-push re-hashes and skips on a cache hit. See tree-state-hash.sh.
if [ -n "$STAMP_DIR" ]; then
    STAMP_END_HASH="$("$SCRIPT_DIR/tree-state-hash.sh" 2>/dev/null || true)"
    if [ -n "$STAMP_END_HASH" ] && [ "$STAMP_END_HASH" = "$STAMP_START_HASH" ]; then
        mkdir -p "$STAMP_DIR"
        ENTRY_META="$(date '+%Y-%m-%d %H:%M:%S') $(git branch --show-current 2>/dev/null) ${DURATION}s"
        echo "$ENTRY_META" > "$STAMP_DIR/$STAMP_END_HASH"
        # Evict beyond the slot cap, least-recently-USED first (mtime order —
        # cache hits re-touch their entry, so revisited trees stay resident).
        EVICTEES="$(ls -1t "$STAMP_DIR" | tail -n +$((STAMP_SLOTS + 1)))"
        if [ -n "$EVICTEES" ]; then
            echo "$EVICTEES" | while read -r OLD; do rm -f "$STAMP_DIR/$OLD"; done
        fi
        if [ "$QUIET_STAMP_LOG" != "1" ]; then
            echo "📌 result cached — a future check-all (incl. pre-push) on this exact working tree + install will skip."
            echo "   stamp:   $STAMP_END_HASH"
            echo "   entry:   $ENTRY_META (date, branch, duration)"
            if [ -n "$EVICTEES" ]; then
                echo "   evicted: $(echo "$EVICTEES" | wc -l | tr -d ' ') least-recently-used entries (slot cap $STAMP_SLOTS)"
            fi
            echo "   cache:   $(ls -1 "$STAMP_DIR" | wc -l | tr -d ' ')/$STAMP_SLOTS slots used"
        fi
    elif [ -n "$STAMP_END_HASH" ]; then
        echo "⚠️  not stamped: the working tree changed while checks were running — the next check-all/push will run in full."
    fi
fi

echo "✅ All checks passed"
echo ""
i=0
while [ $i -lt ${#JOB_NAMES[@]} ]; do
    echo "${JOB_NAMES[$i]}: ✓"
    i=$((i+1))
done
