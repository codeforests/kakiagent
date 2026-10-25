#!/usr/bin/env bash
# Runs the jobs of .github/workflows/ci.yml locally (WSL Ubuntu + Docker Desktop) against
# the latest commit of a branch, in a clone kept apart from your dev checkout. Assumes
# the one-time tools are installed (Node via nvm, Docker, Tesseract, poppler, Terraform
# 1.16.6, tflint v0.64.0, Trivy) and the clone exists.
#
#   ci-local.sh full  [branch]   Like a fresh CI runner: clean tree, frozen install,
#                                every job, a fresh E2E stack torn down at the end.
#                                Run it first, and last before you report to verify.
#   ci-local.sh quick [branch]   Re-run after a fix: pull, keep Turbo's cache, build
#                                outputs and the E2E stack, install only if the lockfile
#                                changed, and run `static` and `unit` (cheap: Turbo skips
#                                unchanged packages) plus whatever failed last time. A
#                                failed browser re-runs only its failed specs.
#   branch defaults to main.
#   CI_JOBS="integration e2e"    run exactly these jobs instead (all specs for e2e).
#                                Jobs: static unit build eval integration security
#                                terraform actionlint e2e
#   CI_DIR=~/code/kakiagent-ci   where the clone lives (default shown)
#
# Every selected job runs even if an earlier one fails. Results are kept per job in
# ~/code/ci-logs/state with the commit each was last run at; the summary flags any job
# whose result is from an older commit than the one under test. Keep this script
# outside the clone: `full` wipes untracked files there.
set -uo pipefail

MODE="${1:-}"
case "$MODE" in
  full | quick) ;;
  *)
    echo "usage: ci-local.sh full|quick [branch]"
    exit 2
    ;;
esac
BRANCH="${2:-main}"
CI_DIR="${CI_DIR:-$HOME/code/kakiagent-ci}"
LOG_DIR="$HOME/code/ci-logs"
TOOLS_DIR="$HOME/.cache/ci-local"
STATE="$LOG_DIR/state"
BROWSERS="chromium firefox webkit"
# In order; e2e expands to its stack, its dev servers and one job per browser.
ALL_JOBS="static unit build eval integration security terraform actionlint e2e-stack e2e-dev e2e-chromium e2e-firefox e2e-webkit"

# GitHub Actions sets CI=true. Playwright then refuses to reuse a dev server that is
# already running (so E2E can't silently test your other checkout).
export CI=true TURBO_TELEMETRY_DISABLED=1
# Separate Compose project: `full` ends with `down -v`, which must never touch the
# volumes of your normal `kakiagent` dev stack.
export COMPOSE_PROJECT_NAME=kakiagent-ci

# --- Previous results ---------------------------------------------------------------
declare -A STATUS=() AT=() RAN=()
PREV_BRANCH=""
if [ -f "$STATE" ]; then
  while read -r job status sha; do
    if [ "$job" = branch ]; then PREV_BRANCH="$status"; else STATUS[$job]="$status" AT[$job]="$sha"; fi
  done <"$STATE"
fi
# Results for another branch say nothing about this one.
[ "$PREV_BRANCH" = "$BRANCH" ] || { STATUS=(); AT=(); }

# --- Which jobs run -----------------------------------------------------------------
# E2E_SPECS[browser]: "all" or "last-failed".
declare -A SELECTED=() E2E_SPECS=()
select_job() {
  if [ "$1" = e2e ]; then
    SELECTED[e2e-stack]=1 SELECTED[e2e-dev]=1
    for b in $BROWSERS; do SELECTED[e2e-$b]=1 E2E_SPECS[$b]=all; done
  else
    SELECTED[$1]=1
  fi
}

if [ -n "${CI_JOBS:-}" ]; then
  for j in $CI_JOBS; do select_job "$j"; done
elif [ "$MODE" = full ]; then
  for j in static unit build eval integration security terraform actionlint e2e; do select_job "$j"; done
