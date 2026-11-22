#!/usr/bin/env bash
# Runs the same gates as the CI `ci` job. When you add a gate to .github/workflows/ci.yml,
# add it here in the same commit: a missing check and a skipped check look identical.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== type-check"; npm run type-check
echo "== build client"; npm run build:client
echo "== test";       npm test
echo "preflight: all gates passed"
