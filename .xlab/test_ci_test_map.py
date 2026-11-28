"""Tests for ci_test_map.py: python3 -m unittest discover -s .xlab -p 'test_*.py'"""

import pathlib
import subprocess
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import ci_test_map  # noqa: E402
from ci_test_map import MapError, glob_regex, parse, select  # noqa: E402

TRACKED = [
    "server/src/services/authorization.ts",
    "server/src/services/access.ts",
    "server/src/services/issues.ts",
    "server/src/__tests__/authorization-service.test.ts",
    "server/src/__tests__/agent-cross-tenant-authz-routes.test.ts",
    "server/src/__tests__/muse-control.test.ts",
    "server/src/__tests__/issues-service.test.ts",
    "server/src/services/native-runtime/authorization-scope.test.ts",
]
RULES = parse(
    "# comment\n"
    "\n"
    "server/src/services/authorization.ts server/src/services/access.ts -> "
    "server/src/**/*authoriz*.test.ts server/src/**/*authz*.test.ts  # trailing\n"
    "server/src/services/authorization.ts -> server/src/__tests__/muse-control.test.ts\n"
)


class GlobTest(unittest.TestCase):
    def test_star_stays_within_a_segment(self):
        self.assertTrue(glob_regex("server/*.ts").match("server/a.ts"))
        self.assertFalse(glob_regex("server/*.ts").match("server/src/a.ts"))

    def test_double_star_spans_zero_or_more_directories(self):
        pattern = glob_regex("server/**/*.test.ts")
        self.assertTrue(pattern.match("server/a.test.ts"))
        self.assertTrue(pattern.match("server/src/__tests__/a.test.ts"))
        self.assertFalse(pattern.match("ui/src/a.test.ts"))

    def test_dots_are_literal_and_the_match_is_whole(self):
        self.assertFalse(glob_regex("a.ts").match("abts"))
        self.assertFalse(glob_regex("a.ts").match("a.tsx"))


class SelectTest(unittest.TestCase):
    def test_changed_source_adds_its_tests_across_rules(self):
        tests, report = select(RULES, ["server/src/services/authorization.ts"], TRACKED)
        self.assertEqual(
            tests,
            [
                "server/src/__tests__/agent-cross-tenant-authz-routes.test.ts",
                "server/src/__tests__/authorization-service.test.ts",
                "server/src/__tests__/muse-control.test.ts",
                "server/src/services/native-runtime/authorization-scope.test.ts",
            ],
        )
        self.assertEqual(len(report), 2)
        self.assertIn("line 3: server/src/services/authorization.ts changed", report[0])

    def test_any_listed_source_fires_the_rule(self):
        tests, _ = select(RULES, ["server/src/services/access.ts"], TRACKED)
        self.assertNotIn("server/src/__tests__/muse-control.test.ts", tests)
        self.assertIn("server/src/__tests__/authorization-service.test.ts", tests)

    def test_unmapped_change_adds_nothing(self):
        self.assertEqual(select(RULES, ["server/src/services/issues.ts"], TRACKED), ([], []))

    def test_source_missing_from_tree_fails_even_when_unchanged(self):
        rules = parse("server/src/services/gone.ts -> server/src/**/*authz*.test.ts\n")
        with self.assertRaisesRegex(MapError, "line 1: source server/src/services/gone.ts"):
            select(rules, [], TRACKED)

    def test_glob_matching_no_test_file_fails(self):
        # A source file matches the glob but is not a test file.
        rules = parse("server/src/services/access.ts -> server/src/services/*.ts\n")
        with self.assertRaisesRegex(MapError, "matches no test file"):
            select(rules, [], TRACKED)

    def test_malformed_rule_fails(self):
        for text in ["server/src/a.ts server/src/a.test.ts\n", " -> a.test.ts\n", "a.ts -> \n"]:
            with self.assertRaises(MapError, msg=text):
                parse(text)


class CommittedMapTest(unittest.TestCase):
    """The map in the repository parses and matches the current tree."""

    def test_committed_map_is_valid_and_selects_muse_control(self):
        root = pathlib.Path(__file__).resolve().parent.parent
        try:
            tracked = subprocess.run(
                ["git", "-C", str(root), "ls-files"], check=True, capture_output=True, text=True
            ).stdout.splitlines()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("not a git checkout")
        rules = parse(ci_test_map.MAP.read_text())
        tests, _ = select(rules, ["server/src/services/authorization.ts"], tracked)
        self.assertIn("server/src/__tests__/muse-control.test.ts", tests)
        self.assertIn("server/src/__tests__/authorization-service.test.ts", tests)


if __name__ == "__main__":
    unittest.main()
