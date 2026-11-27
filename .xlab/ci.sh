#!/usr/bin/env bash
# Pull request checks for the xlab branch. Run inside the .xlab toolchain:
#   nix develop ./.xlab --command .xlab/ci.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export COREPACK_HOME="${COREPACK_HOME:-$PWD/.xlab/.cache/corepack}"
export CI=true

# Upstream CI runs as an ordinary user on Ubuntu, and parts of the suite
# assume it. Tekton's nix-v1 step runs this script as root (inside a user
# namespace) on the nixos/nix image, which has no FHS loader and nothing in
# /usr/bin. When the root filesystem is ours to change (CI, never a
# workstation), make it look like upstream's runner instead of editing tests.
fhs_ci=false
if [ -w / ] && [ "$(id -u)" = 0 ] && [ -n "${XLAB_GLIBC:-}" ]; then
  fhs_ci=true
fi

if $fhs_ci; then
  # Prebuilt binaries from npm (opencode-ai's postinstall runs its CLI,
  # embedded Postgres) expect the FHS dynamic loader.
  loader=/lib64/ld-linux-x86-64.so.2
  if [ ! -e "$loader" ]; then
    mkdir -p /lib64
    ln -s "$XLAB_GLIBC/lib/ld-linux-x86-64.so.2" "$loader"
  fi
  # Tests start children with PATH=/usr/bin:/bin (git, bash, getconf, ps...).
  IFS=: read -ra path_dirs <<<"$PATH"
  for dir in "${path_dirs[@]}"; do
    case $dir in /nix/store/*) ;; *) continue ;; esac
    for bin in "$dir"/*; do
      name=${bin##*/}
      if [ -x "$bin" ] && [ ! -e "/usr/bin/$name" ]; then ln -s "$bin" "/usr/bin/$name"; fi
    done
  done
fi

step() {
  local name=$1; shift
  local start=$SECONDS
  echo "::: ${name}"
  "$@"
  echo "::: ${name} done in $((SECONDS - start))s"
}

# The fork's own CI scripts (.xlab/*.py, intake-push.sh).
step xlab-scripts env PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .xlab -p 'test_*.py'
step install pnpm install --frozen-lockfile
# The fork's Node CI scripts, which need the installed workspace.
step xlab-node-scripts node --test .xlab/related-tests.test.mjs
step typecheck pnpm -r typecheck
step build pnpm build

# The tests run as this user when the script runs as root: embedded Postgres
# refuses root, and file-mode and ownership checks differ under root.
as_test_user=()
if $fhs_ci; then
  # Embedded Postgres' bundled ICU needs the distribution's libstdc++; its
  # binaries search their own lib directory ($ORIGIN/../lib) first.
  for lib in node_modules/.pnpm/@embedded-postgres+linux-x64@*/node_modules/@embedded-postgres/linux-x64/native/lib; do
    if [ -d "$lib" ]; then ln -sf "$XLAB_LIBSTDCXX" "$lib/libstdc++.so.6"; fi
  done
  # The pod's volumes have an fsGroup, so their directories are setgid and
  # new directories inherit it. Some tests reject setgid entries in trees
  # they create (upstream's runner puts them under /tmp), so stop the
  # inheritance at the roots and in the checkout.
  chmod g-s /tmp
  find . -type d -perm -2000 -exec chmod g-s {} +
  # Its own HOME and TMPDIR: nix develop's TMPDIR is private to root.
  test_root=$(mktemp -d /tmp/ci-test.XXXXXX)
  mkdir "$test_root/home" "$test_root/tmp"
  grep -q '^ci-test:' /etc/passwd || echo "ci-test:x:1000:1000:CI tests:${test_root}/home:/bin/sh" >> /etc/passwd
  grep -q '^ci-test:' /etc/group || echo 'ci-test:x:1000:' >> /etc/group
  chmod 755 "$test_root"
  chown -R 1000:1000 . "$test_root/home" "$test_root/tmp"
  # Root still reads the checkout below (git diff for pull requests).
  git config --global --add safe.directory "$PWD"
  # tini -s reaps orphaned test children, as an init would; nothing in the
  # step does, and some tests wait for a killed child to disappear. The
  # tests also run without the compiler variables the Nix shell exports
  # (AR=ar, CC=gcc, ...): Ubuntu sets none, and the redactor masks their
  # short values inside unrelated strings.
  # nix-v1 mounts its scratch volume at /tmp, so the tests' temporary
  # directories sit on a different filesystem from /. Git then stops its
  # repository search at /tmp and reports "not a git repository (or any
  # parent up to mount point /)" instead of "(or any of the parent
  # directories)", which the server matches to recognise a plain directory.
  # Upstream's /tmp is on the root filesystem; let Git search across mounts
  # as it would there.
  as_test_user=(env -u AR -u AS -u CC -u CXX -u LD -u NM -u OBJCOPY -u OBJDUMP
    -u RANLIB -u READELF -u SIZE -u STRINGS -u STRIP
    HOME="$test_root/home" TMPDIR="$test_root/tmp" GIT_DISCOVERY_ACROSS_FILESYSTEM=1
    setpriv --reuid=1000 --regid=1000 --clear-groups -- tini -s --)
