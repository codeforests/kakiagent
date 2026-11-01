#!/usr/bin/env bash
# Runs checks with their full output going to log files, and prints only one result line
# per check plus the lines that explain a failure. Saves an agent session reading
# thousands of lines of passing test output.
#
#   scripts/check-summary.sh                      format:check, lint, typecheck, test
#   scripts/check-summary.sh 'pnpm --filter @kaki/inbox test' 'pnpm --filter @kaki/inbox typecheck'
#   scripts/test-env.sh scripts/check-summary.sh 'pnpm --filter @kaki/inbox test:coverage'
#
#   CHECK_LOG_DIR=dir   where the logs go (default: a new directory under ${TMPDIR:-/tmp})
#   CHECK_LINES=n       at most this many explaining lines per failed check (default 40)
#
# Every check runs even if an earlier one fails. Exit status is 1 if any check failed.
# Read a full log with `grep -n` or `sed -n` on the path it prints, not whole.
set -uo pipefail

if [ $# -eq 0 ]; then
  set -- 'pnpm format:check' 'pnpm lint' 'pnpm typecheck' 'pnpm test'
fi

LOG_DIR="${CHECK_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/checks.XXXXXX")}"
mkdir -p "$LOG_DIR"
MAX_LINES="${CHECK_LINES:-40}"

# Lines worth showing from a failed check: test failures, assertion diffs, compiler,
# lint and format errors, coverage thresholds, and the package manager's failure line.
FAIL_PATTERN='(^ *[-+] [^ ]|❯ .*:[0-9]+:[0-9]+|FAIL |\[error\] |✗|×|AssertionError|Expected|Received|error TS[0-9]+|  error  |✖|\[warn\] |ERROR|Error:|ELIFECYCLE|ERR_PNPM|failed|not met|Tests +[0-9]+ failed)'
# The test totals of a passing check, so the result line says how much ran.
TOTAL_PATTERN='(^|: ) *(Tests|Test Files) +[0-9]+ passed'

failed=0
n=0
for cmd in "$@"; do
  n=$((n + 1))
  # File-name-safe slug: `@kaki/inbox` would otherwise put a slash in the log path.
  slug=$(printf '%s' "$cmd" | tr -c 'A-Za-z0-9._-' '-' | tr -s '-' | cut -c1-60)
  log="$LOG_DIR/$(printf '%02d' "$n")-${slug%-}.log"
  start=$SECONDS
  bash -c "$cmd" >"$log" 2>&1
  rc=$?
  secs=$((SECONDS - start))
  if [ "$rc" -eq 0 ]; then
    totals=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -aE "$TOTAL_PATTERN" | sed -E 's/^.*: +//; s/^ +//; s/ +\(.*//' |
      awk '{k=$1 == "Tests" ? "Tests" : "Test Files"; sum[k]+=$(NF-1)} END {if ("Test Files" in sum) printf "Test Files %d passed; Tests %d passed", sum["Test Files"], sum["Tests"]}')
    printf 'PASS  %s (%ss)%s\n' "$cmd" "$secs" "${totals:+  [$totals]}"
  else
    failed=1
    printf 'FAIL  %s (%ss, exit %s)  log: %s\n' "$cmd" "$secs" "$rc" "$log"
    # Strip colour codes, keep the explaining lines once each, in order.
    sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -aE "$FAIL_PATTERN" | awk '!seen[$0]++' | head -n "$MAX_LINES" | sed 's/^/      /'
    shown=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -acE "$FAIL_PATTERN")
    if [ "$shown" -eq 0 ]; then
      # Nothing matched: show the end of the log instead.
      tail -n 15 "$log" | sed 's/^/      /'
    fi
  fi
done

[ "$failed" -eq 0 ] && echo "All ${n} checks passed. Logs: $LOG_DIR" || echo "Logs: $LOG_DIR"
exit "$failed"
