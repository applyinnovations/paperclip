# xlab maintained version

The `xlab` branch in `applyinnovations/paperclip` is the source for the xlab
application image. It does not depend on upstream pull requests being merged.
Deployment changes remain in `applyinnovations/xlab-deployments` and use immutable
image digests. Updating this branch does not itself deploy an application.

## Included changes

The initial baseline is `fa4b7cef20516d32e8756f654e6d506ce7d4fe82`, the source
revision of the deployed image
`registry.xlab.now/paperclip@sha256:c8f4782410eb3c28fadb8c42a2c1fd1e0abb8f914d7c5f0425c395e84623224f`.

- Native OIDC SSO and identity/security fixes from
  https://github.com/nizepart/paperclip/pull/4. Its head at branch creation,
  `28995c1e0f56ed2372076c25e73dd344a7bdf45f`, is an ancestor of the baseline.
- Kubernetes beta sandbox controller compatibility and provider packaging from
  baseline commit `fa4b7cef2`.
- Claude subscription OAuth forwarding from
  https://github.com/applyinnovations/paperclip/pull/2, backported here without
  taking unrelated changes from the fork's newer `master` branch. This adds
  `CLAUDE_CODE_OAUTH_TOKEN` to the environment-driver credential allowlist.

The deployment must select `CLAUDE_CODE_OAUTH_TOKEN` in the Claude adapter
registry's `envKeys`. Keep token values in encrypted deployment Secrets.

- Preserve the provider-realized sandbox directory as lease `remoteCwd` before
  resolving execution transport. Native Kubernetes file sync requires that root;
  the nested workspace-realization record alone is insufficient.

## Maintenance and release

1. Make feature/fix branches from `xlab` and review their changes against `xlab`.
2. Bring upstream updates into a separate integration branch. Preserve the local
   SSO and Kubernetes changes. Remove local patches only after confirming that
   equivalent upstream behavior is included and tested.
3. Run the affected tests, typechecks and builds. Qualify SSO/account linking,
   migrations and Kubernetes credential delivery before releasing an image.
4. Build an image from the exact reviewed commit. Use the Dockerfile's `cloud`
   target with `CLOUD_BUNDLED_PLUGINS=kubernetes` so the Kubernetes provider is
   compiled and included. Set `PAPERCLIP_BUILD_COMMIT` to the full source SHA.
   The plain `production` target does not package that provider.
5. Publish a commit-tagged application image and record its digest. The existing
   Docker workflow publishes master/tag builds to GHCR; it does not automatically
   publish this branch to `registry.xlab.now`. A release pipeline must explicitly
   select this branch, target and provider before it is used for xlab releases.
6. Open a deployment PR that pins the same qualified application digest for the
   server and migration container. Keep agent runtime image upgrades separate.
   Let Flux reconcile only after the deployment PR is merged.

Creating this branch is not release qualification. The first OAuth-enabled image
still needs a full build and tests, followed by deployment acceptance checks.
