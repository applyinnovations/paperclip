# xlab fork operations

`applyinnovations/paperclip` builds the Paperclip that runs on the xlab
cluster. Fork-specific files live only in `.xlab/` and `.tekton/`, so upstream
merges rarely conflict. Upstream's GitHub workflows stay in the tree, but
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

## Carrying a change

1. Branch from `xlab` as `feat/<topic>` or `fix/<topic>`; keep one concern per
   branch.
2. Open a PR into `xlab`. `.tekton/pull-request.yaml` runs `.xlab/ci.sh`
   (frozen install, typecheck, build, and the test files the PR adds or
   changes). The full suite takes 40+ minutes, so `.tekton/full-tests.yaml`
   runs it nightly on `xlab`; check it is green before shipping. Run the
   PR checks locally with
   `CI_TEST_SCOPE=changed CI_BASE_REF=origin/xlab nix develop ./.xlab --command .xlab/ci.sh`.
3. Add or update the change's row in [PATCHES.md](PATCHES.md).
4. If the change is general-purpose, offer it upstream and link the PR. Once
   upstream ships it, the next intake merge carries upstream's version; remove
   ours and its row.

## Taking upstream

Nightly, `.tekton/upstream-intake.yaml` fast-forwards `master`, and when
upstream publishes a new stable release (the GitHub "latest" release) it opens
`upstream/<tag>` → `xlab` as a merge PR. `.xlab/upstream-intake.sh` plans this
without credentials (run it locally to see the plan); the pipeline's publish
task, which holds the GitHub token and runs no repository code, pushes and opens
the PR.

- No database migration paths changed and no conflicts: auto-merge is enabled,
  so GitHub merges with a merge commit once the required checks pass.
- Otherwise the PR is labelled `needs-review: db-migration` and/or
  `needs-review: conflict` and waits for a person. Resolve conflicts on the
  `upstream/<tag>` branch, keeping the carried patches.

The migration rule is deliberately broad (`migration_re` in the script):
`packages/db/**`, any `migration(s)` or `schema` directory, `*.sql`, and any
path containing `migrat` or `drizzle`. A false positive only costs a review.

Paperclip records applied migrations by content hash, so migrations only on an
old branch are ignored rather than blocking newer ones.

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

After that, use **Sign in with xlab** and keep the password for break-glass.
