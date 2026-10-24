---
name: sync-upstream
description: Merge upstream oomol-lab/open-connector changes into this Blazorly fork while preserving fork-only customizations. Use when asked to sync from source/upstream, update the fork, or merge upstream changes.
---

# Sync Upstream

Merge the open-source upstream into this fork without losing the Blazorly deployment
customizations. The fork is not a clean mirror: several server features and both Wrangler
configs exist only here, and a careless "take upstream" resolution silently deletes them.

## Remotes

- `origin` — `https://github.com/deepakkumar1984/open-connector.git` (this fork).
- `upstream` — `https://github.com/oomol-lab/open-connector.git` (source of truth for OSS code).

If a remote is missing, add it before syncing. Never push to `upstream`.

## Fork-only surface that must survive every sync

Verify each of these after resolving conflicts. If one is missing, the merge is wrong.

| Area                          | Files                                                                                                                                                         | What must remain                                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blazorly Worker config        | `wrangler.jsonc`, `wrangler.preview.jsonc`                                                                                                                    | Worker names, `connectors.blazorly.com` origins, D1/R2 bindings, hidden exposure, preview action denylist, `run_worker_first: true`, the custom-domain route plus explicit `workers_dev`/`preview_urls` |
| Public exposure gate          | `src/server/cloudflare/public-exposure-gate.ts` (+ test), wiring in `src/server/cloudflare.ts`, `cloudflare-env.ts`, `docs/cloudflare.md`                     | `OOMOL_CONNECT_PUBLIC_EXPOSURE=hidden` hides every path except anonymous `GET /oauth/callback`; empty `404` before `env.ASSETS`                                                                         |
| Connection lifecycle webhooks | `src/server/connection-events.ts`, wiring in `src/oauth/oauth-flow-service.ts`, `connect-app.ts`, `connector-runtime.ts`, `index.ts`, `docs/configuration.md` | `connection.connected` / `connection.failed` delivery, HMAC signature, `OOMOL_CONNECT_WEBHOOK_*`                                                                                                        |
| Custom connection aliases     | `src/server/api/connection-input.ts`, `connection-routes.ts`, `oauth-flow-service.ts`, `docs/programmatic-connections.md`                                     | Optional `connectionName` on OAuth, API-key, and custom-credential requests                                                                                                                             |
| OAuth callback correlation    | `src/oauth/oauth-flow-service.ts` (`CallbackReturnUriSource`, `callbackReturnUri`)                                                                            | `connectionRequestId` always, `appId` on success, in the `returnUri` redirect                                                                                                                           |
| Health identity               | `src/server/connect-server.ts`                                                                                                                                | `GET /v1/health` reports `runtime: "connectors"`                                                                                                                                                        |
| Deploy scripts                | `package.json`                                                                                                                                                | `build:web` uses `npm --prefix web run build`; keep `deploy:cloudflare` and `deploy:cloudflare:preview`                                                                                                 |
| Local env ignore              | `.gitignore`                                                                                                                                                  | `.dev.vars` / `.dev.vars.*` ignored except `.dev.vars.example`                                                                                                                                          |
| Secret-scanner allows         | `src/providers/la_growth_machine/actions.ts`, `src/providers/uniswap_api/runtime.ts`                                                                          | `// gitleaks:allow` annotations on public field/address fixtures                                                                                                                                        |

Fork-specific commits also added `bun.lock`. It coexists with `package-lock.json`; npm is
canonical for the scripts in this repository.

## Procedure

1. Preflight. `git status` must be clean and the current branch is `main`. Stop or stash
   otherwise. Note the current `HEAD` so a bad merge can be reset.
2. Fetch everything, including tags: `git fetch --all --tags --prune`.
3. Back up the branch: `git branch "backup/pre-upstream-merge-$(date +%Y%m%d)" HEAD`.
   If that name exists, append `-2`.
4. Take the fork's own origin commits (usually star-history refreshes) with
   `git merge --ff-only origin/main`. If it is not a fast-forward, inspect before continuing.
5. Merge the source: `git merge upstream/main --no-edit`.
6. Resolve conflicts using the map below. Search for stray markers with
   `git grep -n "<<<<<<<\|>>>>>>>"` before staging.
