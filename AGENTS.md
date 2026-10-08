# AGENTS.md

DSH plugin: MCP server manager for DeepSeek Harness (web profile). Settings → MCP page for HTTP (OAuth PKCE + RFC 7591 dynamic client registration, static Bearer token, or no auth) and local stdio MCP servers, whose tools are registered as `mcp__<name>__<rawName>` native tools.

## Layout

Plugin **source** is two files — keep it that way unless a refactor is explicitly requested (tests live under `test/`):

- `lib/index.js` — **host half** (Node.js): HTTP API on the DSH GUI webserver under `/mcp-manager/api/*`, OAuth flow (redirect receiver at `/mcp-manager/callback/:id`), both MCP transports, tool registration into `ctx.tools`, state persistence.
- `lib/client.js` — **client half** (browser): a `window.__ModuleLoader__.load(...)` factory using `react.createElement` (no JSX, no bundler). Registers the Settings → MCP tab via the `settings.section` slot. **UI is bilingual** (Simplified Chinese and English; follows DSH’s Settings → General → Language preference) — every user-visible string is resolved through `t` from the `mcp` locale namespace, never hardcoded.
- `cordis.patch.yml` — bundle patch that activates the plugin row (`dsh.bundle.patch` in package.json).
- `test/*.test.js` — `node --test` unit tests over the host half's exported helpers plus a stubbed-context `apply()` API smoke test (not shipped: `files` lists only `lib/*`).
- `README.md` / `README.zh-CN.md` — keep both in sync on behavior changes.

## Architecture rules

- Two halves talk only through the same-origin JSON API `/mcp-manager/api/*`; the client never touches Node APIs and the host never renders UI.
- OAuth redirect origin is derived per-request from the `Host` header — never hardcode a host/port. Client registration is bound to the exact redirect URI and re-registers if the origin changes.
- Token state (`~/.dsh/mcp-manager.json`) contains secrets — never log tokens; treat the file as sensitive.
- Tool name convention `mcp__<server>__<raw>` with `[^A-Za-z0-9_-]` → `_` normalization and a 64-char cap (sha256 suffix on overflow) — must match the built-in `@deepseek-ai/dsh-mcp-client`.
- Tool schemas must pass through `sanitizeValue`/`convParams` (registry accepts only a raw JSON-Schema subset; unsupported vocabulary degrades to unconstrained).
- stdio transport: `child_process.spawn`, newline-delimited JSON-RPC over stdin/stdout. Reconnect must reap the old child first; `ctx.effect` teardown kills all children on unload. `args` are quote-aware tokenized with **no shell expansion**. On Windows `shell: true` makes Node join command + args with bare spaces and add no quoting, so every token must pass through `quoteWindowsToken` (idempotent for already-quoted values) or `cmd.exe` truncates paths containing spaces.
- Loaded state is migrated once in `apply()` via `migrateLoadedState`: missing or duplicate `server.id` values are backfilled (live status and `/servers/:id/*` are id-keyed, so a missing id 404s every id-addressed API) and legacy `[{ name, value }]` env/header arrays are normalized to maps. Persist immediately when it reports a change.
- HTTP transport: streamable HTTP (JSON-RPC POST, `Mcp-Session-Id` header, SSE-or-JSON response fallback in `parseRpc`). A 401 triggers one `refresh_token` retry, then reconnect; every 401 also parses `WWW-Authenticate` for `resource_metadata` and caches that URL on `server.oauth`.
- OAuth discovery is ordered, never a single guess: cached/401-advertised RFC 9728 protected-resource metadata (path-inserted, then bare) → its `authorization_servers[0]` → RFC 8414 metadata at the **path-inserted** well-known URL (`wellKnownUrl`), then `openid-configuration`, then the naive `${issuer}/.well-known/oauth-authorization-server`; guessing `${origin}/oauth/*` is the last resort and returns `source: 'fallback'`. `issuerOf` must stay pure (no I/O) because the editor compares issuers across a config edit to decide whether cached OAuth state survives; `server.oauth.authorizationServer` / `server.oauth.resourceMetadataUrl` are the only non-secret discovery caches, and `discoverAndPersist` writes them only when they changed.
- OAuth client credentials: `clientId` (manual, non-secret — skips RFC 7591 entirely and is never re-registered), `clientSecretEnv` (an environment-variable **name** only; the value is read per request and sent as `client_secret` — `client_secret_post` is the only supported method), and `scope` (sent as the `scope` authorization parameter). All three are OAuth-only: switching to `static`/`none`/stdio deletes them, and a changed `clientId`/`clientSecretEnv`/issuer drops `server.oauth`. Validation lives in `parseOauthFields` (pure) + `applyOauthFields`; `sameServerConfig` and both `*View` helpers must carry the fields or workspace edits silently no-op.
- HTTP auth modes are `oauth` | `static` | `none`, normalized in exactly one place (`normalizeAuthMode`). `none` is exempt from the credential gate (`hasToken` → true) and `accessToken` must return `''` for it so a stale attached OAuth token is never sent; switching to `none` in the editor also drops `server.oauth`.
- Disable/enable is global per profile: disable unregisters tools + drops the connection but persists config and tokens; enable reconnects without re-auth.
- Diagnostics are an in-memory `Map<serverId, entry[]>` ring buffer (20 entries/server, ≤500 chars each) written by `recordAttempt` and read by `GET /mcp-manager/api/servers/:id/logs`. Redaction happens **on write**, never on render: query-string `code`/`state`/`client_secret`/`access_token`/`refresh_token` are stripped, `Authorization` values are never stored, and `Bearer …` is masked. Logs are never persisted (a log file would be a new secret-at-rest surface) — the durable record stays `ctx.logger`. Workspace logs survive a rescan because their ids are deterministic (`workspaceServerId`); deleting a server clears its log.
- UI is bilingual: the `mcp` locale namespace holds `zh` and `en` dictionaries with the **same key set** — add new strings to both. Register them with `ctx.effect(() => ctx.locale.register("mcp", { zh, en }), "dsh-mcp-manager: dictionaries")`. The client injects `locale` and declares `@deepseek-ai/dsh-client-locale` in `dsh.client.inject`. Register `settings.section` with `locale: "mcp"`: its component receives the standard `t` prop and passes it to children. Use a bound `t` for the slot label callback. DSH owns language selection (Settings → General → Language), browser fallback, persistence, and live updates. Do not add a plugin language selector, language state, or language API. `GET /settings` exposes only `onDemandToolInjection`; legacy `language` values in the plugin state file remain untouched and unused. Server-supplied diagnostics (MCP error text, tool descriptions) stay in their original language.

