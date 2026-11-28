"""Tests for test-env-guard.mjs against the repository's real redactor.

python3 -m unittest discover -s .xlab -p 'test_*.py'
"""

import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

XLAB = pathlib.Path(__file__).resolve().parent
SCRIPT = XLAB / "test-env-guard.mjs"
REDACTOR = XLAB.parent / "packages/adapter-utils/src/command-redaction.ts"
SECRET = "do-not-print-this-value"


class TestEnvGuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)
        (self.root / "packages/adapter-utils/src").mkdir(parents=True)
        shutil.copy(REDACTOR, self.root / "packages/adapter-utils/src")
        (self.root / "node_modules/.pnpm/@types+node@24.13.3").mkdir(parents=True)

    def guard(self, **env):
        base = {"PATH": os.environ["PATH"], "HOME": str(self.root), "NODE_ENV": "test", "MODE": "test"}
        return subprocess.run(["node", str(SCRIPT), str(self.root)], env={**base, **env},
                              capture_output=True, text=True)

    def test_passes_upstream_like_env(self):
        result = self.guard(CI="true", LONG_SETTING=SECRET, NIX_BUILD_CORES="23")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_names_short_values_masked_in_stacks(self):
        result = self.guard(name="test", NIX_BUILD_CORES="24", SHORT="zzq")
        self.assertEqual(result.returncode, 1)
        self.assertIn(": NIX_BUILD_CORES, name\n", result.stderr)
        # An ordinary setting that shares the value is not blamed.
        self.assertNotIn("NODE_ENV", result.stderr)

    def test_never_prints_values(self):
        result = self.guard(name="test", **{SECRET.upper().replace("-", "_"): "24"})
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("24", result.stdout + result.stderr)
        self.assertNotIn("=", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
