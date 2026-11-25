# xlab fork operations

`applyinnovations/paperclip` builds the Paperclip that runs on the xlab
cluster. Fork-specific files live only in `.xlab/` and `.tekton/`, so upstream
merges rarely conflict. `.tekton/` follows the xlab CI scripting standard
([Repository pipelines](https://github.com/applyinnovations/deployments/blob/main/clusters/xlab/manifests/tekton/README.md#repository-pipelines)): it only wires Tasks and calls scripts in
`.xlab/`, which hold the logic, run the same locally and have tests. Upstream's GitHub workflows stay in the tree, but
GitHub Actions is disabled for this repository; CI is Tekton Pipelines-as-Code
in the cluster.

## Branches

| Branch | Holds | Who writes |
| --- | --- | --- |
| `master` | exact mirror of `paperclipai/paperclip` master | the nightly intake job, fast-forward only |
| `xlab` (default) | an upstream stable release plus the patches in [PATCHES.md](PATCHES.md) | pull requests only; merge commits; checks required |
| `feat/*`, `fix/*` | one carried change each | you, as a PR into `xlab` |
| `upstream/<tag>` | an upstream stable release being taken in | the intake job |
| `legacy/*` | retired deployment branches, kept so deployed commits stay reachable | nobody (read-only) |

`xlab` is never rebased or force-pushed: every commit that has been deployed
stays reachable from it.

## Before carrying a change

Every carried patch costs a conflict risk at each upstream intake, so pick the
lowest layer that solves the problem:

| Layer | Where the change lives | Fork cost |
| --- | --- | --- |
| 0 | Outside the fork: the agent runtime image (`xlab-containers`), agent hooks, cluster config (`deployments`), a Paperclip plugin | none |
| 1 | A small, additive, config-driven seam (an env var or config key, off by default), such as `PAPERCLIP_K8S_DEFAULT_RESOURCES` | one small patch, offered upstream |
| 2 | A small bug fix in upstream code | one small patch, offered upstream at once |
| 3 | A redesign of an upstream subsystem | not carried: propose it upstream with our evidence, build it only with upstream's agreement |

A carried change (layers 1 and 2) must be generic: it knows nothing about our
companies, namespaces or cluster ([fork-guard](#carrying-a-change) enforces part
of this). Its PATCHES.md row links the upstream PR in *Upstream status*; a row
still "Not yet offered" when the change merges is a follow-up to offer it.

## Carrying a change

1. Branch from `xlab` as `feat/<topic>` or `fix/<topic>`; keep one concern per
   branch.
2. Open a PR into `xlab`. `.tekton/pull-request.yaml` runs `.xlab/ci.sh`
   (frozen install, typecheck, build, and the test files the PR adds or
   changes). The full suite takes about 2 hours on one pod, so
   `.tekton/full-tests.yaml` runs it weekly (Sundays, UTC) on `xlab`; check
   its latest run before shipping. Run the
   PR checks locally with
   `CI_TEST_SCOPE=changed CI_BASE_REF=origin/xlab nix develop ./.xlab --command .xlab/ci.sh`.
   In Tekton, `ci.sh` first makes the nixos/nix image look like upstream's
   Ubuntu runner (FHS loader, the toolchain in `/usr/bin`, an unprivileged
   test user under a child reaper) rather than editing upstream's tests.
   The tests also run without the Nix shell's build variables, and the
   `test-env` step fails if one comes back that the run-failure redactor
   would mask in a test stack (`test-env-guard.mjs`).
   When a test fails only in our CI, fix that environment first.
3. Add or update the change's row in [PATCHES.md](PATCHES.md).
   `tekton-xlab / fork-guard-` (below) fails a PR that changes anything
   outside `.xlab/`, `.tekton/` and `OWNERS` without changing it.
4. If the change is general-purpose, offer it upstream and link the PR. Once
   upstream ships it, the next intake merge carries upstream's version; remove
   ours and its row.

## fork-guard: patches stay generic

Every carried patch must be something upstream could merge: generic,
upstream-quality, and knowing nothing about this deployment. A system checks
that, not a reviewer's memory: `.tekton/fork-guard.yaml` runs
`.xlab/fork_guard.py check` on every pull request into `xlab` as
`tekton-xlab / fork-guard-`. The script and its deny-list come from a
separate checkout of the target branch, never the pull request's, so a pull
request cannot loosen the check it is held to; a change to either applies
from the PR after the one that merges it.

Relative to the PR's merge base with `xlab`, it fails when the PR:

1. **Changes a migration.** Any added, edited or deleted path under
   `packages/db/src/migrations/` (SQL, `meta/_journal.json`, snapshots) must
   then be byte-identical (same blob and mode, or absent in both) to that path
   in the newest upstream stable release (`vX.Y.Z` tag of
   `paperclipai/paperclip`) the PR's head contains. The fork never authors a
   migration: fork state belongs in config, env or plugin storage. An intake
   merge brings upstream's migrations unchanged and passes; a resolution that
   edits one, or a migration copied from upstream `master` before it is
   released, fails.
2. **Adds a deployment name.** An added line (or added file name) outside
   `.xlab/`, `.tekton/` and `OWNERS` containing a term from
   [fork-guard-denylist.txt](fork-guard-denylist.txt), as a whole word in any
   case (`XlabLogin` and `id.xlab.now` match; `UxLab`, `checkboxLabel` and
   `replayable` do not). Lines that upstream's release has in the same file
   are not counted, so an intake of upstream's own "a playable video" passes.
   Only added lines count: existing fixtures that still carry our names do
   not block, until they are cleaned up.
3. **Changes the fork without recording it.** Any change outside `.xlab/`,
   `.tekton/` and `OWNERS` needs `.xlab/PATCHES.md` changed in the same PR
   (add, update or remove the change's row). An upstream intake, a PR whose
   head contains an upstream release `xlab` does not, is exempt: the merge
   brings upstream's changes, and the intake PR is reviewed by its labels.

Run it locally before opening the PR (it fetches upstream's tags into
`refs/fork-guard/upstream-tags/`; `FORK_GUARD_NO_FETCH=1` skips that):

```sh
python3 .xlab/fork_guard.py check origin/xlab HEAD
```

`report` lists every deny-list match in a tree (default `HEAD`) outside
`.xlab/`, `.tekton/` and `OWNERS` that upstream's release does not have, for
the cleanup of existing fixtures. It never fails:

```sh
python3 .xlab/fork_guard.py report origin/xlab
```

Tests: `.xlab/test_fork_guard.py` (run with the other `.xlab` tests in every
PR's checks).

## Taking upstream

Nightly, `.tekton/upstream-intake.yaml` fast-forwards `master`, and when
upstream publishes a new stable release (the GitHub "latest" release) it opens
`upstream/<tag>` → `xlab` as a merge PR. `.xlab/upstream-intake.sh` plans this
without credentials (run it locally to see the plan); the pipeline's publish
task, which holds the GitHub token and the deploy key, pushes
(`.xlab/intake-push.sh`) and opens the PR (`.xlab/intake_pr.py`). It runs
those two scripts from its own checkout of the run's revision, which the plan
task never mounts, so nothing the plan ran can change them. Their tests run in
every pull request's checks:
`python3 -m unittest discover -s .xlab -p 'test_*.py'`.

The publish task pushes `master` and `upstream/<tag>` over SSH with
`paperclip-intake-deploy-key` (tekton-buildkit), a write deploy key for this
repository. Upstream changes `.github/workflows/`, which the Pipelines-as-Code
GitHub App is not allowed to push, and the "master mirrors upstream" ruleset
lets only this deploy key and the App update `master`. GitHub Actions is
disabled on this fork, so those workflow files never run here. The clone and
the pull request use the run's App token.

- No database migration paths changed, no `.tekton/` or `.xlab/` paths
  changed, no conflicts, and every upstream check on the release commit
  passed: auto-merge is enabled, so GitHub merges with a merge commit once
  the required checks pass.
- Otherwise the PR is labelled `needs-review: db-migration`,
  `needs-review: ci-config`, `needs-review: conflict` and/or
  `needs-review: upstream-ci` and waits for a person. Resolve conflicts on the `upstream/<tag>` branch, keeping the
  carried patches.

Upstream runs its full test suite on its own runners and verifies a
release's exact source before publishing it, so the intake trusts those
results (its checks on the release commit) rather than re-running them.
The intake PR's own check runs only the test files that differ from the
release (our patches and the merge resolution; `.xlab/ci.sh`). The weekly
`test-full` run catches what our patches and our CI environment change
elsewhere.

The migration rule is deliberately broad (`migration_re` in the script):
`packages/db/**`, any `migration(s)` or `schema` directory, `*.sql`, and any
path containing `migrat` or `drizzle`. A false positive only costs a review.

Paperclip records applied migrations by content hash, so migrations only on an
old branch are ignored rather than blocking newer ones.

`xlab` is the default branch, so Pipelines-as-Code runs its `.tekton/`, and
those pipelines run `.xlab/` and hold the intake's deploy key. The fork is
public and auto-merges upstream, so a release that touched those paths could
otherwise give upstream our CI credentials; `needs-review: ci-config` stops
that. Upstream has neither directory today.

## Shipping

A push to `xlab` (`.tekton/push.yaml`) asks `applyinnovations/xlab-containers`
to move its `paperclip` input to the new commit. That repo builds the server
and agent images, publishes them to `registry.xlab.now`, and Flux deploys them
through `applyinnovations/xlab-deployments`. Migrations run in the server's
init container; CNPG point-in-time recovery covers a bad one.

## Signing in with Keycloak

The server uses the OIDC sign-in from [doc/OIDC.md](../doc/OIDC.md) with
provider ID `xlab`, so Keycloak's registered callback stays
`/api/auth/callback/xlab`. Sign-up is disabled, and email matching never links
accounts. An existing password user links once:

1. Sign in with email and password.
2. Settings → Profile → Single sign-on: enter the password, select **Link**.
3. Complete the Keycloak sign-in within five minutes in the same session.

After that, use **Sign in with xlab**.

`PAPERCLIP_AUTH_DISABLE_PASSWORD_LOGIN=true` turns off password sign-in on the
server ([doc/OIDC.md](../doc/OIDC.md#oidc-only-sign-in)). Link every
administrator first: an unlinked account cannot sign in. For break-glass, set
the flag to `false` and restart.
