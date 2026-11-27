#!/usr/bin/env bash
# Puts the PR checks' toolchain (`nix develop ./.xlab`: the devshell's
# packages and paperclip-runner's prebuilt Cargo dependencies) in the shared
# Nix cache, so a PR check substitutes it over the LAN instead of building
# the Rust dependencies or downloading from cache.nixos.org.
#
# .tekton/nix-cache-warm.yaml runs this on each push to xlab in the nix-v1
# Task, whose export-cache step hands every store path the cache lacks to
# nix-cache-publish-v1. The weekly test-full run cannot do it: nix-v1 skips
# its export when the tests fail.
#
# When the cache already holds the toolchain's whole closure, it builds
# nothing (a run after a merge that left the flake and Cargo.lock alone).
set -euo pipefail
cd "$(dirname "$0")/.."

cache=${XLAB_NIX_CACHE:-http://niks3.nix-cache.svc.cluster.local}
toolchain=$(nix eval --raw ./.xlab#ci-toolchain.outPath)
if nix path-info --recursive --store "$cache" "$toolchain" >/dev/null 2>&1; then
  echo "The Nix cache already holds the CI toolchain (${toolchain})"
  exit 0
fi
echo "Building the CI toolchain (${toolchain}) for the Nix cache"
nix build --no-link --print-build-logs ./.xlab#ci-toolchain
