"""Tests for warm-cache.sh with a stand-in `nix` that records its calls.

python3 -m unittest discover -s .xlab -p 'test_*.py'
"""

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "warm-cache.sh"
TOOLCHAIN = "/nix/store/00000000000000000000000000000000-inputDerivation-nix-shell"

# Logs each call; `path-info` succeeds only when the cache holds the closure.
FAKE_NIX = f"""#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NIX_LOG"
case $1 in
  eval) printf '%s' '{TOOLCHAIN}' ;;
  path-info) [ "$CACHE_HAS_IT" = 1 ] ;;
esac
"""


class WarmCacheTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        (self.dir / "repo" / ".xlab").mkdir(parents=True)
        shutil.copy(SCRIPT, self.dir / "repo" / ".xlab" / "warm-cache.sh")
        bin_dir = self.dir / "bin"
        bin_dir.mkdir()
        (bin_dir / "nix").write_text(FAKE_NIX)
        (bin_dir / "nix").chmod(0o755)
        self.log = self.dir / "nix.log"
        # BASH_ENV could reset PATH in the script's shell.
        env = {k: v for k, v in os.environ.items() if k != "BASH_ENV"}
        self.env = {**env, "PATH": f"{bin_dir}:{os.environ['PATH']}", "NIX_LOG": str(self.log),
                    "XLAB_NIX_CACHE": "http://cache.test"}

    def run_script(self, cache_has_it):
        result = subprocess.run(["bash", str(self.dir / "repo" / ".xlab" / "warm-cache.sh")],
                                env={**self.env, "CACHE_HAS_IT": "1" if cache_has_it else "0"},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout, self.log.read_text().splitlines()

    def test_builds_nothing_when_the_cache_holds_the_closure(self):
        out, calls = self.run_script(cache_has_it=True)
        self.assertIn("already holds", out)
        self.assertEqual(calls, [
            "eval --raw ./.xlab#ci-toolchain.outPath",
            f"path-info --recursive --store http://cache.test {TOOLCHAIN}",
        ])

    def test_builds_the_toolchain_when_the_cache_lacks_part_of_it(self):
        _, calls = self.run_script(cache_has_it=False)
        self.assertEqual(calls[-1], "build --no-link --print-build-logs ./.xlab#ci-toolchain")


if __name__ == "__main__":
    unittest.main()
