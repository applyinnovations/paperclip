#!/usr/bin/env bash
# Pull request checks for the xlab branch. Run inside the .xlab toolchain:
#   nix develop ./.xlab --command .xlab/ci.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export COREPACK_HOME="${COREPACK_HOME:-$PWD/.xlab/.cache/corepack}"
export CI=true

# Prebuilt binaries from npm (opencode-ai's postinstall runs its CLI) expect the
# FHS dynamic loader, which the nixos/nix CI image lacks. Link the toolchain's
# glibc loader there when the root filesystem is ours to change.
loader=/lib64/ld-linux-x86-64.so.2
if [ ! -e "$loader" ] && [ -n "${XLAB_GLIBC:-}" ] && [ -w / ]; then
  mkdir -p /lib64
  ln -s "$XLAB_GLIBC/lib/ld-linux-x86-64.so.2" "$loader"
fi

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
# Pull requests run the test files they add or change. Import-graph selection
# (vitest --changed) still picks most of the suite for any server change, and
# the full suite takes 40+ minutes, so it runs nightly from
# .tekton/full-tests.yaml and before a deploy.
if [ "${CI_TEST_SCOPE:-full}" = changed ]; then
  : "${CI_BASE_REF:?set CI_BASE_REF to the target branch ref}"
  mapfile -t tests < <(git diff --name-only --diff-filter=AMR "$CI_BASE_REF" HEAD \
    | grep -E '\.test\.(ts|tsx|mts|js|mjs)$' || true)
  if [ ${#tests[@]} -gt 0 ]; then
    step test pnpm exec vitest run "${tests[@]}"
  else
    echo "::: test skipped: the change adds or edits no test files"
  fi
else
  step test pnpm test:run
fi
