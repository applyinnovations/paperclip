#!/usr/bin/env python3
"""Extra test files a pull request runs because of the sources it changes.

    ci_test_map.py BASE_REF

Prints, one per line, the tracked test files that .xlab/ci-test-map.txt adds
for the files changed between BASE_REF and HEAD, and reports on stderr which
rule added them. Exits non-zero when the map is invalid or stale (a source
not in the tree, a glob that matches no test file), so the pull request check
fails instead of silently running fewer tests.
"""

import pathlib
import re
import subprocess
import sys

MAP = pathlib.Path(__file__).resolve().parent / "ci-test-map.txt"
TEST_FILE = re.compile(r"\.test\.(ts|tsx|mts|js|mjs)$")


class MapError(Exception):
    pass


def glob_regex(pattern):
    """Git-style glob: `*` and `?` stay within a path segment, `**/` spans
    any number of directories."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:[^/]+/)*")
            i += 3
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def parse(text):
    """Rules as (line number, sources, test globs)."""
    rules = []
    for number, line in enumerate(text.splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        left, arrow, right = line.partition(" -> ")
        sources, tests = left.split(), right.split()
        if not arrow or not sources or not tests:
            raise MapError(f"line {number}: expected `source... -> test...`")
        rules.append((number, sources, tests))
    return rules


def select(rules, changed, tracked):
    """(tests, report): the tracked test files the rules add for the changed
    paths, sorted, and one line per rule that fired. Raises MapError for a
    stale rule, whether or not it fired."""
    tracked_tests = [path for path in tracked if TEST_FILE.search(path)]
    tracked_set = set(tracked)
    selected = set()
    report = []
    for number, sources, globs in rules:
        source_res = [glob_regex(source) for source in sources]
        for source, source_re in zip(sources, source_res):
            if not any(source_re.match(path) for path in tracked_set):
                raise MapError(f"line {number}: source {source} matches nothing in the tree")
        matches = []
        for pattern in globs:
            pattern_re = glob_regex(pattern)
            hits = [path for path in tracked_tests if pattern_re.match(path)]
            if not hits:
                raise MapError(f"line {number}: {pattern} matches no test file")
            matches.extend(hits)
        triggers = sorted(path for path in changed if any(r.match(path) for r in source_res))
        if triggers:
            added = set(matches) - selected
            selected.update(matches)
            report.append(
                f"ci-test-map line {number}: {', '.join(triggers)} changed; "
                f"adds {len(set(matches))} test files ({len(added)} not already added)"
            )
    return sorted(selected), report


def git_lines(*args):
    result = subprocess.run(["git", *args], check=True, capture_output=True, text=True)
    return [line for line in result.stdout.splitlines() if line]


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    base = argv[1]
    changed = git_lines("diff", "--name-only", "--no-renames", base, "HEAD")
    tracked = git_lines("ls-files")
    try:
        tests, report = select(parse(MAP.read_text()), changed, tracked)
    except MapError as error:
        print(f"::: {MAP.name}: {error}", file=sys.stderr)
        return 1
    for line in report:
        print(f"::: {line}", file=sys.stderr)
    for test in tests:
        print(test)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