else
  if [ -z "$PREV_BRANCH" ] || [ "$PREV_BRANCH" != "$BRANCH" ]; then
    echo "No earlier run of $BRANCH to re-run from (last: ${PREV_BRANCH:-none}). Run: ci-local.sh full $BRANCH"
    exit 2
  fi
  select_job static
  select_job unit
  for j in build eval integration security terraform actionlint; do
    [ "${STATUS[$j]:-}" = PASS ] || select_job "$j"
  done
  # A browser that failed re-runs its failed specs; if the stack or dev servers failed,
  # or a browser never got to run, it runs all of its specs.
  e2e_base_ok=1
  [ "${STATUS[e2e-stack]:-}" = PASS ] && [ "${STATUS[e2e-dev]:-}" = PASS ] || e2e_base_ok=0
  for b in $BROWSERS; do
    [ "${STATUS[e2e-$b]:-}" = PASS ] && [ $e2e_base_ok = 1 ] && continue
    SELECTED[e2e-stack]=1 SELECTED[e2e-dev]=1 SELECTED[e2e-$b]=1
    if [ $e2e_base_ok = 1 ] && [ "${STATUS[e2e-$b]:-}" = FAIL ]; then E2E_SPECS[$b]=last-failed; else E2E_SPECS[$b]=all; fi
  done
fi

FAILED=0
record() { # record <job> PASS|FAIL <seconds>
  STATUS[$1]="$2" AT[$1]="$SHA" RAN[$1]=1
  [ "$2" = PASS ] || FAILED=1
  echo "--- $1: $2 ($3s)"
}

# run <job> <command...>: runs one selected job in a subshell with set -e, logs it.
run() {
  local job="$1"
  shift
  [ -n "${SELECTED[$job]:-}" ] || return 0
  echo
  echo "=================== $job ==================="
  local start=$SECONDS
  # Not inside an `if`: bash would then ignore set -e in the job, and only its last
  # command would count.
  ( set -eo pipefail; "$@" ) 2>&1 | tee "$LOG_DIR/$job.log"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then record "$job" PASS $((SECONDS - start)); else record "$job" FAIL $((SECONDS - start)); fi
}

# --- 1. Latest code -----------------------------------------------------------------
[ -d "$CI_DIR/.git" ] || { echo "No clone at $CI_DIR (set CI_DIR, or do step 1 of the setup once)"; exit 1; }
cd "$CI_DIR" || exit 1
mkdir -p "$LOG_DIR" "$TOOLS_DIR"

# shellcheck disable=SC1091
source "$HOME/.nvm/nvm.sh" && nvm use >/dev/null || { echo "nvm use failed"; exit 1; }
corepack enable

OLD_LOCK=$(sha256sum pnpm-lock.yaml 2>/dev/null | cut -d' ' -f1)
git fetch origin "$BRANCH" || exit 1
git checkout -q -B "$BRANCH" "origin/$BRANCH" || exit 1
git reset -q --hard "origin/$BRANCH"
if [ "$MODE" = full ]; then
  # Like a fresh runner: drop build outputs, .env files, coverage, Playwright's results
  # and Turbo's cache. node_modules is kept; the frozen install re-syncs it.
  rm -f "$LOG_DIR"/*.log "$STATE"
  rm -rf "$LOG_DIR"/playwright-report-*
  STATUS=() AT=()
  git clean -q -ffdx -e node_modules
fi
SHA=$(git rev-parse HEAD)
echo "$MODE run of $BRANCH at $SHA"

if [ "$MODE" = full ] || [ ! -d node_modules ] || [ "$OLD_LOCK" != "$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)" ]; then
  pnpm install --frozen-lockfile 2>&1 | tee "$LOG_DIR/install.log"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "FAIL  install: pnpm install --frozen-lockfile (lockfile out of date?)"
    exit 1
  fi
else
  echo "lockfile unchanged: skipping pnpm install"
fi

# --- 2. Jobs ------------------------------------------------------------------------
job_static() {
  pnpm format:check
  pnpm lint
  pnpm typecheck
}

job_unit() {
  pnpm test
}

job_build() {
  pnpm build
  pnpm size
  if grep -rqE "dev/sign-in|kaki_dev_session" apps/api/dist/main.js apps/realtime/dist/main.js apps/dashboard/dist/assets; then
    echo "A dev sign-in is in a production bundle"
    return 1
  fi
}

job_eval() {
  pnpm eval --fast
}

job_integration() {
  [ "$MODE" = full ] && pnpm --filter @kaki/ingest-worker exec playwright-core install --only-shell chromium
  pnpm test:coverage --concurrency=2
}

job_security() {
  pnpm audit --prod --audit-level=high
  trivy fs --scanners vuln,secret,misconfig --skip-dirs '**/node_modules' \
    --ignorefile .trivyignore.yaml --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 .
  docker build --build-arg ROLE=api -t kaki/api:ci .
  docker build --build-arg ROLE=ingest-worker -t kaki/ingest-worker:ci .
  local langs
  langs=$(docker run --rm kaki/ingest-worker:ci tesseract --list-langs)
  echo "$langs"
  for l in eng chi_sim; do grep -qx "$l" <<<"$langs" || { echo "tesseract lacks $l"; return 1; }; done
  docker run --rm kaki/ingest-worker:ci pdftoppm -v
  trivy image --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 kaki/api:ci
}

