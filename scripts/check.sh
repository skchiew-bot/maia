#!/usr/bin/env bash
# Full-repo verification: typecheck + tests per package with bounded concurrency, then the packaging smoke test
# (build the bundles and run them from a copy of dist/). Exit non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")/.."
CONC="${CONC:-3}"
fail=0
echo "== typecheck =="
if ! pnpm -r --workspace-concurrency="$CONC" typecheck >/tmp/aoc-typecheck.log 2>&1; then
  grep -E "error TS|ERR_PNPM|Failed" /tmp/aoc-typecheck.log | head -60
  fail=1
else
  echo "typecheck ok"
fi
echo "== tests =="
if ! pnpm -r --workspace-concurrency="$CONC" --no-bail test >/tmp/aoc-test.log 2>&1; then
  fail=1
fi
grep -E "Test Files|Tests |FAIL|✗|×" /tmp/aoc-test.log | grep -v "ExperimentalWarning" | head -80
echo "== dist smoke =="
if ! node scripts/smoke-dist.mjs >/tmp/aoc-smoke.log 2>&1; then
  grep -E "^FAIL" -A 20 /tmp/aoc-smoke.log | head -40
  fail=1
else
  tail -1 /tmp/aoc-smoke.log
fi
exit $fail
