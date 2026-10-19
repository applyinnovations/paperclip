# Fork validation

This fork keeps the full Paperclip PR validation lanes and dependency review.
The PR workflow uses a local reusable workflow on forks. That workflow uses the
local routing workflow. Fork routing falls back to standard GitHub-hosted Linux.
The upstream repository keeps its existing protected caller and bot review.

The fork metadata job runs the existing blocking policy checks and dependency,
release-bootstrap and coauthor notices with a read-only job token. It checks out
the base commit for policy code, reads PR metadata, and reports through its exit
status. It does not generate an app token or post review comments.

Before activation, review and land this CI maintenance change on the fork base
branch so the base checkout contains `run-fork-quality-gates.mjs`. Then enable
only the PR validation workflows and use an opened, reopened or synchronize PR
event. The workflow has no manual dispatch trigger. Record the actual head,
base and merge revisions; an absent check is not a passing check.

Required token permissions are `actions: read`, `contents: read` and
`pull-requests: read`. Do not copy upstream bot keys or grant publish permissions.
Keep release, image publication and other inherited automation inactive unless
separately approved. No workflow is activated by preparing this local change.

The full workflow includes policy, typechecks, general/serialized tests, Runner
lanes, Docker context checks, build, canary dry run and browser tests. A focused
job does not replace those gates. Initial fork runs may be cold because the
existing materialized-cache helper only saves on upstream master pushes.

Greptile is a separate owner-authorized app integration. This workflow neither
installs it nor claims a review score.
