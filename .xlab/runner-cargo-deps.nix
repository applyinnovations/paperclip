# paperclip-runner's Cargo dependencies, compiled once per Cargo.lock instead
# of in every PR check. .xlab/ci.sh copies this target directory into
# packages/paperclip-runner/runner/target and reads crates from the same
# vendored sources, so the typecheck's `cargo check` and the build's release
# `cargo build` compile only the Runner's own crates.
#
# Cargo reuses an artifact only when the unit's fingerprint matches: the same
# rustc and cargo (the devshell's), crate sources (this vendor directory, by
# store path), profile, features and environment the build scripts read. So
# the commands below are the ones package.json runs (typecheck:rust and
# build:binary) and no setup hook adds flags or a linker. Change them together.
{
  lib,
  stdenv,
  cargo,
  rustc,
  jq,
  rustPlatform,
  writeText,
  # The Cargo workspace: packages/paperclip-runner/runner.
  workspace,
}:
let
  # Only the manifests and the lockfile, so editing the Runner's sources does
  # not change this derivation.
  manifests = lib.fileset.toSource {
    root = workspace;
    fileset = lib.fileset.fileFilter (
      file: file.name == "Cargo.toml" || file.name == "Cargo.lock"
    ) workspace;
  };

  # Every crate in Cargo.lock, fetched by its checksum.
  vendor = rustPlatform.importCargoLock { lockFile = workspace + "/Cargo.lock"; };

  # Source replacement keeps the crates' package IDs (crates.io), so the
  # artifacts' hashes are the ones a registry build would give.
  cargoConfig = writeText "cargo-config.toml" ''
    [source.crates-io]
    replace-with = "vendored-sources"

    [source.vendored-sources]
    directory = "${vendor}"
  '';
in
stdenv.mkDerivation {
  pname = "paperclip-runner-cargo-deps";
  version = "0";
  src = manifests;

  nativeBuildInputs = [
    cargo
    rustc
    jq
  ];

  dontConfigure = true;

  buildPhase = ''
    runHook preBuild
    export CARGO_HOME="$TMPDIR/cargo-home"
    mkdir -p "$CARGO_HOME"
    cp ${cargoConfig} "$CARGO_HOME/config.toml"

    # Stand-in sources for every target: an empty library, a bare main
    # elsewhere. They compile nothing the Runner's own sources would reuse.
    for manifest in crates/*/Cargo.toml; do
      crate=''${manifest%/Cargo.toml}
      mkdir -p "$crate/src"
      touch "$crate/src/lib.rs"
    done
    cargo metadata --offline --no-deps --format-version 1 \
      | jq -r '.packages[].targets[] | "\(.kind[0]) \(.src_path)"' \
      | while read -r kind path; do
          [ -e "$path" ] && continue
          mkdir -p "$(dirname "$path")"
          case $kind in
            lib | rlib | dylib | cdylib | staticlib | proc-macro) : > "$path" ;;
            *) echo 'fn main() {}' > "$path" ;;
          esac
        done

    # packages/paperclip-runner/package.json: typecheck:rust, build:binary.
    cargo check --locked --offline --workspace
    cargo build --release --locked --offline -p paperclip-runner-core --bin paperclip-runnerd
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    # Keep the dependencies' artifacts only. The workspace crates' are built
    # from the stand-ins above, and CI compiles them from the real sources.
    for profile in target/debug target/release; do
      rm -rf "$profile/incremental" "$profile"/.fingerprint/paperclip-* \
        "$profile"/build/paperclip-* "$profile"/deps/*paperclip_* "$profile"/examples
      find "$profile" -maxdepth 1 -type f -delete
    done
    mkdir -p "$out"
    cp -r target "$out/target"
    cp ${cargoConfig} "$out/cargo-config.toml"
    runHook postInstall
  '';

  # Leave the artifacts byte for byte as cargo wrote them.
  dontFixup = true;
}
