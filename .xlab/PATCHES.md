# Carried patches

Everything `xlab` carries on top of its upstream release. One row per change;
remove a row when upstream ships the change and the intake merge replaces ours.

Base: upstream [`v2026.1023.0`](https://github.com/paperclipai/paperclip/releases/tag/v2026.1023.0).

| Change | Branch | Why we carry it | Upstream status |
| --- | --- | --- | --- |
| xlab CI and release plumbing (`.tekton/`, `.xlab/`) | `feat/xlab-ci` ([#5](https://github.com/applyinnovations/paperclip/pull/5)) | Tekton CI, nightly upstream intake, image builds in xlab-containers | Fork-only, never upstreamed |
| Kubernetes provider on agent-sandbox `v1beta1` | `fix/kubernetes-sandbox-v1beta1` ([#4](https://github.com/applyinnovations/paperclip/pull/4)) | The cluster runs agent-sandbox v1.0.7, which serves `agents.x-k8s.io/v1beta1`; upstream still targets `v1alpha1`. Adds a controller-enforced shutdown deadline so orphaned sandboxes are reaped | Not yet offered |
| Native sandbox sync uses the realized directory | `fix/sandbox-sync-remote-cwd` ([#6](https://github.com/applyinnovations/paperclip/pull/6)) | Native file sync reads `remoteCwd` from the lease; without this a fresh or resumed lease can carry a stale sync root | Not yet offered |
| Static OIDC sign-in with explicit account linking | `feat/configurable-oidc-xlab` ([#7](https://github.com/applyinnovations/paperclip/pull/7)), `fix/oidc-link-return-path` ([#11](https://github.com/applyinnovations/paperclip/pull/11)) | Keycloak SSO for paperclip.xlab.now. Replaces the legacy runtime SSO (upstream #3040 plus fixes) with the same identity contract: provider `xlab`, issuer `https://id.xlab.now/realms/xlab`, account key = Keycloak `sub` | Candidate prepared as `feat/static-oidc-upstream`; upstream #3040 and #10411 overlap |
| Claude subscription OAuth for environment drivers | `fix/claude-oauth-sandbox-passthrough` ([#2](https://github.com/applyinnovations/paperclip/pull/2)) | Sandboxed Claude agents authenticate with the shared `CLAUDE_CODE_OAUTH_TOKEN` | Not yet offered |
| GitHub App installation credentials | `feat/github-app-installation-credentials` ([#3](https://github.com/applyinnovations/paperclip/pull/3)) | Agents clone, push and open PRs as `paperclip-xlab-now[bot]` with one-hour tokens; no personal tokens | Not yet offered |
