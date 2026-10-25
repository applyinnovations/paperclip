{
  # CI toolchain for the applyinnovations Paperclip fork. Upstream does not use
  # Nix; this flake only pins the tools our Tekton pipelines run.
  description = "xlab CI toolchain for the Paperclip fork";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { nixpkgs, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
    in
    {
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24
          pkgs.corepack_24
          pkgs.git
          pkgs.gh
          pkgs.jq
          pkgs.coreutils
          pkgs.findutils
          pkgs.gnugrep
          pkgs.gnused
          pkgs.bash
          pkgs.cacert
          # paperclip-runner's typecheck and build run cargo (fmt, check and
          # the runnerd release binary). It pins Rust 1.97.1 for rustup; plain
          # cargo ignores rust-toolchain.toml and builds it with nixpkgs' Rust.
          pkgs.cargo
          pkgs.rustc
          pkgs.rustfmt
        ];
        # corepack runs exactly the pnpm pinned in package.json (packageManager),
        # as upstream CI does; nixpkgs' pnpm 9 is marked end-of-life.
        COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
        COREPACK_ENABLE_AUTO_PIN = "0";
        # ci.sh links this glibc's loader into /lib64 on loader-less CI images.
        XLAB_GLIBC = "${pkgs.glibc}";
      };
    };
}
