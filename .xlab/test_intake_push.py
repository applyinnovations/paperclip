"""Tests for intake-push.sh against local repositories standing in for GitHub.

python3 -m unittest discover -s .xlab -p 'test_*.py'
"""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "intake-push.sh"
TAG = "v2026.1106.0"


ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], env=ENV, check=True,
                          capture_output=True, text=True).stdout.strip()


class IntakePushTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        # Upstream: master with a release tag and a later commit.
        self.up = self.dir / "upstream"
        git(self.dir, "init", "--quiet", "-b", "master", str(self.up))
        self.base = self.commit(self.up, "base")
        self.release = self.commit(self.up, "release")
        git(self.up, "tag", TAG)
        self.head = self.commit(self.up, "after")
        # Fork: master behind upstream, xlab at the base plus a patch.
        self.fork = self.dir / "fork.git"
        git(self.dir, "init", "--quiet", "--bare", str(self.fork))
        git(self.up, "push", "--quiet", str(self.fork), f"{self.base}:refs/heads/master", f"{self.base}:refs/heads/xlab")
        self.plan = self.dir / "plan"
        self.plan.mkdir()
        (self.plan / "tag").write_text(TAG + "\n")
        self.work = self.dir / "work"
        self.work.mkdir()

    def commit(self, repo, name):
        git(repo, "commit", "--quiet", "--allow-empty", "-m", name)
        return git(repo, "rev-parse", "HEAD")

    def run_push(self):
        env = {**ENV, "FORK_URL": f"file://{self.fork}", "UPSTREAM_URL": f"file://{self.up}"}
        return subprocess.run(["sh", str(SCRIPT), str(self.plan), str(self.dir / "no-key"), str(self.work)],
                              env=env, capture_output=True, text=True)

    def ref(self, name):
        return subprocess.run(["git", "-C", str(self.fork), "rev-parse", "--verify", "--quiet", name],
                              env=ENV, capture_output=True, text=True).stdout.strip()

    def test_fast_forwards_master_and_pushes_release_branch(self):
        result = self.run_push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ref("refs/heads/master"), self.head)
        self.assertEqual(self.ref(f"refs/heads/upstream/{TAG}"), self.release)
        self.assertEqual(sorted(p.name for p in self.work.iterdir()), ["pushed-tag"])
        self.assertEqual((self.work / "pushed-tag").read_text(), TAG + "\n")

    def test_without_a_planned_release_only_master_moves(self):
        (self.plan / "tag").unlink()
        result = self.run_push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ref("refs/heads/master"), self.head)
        self.assertEqual(self.ref(f"refs/heads/upstream/{TAG}"), "")
        self.assertEqual(list(self.work.iterdir()), [])

    def test_release_already_in_xlab_is_not_pushed(self):
        git(self.up, "push", "--quiet", "--force", str(self.fork), f"{self.release}:refs/heads/xlab")
        result = self.run_push()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ref(f"refs/heads/upstream/{TAG}"), "")
        self.assertFalse((self.work / "pushed-tag").exists())

    def test_diverged_master_is_refused(self):
        clone = self.dir / "clone"
        git(self.dir, "clone", "--quiet", str(self.fork), str(clone))
        diverged = self.commit(clone, "fork-only")
        git(clone, "push", "--quiet", "origin", "HEAD:refs/heads/master")
        result = self.run_push()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("diverged", result.stderr)
        self.assertEqual(self.ref("refs/heads/master"), diverged)
        self.assertEqual(list(self.work.iterdir()), [])

    def test_unexpected_tag_is_refused(self):
        (self.plan / "tag").write_text("master\n")
        result = self.run_push()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected release tag", result.stderr)
        self.assertEqual(self.ref("refs/heads/upstream/master"), "")
        self.assertFalse((self.work / "pushed-tag").exists())


if __name__ == "__main__":
    unittest.main()
