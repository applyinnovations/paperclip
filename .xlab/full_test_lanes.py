"""Lanes of the nightly full test suite (.xlab/full-test-lanes.txt).

  python3 -I .xlab/full_test_lanes.py plan LANE

prints the lane's steps in order, one per line: "static", or a shard's label
and the command that runs it, separated by a tab. ci.sh runs them
(CI_TEST_SCOPE=lane).
"""

import json
import pathlib
import re
import sys
from typing import NamedTuple, Optional

HERE = pathlib.Path(__file__).resolve().parent
LANES = HERE / "full-test-lanes.txt"
STATIC = "static"
SERIALIZED = "serialized"
WORKSPACE_GROUP_PREFIX = "general-workspaces-"
# Upstream runs each general group on a 4-vCPU runner, where Vitest's default
# is 3 workers. The workspace projects set no limit of their own, so on a
# 32-core CI node they would start 31. Only these groups get the variable:
# it overrides every maxWorkers, including the server groups' own.
WORKSPACE_MAX_WORKERS = "3"
# The upstream matrices the lanes must cover (.github/workflows/pr-trusted.yml).
UPSTREAM_MATRICES = ("general_tests", "verify_serialized_server")


class Shard(NamedTuple):
    group: str
    index: Optional[int] = None  # 1-based
    count: Optional[int] = None

    @property
    def label(self):
        return self.group if self.index is None else f"{self.group} {self.index}/{self.count}"


def parse(text):
    """Return {lane: [Shard, ...]} in file order."""
    lanes = {}
    for number, raw in enumerate(text.splitlines(), 1):
        fields = raw.split("#", 1)[0].split()
        if not fields:
            continue
        where = f"full-test-lanes.txt:{number}"
        if len(fields) not in (2, 3) or not fields[0].isdigit():
            raise ValueError(f"{where}: expected '<lane> <group> [<index>/<count>]'")
        lane, group = fields[0], fields[1]
        if not re.fullmatch(r"[a-z][a-z0-9-]*", group):
            raise ValueError(f"{where}: bad group {group!r}")
        shard = Shard(group)
        if len(fields) == 3:
            match = re.fullmatch(r"([1-9][0-9]*)/([1-9][0-9]*)", fields[2])
            if not match or int(match[1]) > int(match[2]):
                raise ValueError(f"{where}: bad shard {fields[2]!r}")
            shard = Shard(group, int(match[1]), int(match[2]))
        if group == STATIC and shard.index is not None:
            raise ValueError(f"{where}: static takes no shard")
        lanes.setdefault(lane, []).append(shard)
    return lanes


def load(path=LANES):
    return parse(pathlib.Path(path).read_text())


def command(shard):
    """The command upstream's CI runs for this shard; None for static."""
    if shard.group == STATIC:
        return None
    if shard.group == SERIALIZED:
        argv = ["pnpm", "test:run:serialized", "--"]
    else:
        argv = ["pnpm", "test:run:general", "--", "--group", shard.group]
    if shard.index is not None:
        argv += ["--shard-index", str(shard.index - 1), "--shard-count", str(shard.count)]
    if shard.group.startswith(WORKSPACE_GROUP_PREFIX):
        argv = ["env", f"VITEST_MAX_WORKERS={WORKSPACE_MAX_WORKERS}", *argv]
    return argv


def plan(lanes, lane):
    if lane not in lanes:
        raise KeyError(f"no lane {lane!r} in full-test-lanes.txt (lanes: {', '.join(lanes)})")
    lines = []
    for shard in lanes[lane]:
        argv = command(shard)
        lines.append(STATIC if argv is None else f"{shard.label}\t{' '.join(argv)}")
    return lines


def upstream_shards(workflow_text):
    """Every shard of upstream's default general and serialized test matrices."""
    shards = []
    for job in UPSTREAM_MATRICES:
        line = next((l for l in workflow_text.splitlines() if f".jobs.{job}.matrix)" in l), None)
        match = line and re.search(r"'(\{\"include\":.*?\})'\)", line)
        if not match:
            raise ValueError(f"no default matrix for {job} in the workflow")
        for entry in json.loads(match[1])["include"]:
            group = entry.get("group", SERIALIZED if entry.get("task") == "ci:serialized" else None)
            if group is None:
                raise ValueError(f"{job}: matrix entry without a group: {entry}")
            if "shard_count" in entry:
                shards.append(Shard(group, entry["shard_index"] + 1, entry["shard_count"]))
            else:
                shards.append(Shard(group))
    return shards


def main(argv):
    if len(argv) != 2 or argv[0] != "plan":
        print(__doc__.strip(), file=sys.stderr)
        return 2
    try:
        lines = plan(load(), argv[1])
    except (KeyError, ValueError) as error:
        print(error.args[0], file=sys.stderr)
        return 2
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
