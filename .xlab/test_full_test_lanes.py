"""Tests for full_test_lanes.py and the lanes of .tekton/full-tests.yaml.

python3 -m unittest discover -s .xlab -p 'test_*.py'
"""

import collections
import pathlib
import re
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import full_test_lanes as lanes_module  # noqa: E402
from full_test_lanes import Shard  # noqa: E402

WORKFLOW = ROOT / ".github/workflows/pr-trusted.yml"
PIPELINE = ROOT / ".tekton/full-tests.yaml"


class RepositoryLanesTest(unittest.TestCase):
    """The checked-in lanes against upstream's workflow and our pipeline."""

    lanes = lanes_module.load()

    def shards(self):
        return [s for shards in self.lanes.values() for s in shards if s.group != lanes_module.STATIC]

    def test_lanes_run_every_upstream_shard_once(self):
        # An upstream intake that adds a group or changes a shard count fails
        # here until full-test-lanes.txt runs the new shards.
        upstream = lanes_module.upstream_shards(WORKFLOW.read_text())
        self.assertEqual(len(upstream), len(set(upstream)))
        ours = collections.Counter(self.shards())
        self.assertEqual([s for s, n in ours.items() if n > 1], [], "shards in more than one place")
        self.assertEqual(sorted(set(upstream) - set(ours)), [], "upstream shards no lane runs")
        self.assertEqual(sorted(set(ours) - set(upstream)), [], "shards upstream does not have")

    def test_static_checks_run_once(self):
        statics = [lane for lane, shards in self.lanes.items() for s in shards if s.group == lanes_module.STATIC]
        self.assertEqual(len(statics), 1)

    def test_pipeline_starts_every_lane_once(self):
        started = re.findall(r"CI_TEST_LANE=(\S+)", PIPELINE.read_text())
        self.assertEqual(sorted(started), sorted(self.lanes))

    def test_every_lane_plans(self):
        for lane in self.lanes:
            self.assertTrue(lanes_module.plan(self.lanes, lane))


class UpstreamShardsTest(unittest.TestCase):
    def workflow(self, general, serialized):
        return (
            "    strategy:\n"
            "      matrix: ${{ fromJSON(x != '' && toJSON(fromJSON(x).jobs.general_tests.matrix) || '"
            + general + "') }}\n"
            "      matrix: ${{ fromJSON(x != '' && toJSON(fromJSON(x).jobs.verify_serialized_server.matrix) || '"
            + serialized + "') }}\n"
        )

    def test_reads_both_default_matrices(self):
        text = self.workflow(
            '{"include":[{"group":"general-chat","shard_index":0,"shard_count":2,"task":"ci:chat"},'
            '{"group":"general-chat","shard_index":1,"shard_count":2,"task":"ci:chat"},'
            '{"group":"general-workspaces-b","group_label":"workspaces-b","task":"ci:workspaces-b"}]}',
            '{"include":[{"shard_index":0,"shard_count":1,"shard_label":"1/1","task":"ci:serialized"}]}',
        )
        self.assertEqual(lanes_module.upstream_shards(text), [
            Shard("general-chat", 1, 2), Shard("general-chat", 2, 2), Shard("general-workspaces-b"),
            Shard("serialized", 1, 1),
        ])

    def test_missing_matrix_fails(self):
        with self.assertRaisesRegex(ValueError, "verify_serialized_server"):
            lanes_module.upstream_shards(self.workflow('{"include":[]}', "")
                                         .replace("verify_serialized_server", "renamed"))

    def test_entry_without_group_fails(self):
        text = self.workflow('{"include":[{"task":"ci:server"}]}', '{"include":[]}')
        with self.assertRaisesRegex(ValueError, "without a group"):
            lanes_module.upstream_shards(text)


class ParseTest(unittest.TestCase):
    def test_lanes_in_file_order(self):
        lanes = lanes_module.parse(
            "# comment\n\n"
            "2  general-chat  1/3   # trailing\n"
            "1  static\n"
            "2  serialized    2/9\n"
            "1  general-workspaces-b\n"
        )
        self.assertEqual(lanes, {
            "2": [Shard("general-chat", 1, 3), Shard("serialized", 2, 9)],
            "1": [Shard("static"), Shard("general-workspaces-b")],
        })

    def test_rejects_bad_lines(self):
        for line in ("1", "x general-chat", "1 general-chat 0/3", "1 general-chat 4/3",
                     "1 general-chat 1-3", "1 static 1/2", "1 General 1/2", "1 a b c"):
            with self.subTest(line=line), self.assertRaises(ValueError):
                lanes_module.parse(line + "\n")


class CommandTest(unittest.TestCase):
    def test_upstream_commands(self):
        self.assertIsNone(lanes_module.command(Shard("static")))
        self.assertEqual(lanes_module.command(Shard("general-server-without-chat", 1, 12)), [
            "pnpm", "test:run:general", "--", "--group", "general-server-without-chat",
            "--shard-index", "0", "--shard-count", "12"])
        self.assertEqual(lanes_module.command(Shard("serialized", 9, 9)), [
            "pnpm", "test:run:serialized", "--", "--shard-index", "8", "--shard-count", "9"])
        self.assertEqual(lanes_module.command(Shard("general-chat", 3, 3))[-4:], [
            "--shard-index", "2", "--shard-count", "3"])

    def test_only_workspace_groups_cap_workers(self):
        self.assertEqual(lanes_module.command(Shard("general-workspaces-b")), [
            "env", "VITEST_MAX_WORKERS=3", "pnpm", "test:run:general", "--", "--group", "general-workspaces-b"])
        self.assertEqual(lanes_module.command(Shard("general-workspaces-a", 2, 2))[:2],
                         ["env", "VITEST_MAX_WORKERS=3"])
        for shard in (Shard("general-server-without-chat", 1, 12), Shard("general-chat", 1, 3),
                      Shard("serialized", 1, 9)):
            self.assertNotIn("VITEST_MAX_WORKERS=3", " ".join(lanes_module.command(shard)))


class PlanCliTest(unittest.TestCase):
    def run_plan(self, *args):
        return subprocess.run([sys.executable, "-I", str(HERE / "full_test_lanes.py"), *args],
                              capture_output=True, text=True)

    def test_prints_steps_in_order(self):
        result = self.run_plan("plan", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(lines[0], "static")
        label, argv = lines[1].split("\t")
        self.assertEqual(label, "general-server-without-chat 1/12")
        self.assertEqual(argv.split()[:3], ["pnpm", "test:run:general", "--"])

    def test_unknown_lane_fails(self):
        result = self.run_plan("plan", "99")
        self.assertEqual(result.returncode, 2)
        self.assertIn("no lane '99'", result.stderr)

    def test_usage(self):
        self.assertEqual(self.run_plan().returncode, 2)


if __name__ == "__main__":
    unittest.main()
