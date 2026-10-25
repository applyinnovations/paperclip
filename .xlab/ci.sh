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
  # Packages excluded from the pnpm workspace (sandbox providers) install
  # standalone without a lockfile, as upstream builds them, and run their own
  # vitest config; the root vitest projects do not include them.
  mapfile -t members < <(pnpm m ls --depth -1 --json | jq -r '.[].path')
  workspace_tests=()
  declare -A standalone_tests=()
  for file in "${tests[@]}"; do
    dir=$(dirname "$file")
    while [ "$dir" != . ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done
    if [ "$dir" != . ] && ! printf '%s\n' "${members[@]}" | grep -qxF "$PWD/$dir"; then
      standalone_tests[$dir]+="${file#"$dir"/}"$'\n'
    else
      workspace_tests+=("$file")
    fi
  done
  if [ ${#workspace_tests[@]} -gt 0 ]; then
    step test pnpm exec vitest run "${workspace_tests[@]}"
  fi
  for dir in "${!standalone_tests[@]}"; do
    mapfile -t files < <(printf '%s' "${standalone_tests[$dir]}")
    step "install $dir" pnpm install --dir "$dir" --ignore-workspace --no-lockfile --no-frozen-lockfile
    node scripts/link-plugin-dev-sdk.mjs
    step "test $dir" pnpm --dir "$dir" exec vitest run "${files[@]}"
  done
  if [ ${#tests[@]} -eq 0 ]; then
    echo "::: test skipped: the change adds or edits no test files"
  fi
else
  step test pnpm test:run
fi
