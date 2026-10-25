#!/usr/bin/env bash
# Pull request checks for the xlab branch. Run inside the .xlab toolchain:
#   nix develop ./.xlab --command .xlab/ci.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export COREPACK_HOME="${COREPACK_HOME:-$PWD/.xlab/.cache/corepack}"
export CI=true

step() {
  local name=$1; shift
  local start=$SECONDS
  echo "::: ${name}"
  "$@"
  echo "::: ${name} done in $((SECONDS - start))s"
}

step install pnpm install --frozen-lockfile
step typecheck pnpm -r typecheck
step build pnpm build
# Pull requests run only the tests affected by their change (vitest's import
# graph against the target branch); the full suite (40+ minutes) runs from
# .tekton/full-tests.yaml.
if [ "${CI_TEST_SCOPE:-full}" = changed ]; then
  : "${CI_BASE_REF:?set CI_BASE_REF to the target branch ref}"
  step test pnpm exec vitest run --changed "$CI_BASE_REF" --passWithNoTests
else
  step test pnpm test:run
fi