job_terraform() {
  (cd infra/terraform && terraform fmt -recursive -check)
  # .terraform survives a quick run (gitignored, and only `full` cleans), so init is skipped.
  (cd infra/terraform/envs/prod && { [ "$MODE" = quick ] && [ -d .terraform ] || terraform init -backend=false -input=false; } && terraform validate && terraform test)
  local token=""
  command -v gh >/dev/null && token=$(gh auth token 2>/dev/null || true)
  (cd infra/terraform && { [ "$MODE" = quick ] || GITHUB_TOKEN="$token" tflint --init; } && tflint --recursive --config "$PWD/.tflint.hcl")
}

job_actionlint() {
  # Pinned version, so the binary is downloaded once and reused.
  local bin="$TOOLS_DIR/actionlint-1.7.12"
  if [ ! -x "$bin" ]; then
    (cd "$TOOLS_DIR" && bash <(curl -sSL https://raw.githubusercontent.com/rhysd/actionlint/914e7df21a07ef503a81201c76d2b11c789d3fca/scripts/download-actionlint.bash) 1.7.12 && mv actionlint "$bin")
  fi
  "$bin" -color
}

DEV_PID=""
stop_dev() {
  # pnpm dev runs in its own process group; SIGTERM lets turbo stop every dev server.
  if [ -n "$DEV_PID" ]; then
    kill -TERM -- "-$DEV_PID" 2>/dev/null || true
    for _ in $(seq 20); do kill -0 "$DEV_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$DEV_PID" 2>/dev/null || true
    DEV_PID=""
  fi
}
stack_down() {
  stop_dev
  docker compose down -v >/dev/null 2>&1 || true
}

job_e2e_stack() {
  node scripts/gen-local-env.mjs # keeps .env files that already exist
  docker compose up -d --wait    # a no-op when a quick run finds the stack up
  pnpm db:setup                  # idempotent; applies any new migrations
  [ "$MODE" = full ] && pnpm --filter @kaki/e2e exec playwright install chromium firefox webkit
  return 0
}

# One `pnpm dev` for all three browsers, restarted every run so it serves the new code.
# The browsers still run one after another: the specs share the tenants, Mailpit and
# the sign-in rate-limit keys (workers: 1 in e2e/playwright.config.ts), so running them
# at the same time against one stack would fail tests that pass on their own.
job_e2e_dev() {
  if ss -ltn | grep -qE ':(3000|3001|3002|3003|3004|5173|5174|5175) '; then
    echo "A dev port (3000-3004, 5173-5175) is already in use: stop 'pnpm dev' in your other checkout"
    return 1
  fi
  setsid pnpm dev >"$LOG_DIR/e2e-dev-server.log" 2>&1 &
  DEV_PID=$!
  local url
  for url in http://localhost:3000/readyz http://localhost:3001/readyz http://localhost:3002/readyz \
    http://localhost:3003/readyz http://localhost:3004/readyz http://localhost:5173/ http://localhost:5175/; do
    for i in $(seq 180); do
      curl -fsS -o /dev/null "$url" && break
      kill -0 "$DEV_PID" 2>/dev/null || { echo "pnpm dev exited; see $LOG_DIR/e2e-dev-server.log"; return 1; }
      [ "$i" -eq 180 ] && { echo "$url did not become ready; see $LOG_DIR/e2e-dev-server.log"; return 1; }
      sleep 1
    done
  done
  echo "dev servers ready"
}

# Each browser keeps its own results folder, so `--last-failed` knows its failures.
job_e2e_browser() {
  local b="$1" last="e2e/test-results/$1/.last-run.json" args=()
  if [ "${E2E_SPECS[$b]}" = last-failed ] && [ -f "$last" ] &&
    node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1])).failedTests?.length ? 0 : 1)' "$last"; then
    echo "re-running only the specs that failed last time in $b"
    args+=(--last-failed)
  fi
  E2E_REUSE_SERVERS=true pnpm test:e2e --project="$b" --output="test-results/$b" "${args[@]}"
}

