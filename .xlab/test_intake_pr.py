"""Tests for intake_pr.py: python3 -m unittest discover -s .xlab -p 'test_*.py'"""

import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import intake_pr  # noqa: E402


class FakeGitHub:
    def __init__(self, existing=None, graphql=None):
        self.calls = []
        self.existing = existing or []
        self.graphql = graphql or {"data": {}}

    def __call__(self, method, path, data=None, ok=()):
        self.calls.append((method, path, data))
        if method == "GET":
            return self.existing
        if path.endswith("/pulls"):
            return {"number": 7, "node_id": "PR_7", "html_url": "https://example/pull/7"}
        if path == "/graphql":
            return self.graphql
        return {}


class ReadRequestTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = pathlib.Path(tmp.name)
        self.plan = self.dir / "plan"
        self.plan.mkdir()
        self.pushed = self.dir / "pushed-tag"
        self.write_plan()

    def write_plan(self, tag="v2026.1106.0", labels="upstream\n", automerge="true", body="body"):
        (self.plan / "tag").write_text(tag + "\n")
        (self.plan / "labels").write_text(labels)
        (self.plan / "automerge").write_text(automerge + "\n")
        (self.plan / "body.md").write_text(body)
        self.pushed.write_text(tag + "\n")

    def test_nothing_pushed_opens_nothing(self):
        self.pushed.unlink()
        self.assertIsNone(intake_pr.read_request(self.plan, self.pushed))

    def test_valid_plan_is_read_and_handoff_consumed(self):
        self.write_plan(labels="upstream\nneeds-review: conflict\n", automerge="false")
        request = intake_pr.read_request(self.plan, self.pushed)
        self.assertEqual(request["tag"], "v2026.1106.0")
        self.assertEqual(request["labels"], ["upstream", "needs-review: conflict"])
        self.assertFalse(request["automerge"])
        self.assertFalse(self.pushed.exists())

    def test_body_is_truncated(self):
        self.write_plan(body="x" * (intake_pr.BODY_LIMIT + 10))
        self.assertEqual(len(intake_pr.read_request(self.plan, self.pushed)["body"]), intake_pr.BODY_LIMIT)

    def test_rejects_inconsistent_or_unexpected_plans(self):
        cases = {
            "tag mismatch": lambda: self.pushed.write_text("v1.2.3\n"),
            "bad pushed tag": lambda: self.pushed.write_text("main\n"),
            "unknown label": lambda: self.write_plan(labels="upstream\nship-it\n"),
            "no upstream label": lambda: self.write_plan(labels="needs-review: conflict\n"),
            "bad automerge": lambda: self.write_plan(automerge="yes"),
        }
        for name, corrupt in cases.items():
            with self.subTest(name):
                self.write_plan()
                corrupt()
                with self.assertRaises(SystemExit) as raised:
                    intake_pr.read_request(self.plan, self.pushed)
                self.assertNotEqual(raised.exception.code, 0)


class PublishTest(unittest.TestCase):
    request = {"tag": "v2026.1106.0", "labels": ["upstream"], "automerge": True, "body": "b"}

    def publish(self, github, **overrides):
        with redirect_stdout(io.StringIO()):
            intake_pr.publish({**self.request, **overrides}, github)

    def test_existing_pull_request_is_left_alone(self):
        github = FakeGitHub(existing=[{"number": 1}])
        self.publish(github)
        self.assertEqual([c[0] for c in github.calls], ["GET"])

    def test_opens_labels_and_enables_auto_merge(self):
        github = FakeGitHub()
        self.publish(github)
        pull = next(c for c in github.calls if c[1].endswith("/pulls"))
        self.assertEqual(pull[2]["head"], "upstream/v2026.1106.0")
        self.assertEqual(pull[2]["base"], "xlab")
        self.assertIn(("POST", "/repos/applyinnovations/paperclip/issues/7/labels", {"labels": ["upstream"]}),
                      github.calls)
        self.assertEqual(github.calls[-1][1], "/graphql")
        self.assertEqual(github.calls[-1][2]["variables"], {"id": "PR_7"})

    def test_review_plan_does_not_auto_merge(self):
        github = FakeGitHub()
        self.publish(github, automerge=False)
        self.assertNotIn("/graphql", [c[1] for c in github.calls])

    def test_auto_merge_error_fails(self):
        with self.assertRaises(SystemExit):
            self.publish(FakeGitHub(graphql={"errors": ["no"]}))


class GitHubClientTest(unittest.TestCase):
    def error(self, code):
        return urllib.error.HTTPError("u", code, "m", {}, io.BytesIO(b"detail"))

    def test_sends_token_and_json(self):
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"ok": true}')
        with mock.patch("urllib.request.urlopen", return_value=response) as urlopen:
            self.assertEqual(intake_pr.GitHub("t0ken")("POST", "/x", {"a": 1}), {"ok": True})
        sent = urlopen.call_args[0][0]
        self.assertEqual(sent.get_header("Authorization"), "Bearer t0ken")
        self.assertEqual(json.loads(sent.data), {"a": 1})

    def test_allowed_error_returns_none_other_errors_fail(self):
        with mock.patch("urllib.request.urlopen", side_effect=self.error(422)):
            self.assertIsNone(intake_pr.GitHub("t")("POST", "/labels", {}, ok=(422,)))
        with mock.patch("urllib.request.urlopen", side_effect=self.error(403)):
            with self.assertRaises(SystemExit) as raised:
                intake_pr.GitHub("t")("POST", "/labels", {}, ok=(422,))
        self.assertIn("403", str(raised.exception.code))
        self.assertNotIn("Bearer", str(raised.exception.code))


if __name__ == "__main__":
    unittest.main()