7. Audit the fork surface. Run every grep in **Verification**; auto-merged files can compile
   while still dropping a fork hook.
8. `npm install`.
9. `npm run fix-check`.
10. If provider definitions or actions changed, run `npm run generate:catalog`, then
    `node scripts/check-action-examples.ts`.
11. `npm test`.
12. Commit with the fork's merge convention:
    `Merge upstream/main (oomol-lab) into deepakkumar1984 fork`, plus the repository's
    attribution trailer. Do not push unless the user asks.

## Conflict map

- `assets/star-history/*` — keep **ours**. The chart describes this fork's stars, not upstream's:
  `git checkout --ours -- assets/star-history && git add assets/star-history`.
- `docs/configuration.md` — keep the fork's `OOMOL_CONNECT_WEBHOOK_*` table rows and the
  "Connection lifecycle webhooks" section, and accept upstream's rows, sections, and changed
  defaults.
- `src/server/connector-runtime.ts` — keep **both** fork and upstream additions passed into
  `createConnectApp`: at minimum `connectionEvents: options.connectionEvents` and
  `network: options.network`.
- `package.json` — upstream normally leaves it alone; when it does change, keep upstream's
  dependency versions and re-apply the fork's three script lines from the table above. Do not
  accept an upstream `deploy` script that replaces `deploy:cloudflare`.
- `src/oauth/oauth-flow-service.ts`, `src/server/api/connection-routes.ts`,
  `src/server/cloudflare.ts`, `src/server/connect-app.ts` — these usually auto-merge. Confirm the
  event dispatcher, `connectionName`, `appId`/`connectionRequestId`, gate calls, and
  `network`/`connectionEvents` options all remain.
- New upstream modules that replace a fork integration point — adapt the fork hook to the new
  API instead of deleting the hook. Example: the guarded-fetch and provider-network-policy
  refactors changed constructor options while keeping the gate and webhook dispatchers valid.

## Verification

```bash
grep -n "shouldHidePublicSurface\|hasValidServiceTokenAsync" src/server/cloudflare.ts
grep -n "connectionEvents" src/server/connect-app.ts src/server/connector-runtime.ts src/server/index.ts
grep -n "connectionName" src/server/api/connection-input.ts src/server/api/connection-routes.ts
grep -n "connectionRequestId\|appId" src/oauth/oauth-flow-service.ts
grep -n 'runtime: "connectors"' src/server/connect-server.ts
node -e 'const p=require("./package.json").scripts; console.log(p["build:web"], p["deploy:cloudflare"], p["deploy:cloudflare:preview"])'
```

All must print matches. Then run `npm run fix-check`, `node scripts/check-action-examples.ts`,
and `npm test`.

## Pitfalls

- **Files can be rewritten outside the merge.** A running editor, task, or dependency updater
  may rewrite `package.json` and `bun.lock` mid-run. Symptoms: the fork's deploy scripts vanish,
  dependency versions change, or tests fail with `package.json ... File is empty`. Restore the
  known-good copy (`git checkout -- package.json bun.lock` during a merge, or
  `git show HEAD:package.json > package.json` after one) and re-run the suite.
- `run_worker_first: true` is required. The array form lets Static Assets serve `/` and the
  console SPA before the Worker runs, bypassing concealment.
- Keep the dashboard-managed custom domain declared in the production config. Without
  `routes: [{ pattern: "connectors.blazorly.com", custom_domain: true }]`, Wrangler reports that
  the local config differs from the remote Worker and a deploy detaches the domain. Adding the
  route also makes Wrangler default `workers_dev`/`preview_urls` to false, so declare both
  explicitly (they are currently enabled remotely) to avoid silently disabling them.
- `src/server/connection-events.ts` is fork-only, so upstream will never update it. Re-check that
  it still compiles against changed shared helpers such as `createGuardedFetch` and
  `isPrivateNetworkAccessAllowed`.
- Do not add a second guarded-fetch implementation, SigV4 signer, or provider error factory to
  make the fork code compile after an upstream refactor. Move the fork code onto the shared owner.
- Line numbers in conflicts move constantly; match on the code fragments and option names above.
- Push only when explicitly asked. Syncing locally is not authorization to publish the merge.
