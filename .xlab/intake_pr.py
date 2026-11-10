#!/usr/bin/env python3
"""Open the upstream intake pull request that intake-push.sh prepared.

Publish half of the nightly upstream intake (.tekton/upstream-intake.yaml):
opens upstream/<tag> -> xlab, labels it and enables auto-merge as the plan
says. Stdlib only; the publish step runs it with `python3 -I` from a separate
checkout of the trusted revision, never from the plan task's workspace.

    intake_pr.py PLAN_DIR PUSHED_TAG_FILE TOKEN_FILE

PLAN_DIR is upstream-intake.sh's output, PUSHED_TAG_FILE what intake-push.sh
left (absent: nothing to open; deleted once read), TOKEN_FILE a GitHub token
that may open pull requests and labels on the fork.
"""

import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

FORK, BASE = "applyinnovations/paperclip", "xlab"
LABELS = [
    "upstream",
    "needs-review: db-migration",
    "needs-review: conflict",
    "needs-review: upstream-ci",
    "needs-review: ci-config",
]
TAG_RE = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+")
BODY_LIMIT = 60000


def read_request(plan, pushed):
    """Return the validated pull request to open, or None if nothing was pushed."""
    if not pushed.exists():
        return None
    tag = pushed.read_text().strip()
    pushed.unlink()
    if not TAG_RE.fullmatch(tag):
        sys.exit("unexpected pushed tag")
    if (plan / "tag").read_text().strip() != tag:
        sys.exit("pushed tag does not match the plan")
    labels = [label for label in (plan / "labels").read_text().splitlines() if label]
    if not set(labels) <= set(LABELS) or "upstream" not in labels:
        sys.exit(f"unexpected labels in plan: {labels}")
    automerge = (plan / "automerge").read_text().strip()
    if automerge not in ("true", "false"):
        sys.exit("unexpected automerge value in plan")
    return {
        "tag": tag,
        "labels": labels,
        "automerge": automerge == "true",
        "body": (plan / "body.md").read_text()[:BODY_LIMIT],
    }


class GitHub:
    def __init__(self, token, api="https://api.github.com"):
        self.token, self.api = token, api

    def __call__(self, method, path, data=None, ok=()):
        request = urllib.request.Request(
            self.api + path,
            method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                if error.code in ok:
                    return None
                detail = error.read()[:500]
            sys.exit(f"{method} {path}: {error.code} {detail!r}")


def publish(request, github):
    tag = request["tag"]
    branch = f"upstream/{tag}"
    owner = FORK.split("/")[0]
    if github("GET", f"/repos/{FORK}/pulls?head={owner}:{branch}&state=all"):
        print(f"a pull request for {tag} already exists")
        return
    for label in LABELS:
        github("POST", f"/repos/{FORK}/labels", {"name": label}, ok=(422,))
    pr = github("POST", f"/repos/{FORK}/pulls", {
        "title": f"Merge upstream {tag} into {BASE}",
        "head": branch, "base": BASE, "body": request["body"]})
    github("POST", f"/repos/{FORK}/issues/{pr['number']}/labels", {"labels": request["labels"]})
    print(f"opened {pr['html_url']}")
    if request["automerge"]:
        # GitHub merges once the ruleset's required checks pass; nothing can skip them.
        result = github("POST", "/graphql", {
            "query": "mutation($id: ID!) { enablePullRequestAutoMerge("
                     "input: {pullRequestId: $id, mergeMethod: MERGE}) { clientMutationId } }",
            "variables": {"id": pr["node_id"]}})
        if result.get("errors"):
            sys.exit(f"auto-merge: {result['errors']}")
        print("auto-merge enabled")


def main(argv):
    if len(argv) != 4:
        sys.exit("usage: intake_pr.py PLAN_DIR PUSHED_TAG_FILE TOKEN_FILE")
    plan, pushed, token_file = (pathlib.Path(arg) for arg in argv[1:])
    request = read_request(plan, pushed)
    if request is None:
        print("no release branch pushed; nothing to open")
        return
    publish(request, GitHub(token_file.read_text().strip()))


if __name__ == "__main__":
    main(sys.argv)