## Commands

No build/lint scripts. It's plain ESM with zero dependencies (Node built-ins only; Node `^22.19 || >=24`). `package.json` declares exactly one script, `test`:

```sh
npm test             # = node --test; default discovery picks up test/*.test.js
node --test test/mcp-image-projection.test.js   # single file
```

Verify behavior changes by installing into a live DSH web profile:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <path-or-repo>
```

then restart `dsh --profile web` and reload the page. The API liveness probe is `GET /mcp-manager/api/ping`. Always set both `HOME` and `DSH_HOME` to a scratch directory for `dsh`/`dsh plugin` runs — never let a test touch the real `~/.dsh`.

Optional static audit — [build-dsh-plugin](https://github.com/AI-Scarlett/build-dsh-plugin) is a third-party Agent Skill used as a checklist, not a dependency:

```sh
node <build-dsh-plugin>/build-dsh-plugin/scripts/audit-plugin.mjs "$PWD"
```

Two of its hard blockers are reviewed false positives here and must not be "fixed" by obfuscating the code: the `shell: true` text quoted inside the `spawnStdio` doc comments (the real `spawn` call uses `shell: isWin`, guarded by `quoteWindowsToken`), and the `warn` on the legacy-plaintext path that logs a server *name* and never a credential value. (These anchors drift when code is inserted above them — re-grep before trusting them; as of 0.13.0 they are `lib/index.js:129`, `:1726` and `:803`.) Re-read the flagged lines; treat the *unmet checks* (test script, pinned source, verification/next-gate docs) as real. Runtime points require `--evidence <file>`, a self-reported record — never claim them without a real disposable-profile run.

## Conventions

- No TypeScript, no bundler, no framework — plain modern JavaScript in both files.
- Host half: `ctx.logger` (`info`/`warn`/`error`) with `mcp-manager:` prefix; never `console.log`.
- Client half: `react` obtained via the factory's `require("react")`; styles in the injected `<style>` string using `--dsw-alias-*` CSS variables with hardcoded fallbacks.
- Bump `version` in package.json on user-visible changes (recent history: 0.1.0 OAuth, 0.2.0 stdio, 0.3.0 enable/disable, 0.4.0 Windows stdio + edit + Codex-style HTTP config, 0.5.0 workspace isolation, 0.6.0 on-demand broker, 0.7.0 MCP image-block projection, 0.7.1 legacy-state migration + Windows command quoting, 0.7.2 agent-setup contract + lazy webserver injection, 0.7.3 DSH/Node compatibility matrix, 0.7.4 declared test script + verification/next-gate docs, 0.8.0 zero-dependency lexical tool search + browse fallback, 0.9.0 English UI, 0.10.0 browser language fallback, 0.11.0 DSH locale integration — bilingual `mcp` namespace + injected `t`, 0.12.0 no-auth HTTP mode `authMode: "none"`, 0.13.0 HTTP-with-SSE transport + exponential-backoff reconnect + per-tool concurrency-safety (upstream PR #14) and spec-compliant OAuth discovery (RFC 9728 + RFC 8414) + manual `clientId`/`clientSecretEnv`/`scope` + in-GUI attempt logs).

## Release

Every user-visible change ships as a versioned release: bump the version, sync the docs, commit, then **tag** so consumers can pin `dsh plugin add <repo>#<ref>`. Steps:

1. Bump `version` in `package.json` (semver).
2. Update `README.md` and `README.zh-CN.md` — keep both in sync with the behavior change.
3. Commit on `main`, then create an **annotated** tag on that exact commit and push both:

   ```sh
   git tag -a v0.5.0 -m "dsh-mcp-manager v0.5.0: <one-line summary>"
   git push origin main v0.5.0
   ```

- Tags are **annotated**, not lightweight — match the existing `v0.2.0` style (a `tagger` plus a one-line message).
- The tag must point at the commit that actually carries the release (on `main`).
- Every `vX.Y.Z` gets a tag — never ship a version without one.

## Gotchas

- Changing the client registration/redirect logic requires re-testing a full OAuth round trip — the provider must allow loopback redirects (`http://127.0.0.1:<port>/mcp-manager/callback/<id>`).
- Only `tools` capability is bridged; `resources`/`prompts` are intentionally not.
- Client half is hand-written inside a module factory — no JSX transform available; edit carefully or regenerate deliberately.