fi
# Pull requests run the test files they add or change, plus the tests that
# import the files they change (.xlab/related-tests.mjs, the selection of
# `vitest related`) while that adds at most CI_RELATED_TEST_CAP files (default
# 150, about 15 minutes). A change to a hub module (adapter-utils, the
# heartbeat service, ...) reaches 1,000-2,500 of the ~4,200 test files, and
# the full suite takes about 2 hours, so above the cap only the changed test
# files run and the scheduled full run (.tekton/full-tests.yaml) covers the
# rest.
if [ "${CI_TEST_SCOPE:-full}" = changed ]; then
  : "${CI_BASE_REF:?set CI_BASE_REF to the target branch ref}"
  diff_base=$CI_BASE_REF
  # An upstream intake pull request merges a stable release, changing
  # hundreds of upstream test files that upstream's CI already ran on that
  # exact commit. When HEAD contains an upstream stable release the base
  # does not, compare with that release instead: the tests that run are the
  # ones that differ from upstream's (carried patches, the merge resolution,
  # anything else the PR changes). Decided from history, not branch names.
  git fetch --quiet --no-tags --filter=blob:none https://github.com/paperclipai/paperclip.git \
    '+refs/tags/v*:refs/ci/upstream-tags/v*'
  mapfile -t releases < <(git for-each-ref --sort=-v:refname --format='%(refname:lstrip=3)' refs/ci/upstream-tags/ \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
  for release in "${releases[@]}"; do
    if git merge-base --is-ancestor "refs/ci/upstream-tags/${release}" HEAD &&
      ! git merge-base --is-ancestor "refs/ci/upstream-tags/${release}" "$CI_BASE_REF"; then
      diff_base="refs/ci/upstream-tags/${release}"
      echo "::: upstream intake of ${release}: selecting tests that differ from upstream's release"
      break
    fi
  done
  # --no-renames: a renamed file counts as added, and the diff never needs a
  # blob the partial clone lacks.
  mapfile -t changed < <(git diff --name-only --no-renames --diff-filter=AM "$diff_base" HEAD)
  # Packages excluded from the pnpm workspace (sandbox providers) install
  # standalone without a lockfile, as upstream builds them, and run their own
  # vitest config; the root vitest projects do not include them. Their suites
  # are small (at most 30 files, seconds), so a code change in one runs all
  # of it.
  mapfile -t members < <(pnpm m ls --depth -1 --json | jq -r '.[].path')
  workspace_changed=()
  workspace_tests=()
  declare -A standalone_changed=()
  for file in "${changed[@]}"; do
    dir=$(dirname "$file")
    while [ "$dir" != . ] && [ ! -f "$dir/package.json" ]; do dir=$(dirname "$dir"); done
    if [ "$dir" != . ] && ! printf '%s\n' "${members[@]}" | grep -qxF "$PWD/$dir"; then
      if [[ $file =~ \.[cm]?[jt]sx?$|(^|/)package\.json$ ]]; then standalone_changed[$dir]=1; fi
    else
      case $file in .xlab/* | .tekton/*) continue ;; esac # no test imports these
      workspace_changed+=("$file")
      if [[ $file =~ \.test\.(ts|tsx|mts|js|mjs)$ ]]; then workspace_tests+=("$file"); fi
    fi
  done
  related=()
  if [ ${#workspace_changed[@]} -gt 0 ]; then
    # Prints its own summary and timing on stderr.
    related_out=$("${as_test_user[@]}" node .xlab/related-tests.mjs "${workspace_changed[@]}")
    if [ -n "$related_out" ]; then
      mapfile -t related < <(comm -23 <(sort -u <<<"$related_out") \
        <(printf '%s\n' "${workspace_tests[@]}" | sort -u))
    fi
  fi
  cap=${CI_RELATED_TEST_CAP:-150}
  selection=("${workspace_tests[@]}" "${related[@]}")
  if [ ${#selection[@]} -gt "$cap" ]; then
    echo "::: related tests skipped: ${#related[@]} test files import the change, more than CI_RELATED_TEST_CAP=${cap} with the ${#workspace_tests[@]} changed; the scheduled full run covers them"
    selection=("${workspace_tests[@]}")
  elif [ ${#related[@]} -gt 0 ]; then
    echo "::: related tests: ${#related[@]} test files import the change, added to the ${#workspace_tests[@]} changed"
  fi
  if [ ${#selection[@]} -gt 0 ]; then
    step test "${as_test_user[@]}" pnpm exec vitest run "${selection[@]}"
  fi
  for dir in "${!standalone_changed[@]}"; do
    step "install $dir" "${as_test_user[@]}" pnpm install --dir "$dir" --ignore-workspace --no-lockfile --no-frozen-lockfile
    "${as_test_user[@]}" node scripts/link-plugin-dev-sdk.mjs
    step "test $dir" "${as_test_user[@]}" pnpm --dir "$dir" exec vitest run
  done
  if [ ${#workspace_tests[@]} -eq 0 ] && [ ${#related[@]} -eq 0 ] && [ ${#standalone_changed[@]} -eq 0 ]; then
    echo "::: test skipped: no test file changed or imports the change"
  fi
else
  step test "${as_test_user[@]}" pnpm test:run
fi
