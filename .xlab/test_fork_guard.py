"""Tests for fork_guard.py against a tiny upstream and fork.

python3 -m unittest discover -s .xlab -p 'test_*.py'
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE / "fork_guard.py"
sys.path.insert(0, str(HERE))
import fork_guard  # noqa: E402

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
MIG = "packages/db/src/migrations"


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], env=ENV, check=True,
                          capture_output=True, text=True).stdout.strip()


class FindTermsTest(unittest.TestCase):
    patterns = fork_guard.compile_terms(["xlab", "playable", "apply innovations", "xlab.now"])

    def hits(self, text):
        return fork_guard.find_terms(self.patterns, text)

    def test_whole_words_any_case(self):
        self.assertEqual(self.hits('login: "paperclip-xlab-now[bot]"'), ["xlab"])
        self.assertEqual(self.hits("XLAB_GITHUB_APP=1"), ["xlab"])
        self.assertEqual(self.hits("https://id.xlab.now/realms"), ["xlab", "xlab.now"])
        self.assertEqual(self.hits("const PLAYABLE = 1"), ["playable"])
        self.assertEqual(self.hits("Apply  Innovations Pty"), ["apply innovations"])
        self.assertEqual(self.hits("apply-innovations"), ["apply innovations"])

    def test_camel_case_boundaries(self):
        self.assertEqual(self.hits("function XlabLogin() {}"), ["xlab"])
        self.assertEqual(self.hits("const isXlab = true"), ["xlab"])

    def test_inside_other_words(self):
        for text in ("InviteUxLab", "checkboxLabel", "xlabel", "XLABEL", "replayable",
                     "isDisplayable", "NON_REPLAYABLE_FIELDS", "apply innovationsy"):
            self.assertEqual(self.hits(text), [], text)

    def test_denylist_comments_and_blanks(self):
        self.assertEqual(fork_guard.parse_denylist("# c\n\nxlab  # ours\n apply innovations\n"),
                         ["xlab", "apply innovations"])


class ForkGuardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        # Upstream: v1.0.0 has one migration; v1.1.0 adds a second and a line
        # that happens to contain a deny-list word; master then adds a third.
        self.up = self.dir / "upstream"
        git(self.dir, "init", "--quiet", "-b", "master", str(self.up))
        self.write(self.up, f"{MIG}/0001_init.sql", "create table a();\n")
        self.write(self.up, f"{MIG}/meta/_journal.json", '{"entries": [1]}\n')
        self.write(self.up, "src/app.ts", "export const a = 1;\n")
        self.write(self.up, "src/video.ts", "// render\n")
        self.commit(self.up, "v1.0.0")
        git(self.up, "tag", "v1.0.0")
        self.write(self.up, f"{MIG}/0002_more.sql", "create table b();\n")
        self.write(self.up, f"{MIG}/meta/_journal.json", '{"entries": [1, 2]}\n')
        self.write(self.up, "src/video.ts", "// render\n// a playable video\n")
        self.commit(self.up, "v1.1.0")
        git(self.up, "tag", "v1.1.0")
        self.write(self.up, f"{MIG}/0003_next.sql", "create table c();\n")
        self.commit(self.up, "unreleased")
        # Fork: xlab is v1.0.0 plus the fork's files and one carried patch
        # that still names the deployment (fixtures awaiting cleanup).
        self.fork = self.dir / "fork"
        git(self.dir, "clone", "--quiet", "--branch", "v1.0.0", str(self.up), str(self.fork))
        git(self.fork, "checkout", "--quiet", "-b", "xlab")
        self.write(self.fork, ".xlab/fork-guard-denylist.txt",
                   (HERE / "fork-guard-denylist.txt").read_text())
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n")
        self.write(self.fork, ".xlab/README.md", "Runs on xlab.\n")
        self.write(self.fork, "OWNERS", "approvers:\n  - someone-applyinnovations\n")
        self.write(self.fork, "src/fixture.ts", 'export const bot = "paperclip-xlab-now[bot]";\n')
        self.commit(self.fork, "fork")
        git(self.fork, "checkout", "--quiet", "-b", "pr")

    def write(self, repo, path, text):
        file = repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text)

    def commit(self, repo, message):
        git(repo, "add", "-A")
        git(repo, "commit", "--quiet", "--allow-empty", "-m", message)

    def run_guard(self, *args):
        env = {**ENV, "FORK_GUARD_UPSTREAM_URL": f"file://{self.up}"}
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], cwd=self.fork, env=env,
                              capture_output=True, text=True)

    def check(self):
        return self.run_guard("check", "xlab", "HEAD")

    def assertPasses(self, result):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def assertFails(self, result, rule, text):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"FAIL {rule}", result.stdout)
        self.assertIn(text, result.stdout)

    # Patch record

    def test_ci_only_change_passes(self):
        self.write(self.fork, ".xlab/ci.sh", "echo xlab\n")
        self.write(self.fork, "OWNERS", "approvers:\n  - other-applyinnovations\n")
        self.commit(self.fork, "ci")
        self.assertPasses(self.check())

    def test_patch_without_patches_row_fails(self):
        self.write(self.fork, "src/app.ts", "export const a = 2;\n")
        self.commit(self.fork, "patch")
        self.assertFails(self.check(), "patch record", "src/app.ts")

    def test_patch_with_patches_row_passes(self):
        self.write(self.fork, "src/app.ts", "export const a = 2;\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| a is 2 |\n")
        self.commit(self.fork, "patch")
        self.assertPasses(self.check())

    # Migrations

    def test_fork_authored_migration_fails(self):
        self.write(self.fork, f"{MIG}/0002_ours.sql", "create table ours();\n")
        self.write(self.fork, f"{MIG}/meta/_journal.json", '{"entries": [1, "ours"]}\n')
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| ours |\n")
        self.commit(self.fork, "migration")
        result = self.check()
        self.assertFails(result, "migrations", f"{MIG}/0002_ours.sql")
        self.assertIn(f"{MIG}/meta/_journal.json", result.stdout)

    def test_editing_an_upstream_migration_fails(self):
        self.write(self.fork, f"{MIG}/0001_init.sql", "create table a(x int);\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| edit |\n")
        self.commit(self.fork, "edit")
        self.assertFails(self.check(), "migrations", f"{MIG}/0001_init.sql")

    def test_deleting_an_upstream_migration_fails(self):
        git(self.fork, "rm", "--quiet", f"{MIG}/0001_init.sql")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| drop |\n")
        self.commit(self.fork, "drop")
        self.assertFails(self.check(), "migrations", "deletes")

    def test_unreleased_upstream_migration_copied_in_fails(self):
        # Byte-identical to upstream master, but no release HEAD contains has it.
        self.write(self.fork, f"{MIG}/0003_next.sql", "create table c();\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| early |\n")
        self.commit(self.fork, "early")
        self.assertFails(self.check(), "migrations", "differs from upstream v1.0.0")

    # Upstream intake

    def test_intake_merge_of_a_release_passes(self):
        git(self.fork, "merge", "--quiet", "--no-edit", "v1.1.0")
        result = self.check()
        self.assertPasses(result)
        self.assertIn("upstream intake of v1.1.0", result.stdout)

    def test_bare_release_branch_as_intake_passes(self):
        # Like the intake's upstream/<tag> PR head: the release itself.
        git(self.fork, "checkout", "--quiet", "-B", "pr", "v1.1.0")
        self.assertPasses(self.check())

    def test_intake_resolution_that_changes_a_migration_fails(self):
        git(self.fork, "merge", "--quiet", "--no-commit", "v1.1.0")
        self.write(self.fork, f"{MIG}/0002_more.sql", "create table b(x int);\n")
        self.commit(self.fork, "merge v1.1.0")
        self.assertFails(self.check(), "migrations", f"{MIG}/0002_more.sql")

    def test_intake_resolution_that_adds_a_deployment_name_fails(self):
        git(self.fork, "merge", "--quiet", "--no-commit", "v1.1.0")
        self.write(self.fork, "src/video.ts", "// render\n// a playable video\n// for xlab\n")
        self.commit(self.fork, "merge v1.1.0")
        self.assertFails(self.check(), "deployment names", "src/video.ts:3: adds xlab")

    # Deployment names

    def test_added_deployment_name_fails(self):
        self.write(self.fork, "src/app.ts", 'export const a = 1;\nexport const host = "id.XLAB.now";\n')
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| host |\n")
        self.commit(self.fork, "host")
        self.assertFails(self.check(), "deployment names", "src/app.ts:2: adds xlab, xlab.now")

    def test_added_line_that_looks_like_a_diff_header_is_checked(self):
        self.write(self.fork, "src/app.ts", "-- a\n")
        self.commit(self.fork, "dashes")
        self.write(self.fork, "src/app.ts", "++ b/xlab\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| pluses |\n")
        self.commit(self.fork, "pluses")
        self.assertFails(self.check(), "deployment names", "src/app.ts:1: adds xlab")

    def test_words_that_only_contain_a_term_pass(self):
        self.write(self.fork, "src/app.ts", "export const checkboxLabel = 'replayable UxLab';\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| label |\n")
        self.commit(self.fork, "label")
        self.assertPasses(self.check())

    def test_existing_names_are_not_blocking(self):
        self.write(self.fork, "src/fixture.ts", 'export const bot = "paperclip-xlab-now[bot]";\nexport const n = 1;\n')
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| n |\n")
        self.commit(self.fork, "n")
        self.assertPasses(self.check())

    def test_deployment_file_name_fails(self):
        self.write(self.fork, "src/calile-apps.ts", "export {};\n")
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| apps |\n")
        self.commit(self.fork, "apps")
        self.assertFails(self.check(), "deployment names", "src/calile-apps.ts: file name contains calile")

    def test_denylist_comes_from_the_target_branch(self):
        self.write(self.fork, ".xlab/fork-guard-denylist.txt", "calile\n")
        self.write(self.fork, "src/app.ts", 'export const realm = "xlab";\n')
        self.write(self.fork, ".xlab/PATCHES.md", "| Change |\n| realm |\n")
        self.commit(self.fork, "loosen")
        self.assertFails(self.check(), "deployment names", "src/app.ts:1: adds xlab")

    # Report

    def test_report_lists_fork_names_and_never_fails(self):
        git(self.fork, "merge", "--quiet", "--no-edit", "v1.1.0")
        result = self.run_guard("report")
        self.assertPasses(result)
        self.assertIn("src/fixture.ts:1: xlab", result.stdout)
        self.assertNotIn("src/video.ts", result.stdout)
        self.assertNotIn("OWNERS:", result.stdout)
        self.assertNotIn(".xlab/README.md", result.stdout)
        self.assertIn("1 lines in 1 files", result.stdout)

    def test_usage_error(self):
        self.assertEqual(self.run_guard("bogus").returncode, 2)


if __name__ == "__main__":
    unittest.main()