run static job_static
run unit job_unit
run build job_build
run eval job_eval
run integration job_integration
run security job_security
run terraform job_terraform
run actionlint job_actionlint

if [ -n "${SELECTED[e2e-stack]:-}" ]; then
  # The E2E stack uses the same ports as your dev stack: refuse to start if it's up.
  if [ -n "$(docker compose -p kakiagent ps -q 2>/dev/null)" ]; then
    echo "e2e: your dev stack is running; run 'pnpm stack:down' in your dev checkout and stop 'pnpm dev'"
    record e2e-stack FAIL 0
  else
    if [ "$MODE" = full ]; then
      trap stack_down EXIT
      stack_down
    else
      trap stop_dev EXIT
    fi
    run e2e-stack job_e2e_stack
    if [ "${STATUS[e2e-stack]}" = PASS ]; then
      # Not through run(): that uses a subshell, and DEV_PID must reach stop_dev here.
      echo
      echo "=================== e2e-dev ==================="
      start=$SECONDS
      if job_e2e_dev >"$LOG_DIR/e2e-dev.log" 2>&1; then rc=PASS; else rc=FAIL; fi
      cat "$LOG_DIR/e2e-dev.log"
      record e2e-dev $rc $((SECONDS - start))
    fi
    if [ "${STATUS[e2e-dev]:-}" = PASS ] && [ "${RAN[e2e-dev]:-}" ]; then
      for b in $BROWSERS; do
        run "e2e-$b" job_e2e_browser "$b"
        # Keep each browser's report, as CI uploads them on failure.
        if [ -n "${RAN[e2e-$b]:-}" ] && [ -d e2e/playwright-report ]; then
          rm -rf "$LOG_DIR/playwright-report-$b" && cp -r e2e/playwright-report "$LOG_DIR/playwright-report-$b"
        fi
      done
    fi
    if [ "$MODE" = full ]; then
      stack_down
    else
      stop_dev
      echo "E2E stack left running for the next quick run; remove it with: docker compose -p kakiagent-ci down -v"
    fi
    trap - EXIT
  fi
fi

# --- 3. State and summary -----------------------------------------------------------
{
  echo "branch $BRANCH"
  for j in $ALL_JOBS; do [ -n "${STATUS[$j]:-}" ] && echo "$j ${STATUS[$j]} ${AT[$j]}"; done
} >"$STATE"

stale=() still_failing=0
# Redirected, not piped to tee: a piped group runs in a subshell and still_failing
# would never reach the exit code.
{
  echo
  echo "CI (local, WSL, $MODE run) for $BRANCH at ${SHA:0:12}, $(date -Iseconds)"
  for j in $ALL_JOBS; do
    s="${STATUS[$j]:-}"
    if [ -z "$s" ]; then
      printf '%-5s %-13s\n' "-" "$j"
      stale+=("$j")
      continue
    fi
    [ "$s" = PASS ] || still_failing=1
    note="this run"
    [ -n "${RAN[$j]:-}" ] || note="earlier run"
    [ "${AT[$j]}" = "$SHA" ] || { note="$note, older commit"; stale+=("$j"); }
    line=$(printf '%-5s %-13s %s (%s)' "$s" "$j" "${AT[$j]:0:12}" "$note")
    [ "$s" = PASS ] || line="$line  log: $LOG_DIR/$j.log"
    echo "$line"
  done
  if [ "$still_failing" = 0 ] && [ ${#stale[@]} -eq 0 ]; then
    echo "All jobs passed at ${SHA:0:12}."
  elif [ "$still_failing" = 0 ]; then
    echo "All jobs pass, but not all at ${SHA:0:12} (${stale[*]}): run 'ci-local.sh full $BRANCH' before reporting to verify."
  fi
} >"$LOG_DIR/summary.txt"
cat "$LOG_DIR/summary.txt"
[ "$still_failing" = 0 ] && exit 0
exit 1
