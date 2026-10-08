# dsh-mcp-manager

[简体中文](README.zh-CN.md) | English

**MCP server manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — a Settings → MCP page where you add MCP servers once (remote HTTP or local stdio process), authenticate HTTP servers with **OAuth in the browser**, and expose their tools either directly or through a compact on-demand broker.

The built-in `@deepseek-ai/dsh-mcp-client` only accepts a static `headers` config — it has no OAuth support and no local stdio transport. This plugin fills that gap:

- **OAuth (authorization code + PKCE)** with spec-compliant discovery, RFC 7591 dynamic client registration, `refresh_token` rotation, and auto-reconnect across restarts — one browser login, then it keeps working.
  - **Discovery** follows RFC 9728 → RFC 8414: the MCP endpoint's 401 `WWW-Authenticate` header names its protected-resource metadata, that document names the authorization server, and the authorization server's metadata is read from the RFC 8414 path-inserted URL (e.g. `https://github.com/.well-known/oauth-authorization-server/login/oauth`). Only when nothing is discoverable does it fall back to guessing `${origin}/oauth/*`, and the attempt log says so.
  - **Manual client credentials** for authorization servers that do not support dynamic registration (GitHub's does not): set **Client ID** to an app you registered with the provider, optionally a **Client secret environment variable** name (sent as `client_secret`; the secret itself is never persisted), and a **Scope** string.
- **Static Bearer token** mode for servers without OAuth — stored as an environment-variable **name** (Codex-style `tokenEnv`), never as plaintext in the config.
- **No auth** mode for servers that need no credentials at all (e.g. a local `http://127.0.0.1:9316/mcp`) — the plugin sends no `Authorization` header and connects on save.
- **Custom HTTP headers** (`headers` for direct values, `headerEnv` for values read from environment variables) — matches Codex's `http_headers` / `env_http_headers`.
- **stdio local processes**: run `npx` / `uvx` / `python` etc. directly; the plugin speaks JSON-RPC over the child's stdin/stdout (spawns the process, reconnects, and reaps it on exit) — no remote server or auth required. Windows `.cmd` shims (e.g. `npx.cmd`) are resolved through `cmd.exe`.
- **HTTP-with-SSE servers**: the legacy SSE transport (a GET event stream that advertises a session endpoint, with replies delivered asynchronously on that stream) is detected automatically and used when a server rejects a plain POST. Streamable HTTP servers are unaffected.
- **Edit-in-place**: rename a server, switch stdio ↔ HTTP, or change auth/headers without deleting and re-adding it.
- **In-GUI diagnostics**: a failed server shows its reason on the collapsed card (no need to expand it), and the expanded card has a **Logs** panel — an on-demand, redacted trace of every discovery URL and HTTP status, client registration, authorization, token exchange/refresh, `initialize`, `tools/list`, and the stderr tail of a stdio child that exited. Secrets (bearer values, `code`/`state`, `client_secret`, tokens) are stripped when the entry is written, never when it is rendered.
- **Tool registration** with the same `mcp__<server>__<rawName>` naming convention as the built-in client, including strict-schema sanitization for the DSH tool registry and `isConcurrencySafe` marking.
- **Workspace isolation**: declare per-project servers in `<workspace>/.dsh/dshmm/mcp.json` — their tools register only into that workspace's sessions, and you can mask specific global servers per workspace.
- **Opt-in on-demand broker**: keep the model-facing MCP surface fixed at `mcp_search_tools`, `mcp_describe_tool`, and `mcp_execute_tool` instead of sending every `mcp__*` schema on every Native-mode request. It is disabled by default. `mcp_search_tools` is a zero-dependency lexical ranker (BM25 + CJK/alias/fuzzy, plus a catalog-listing fallback).
- **Stable tool refresh**: `notifications/tools/list_changed` refreshes only added, removed, or schema-changed registrations for both stdio and Streamable HTTP servers.

The MCP UI follows DSH's language preference in **Settings → General → Language** through the `mcp` locale namespace. DSH owns browser fallback, preference persistence, and live language updates; the plugin has no separate language selector or language API. Labels, forms, status badges, and confirmations are translated; server-supplied diagnostics remain in their original language. Legacy `language` values in `~/.dsh/mcp-manager.json` are ignored and left untouched.

Version 0.11.0 requires `@deepseek-ai/dsh-client-locale` and the slot system's locale `t` prop. The compatibility runs listed below predate this integration and do not verify live locale switching on every listed DSH release. Recheck Settings → MCP while switching DSH's language before deploying to an older web profile.

## Requirements

- DeepSeek Harness, web profile for the Settings → MCP page (`npx @deepseek-ai/dsh web`). On a profile without a GUI webserver (headless/tui) the plugin still registers MCP tools and connects servers — only the settings page is missing.
- Node.js `^22.19` or `>=24`; pnpm on your `PATH`
- Verified DSH releases are declared one by one in `package.json` → `dsh.compatibility.dshReleases` (`0.1.2-rc.1`, `0.1.5-alpha.1`, `0.1.5-alpha.2`, `0.1.5-rc.1` are `compatible`; supported range `>=0.1.2-rc.1 <0.2.0`). Releases that are not listed are untested, not declared broken. These declarations are backed by disposable-profile runs: install into a scratch `$DSH_HOME`, boot the `web` profile (`GET /mcp-manager/api/ping` → 200), boot the `headless` profile and confirm the agent setup applies (on `0.1.5-*` a registered `mcp__<server>__<tool>` is also visible to the agent), then delete the profile — never against a real `~/.dsh`.
- Windows 10/11: stdio commands are launched via `cmd.exe` so `.cmd` shims (`npx`, `uvx`) resolve correctly

## Install

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager
```

Then restart `dsh --profile web` and refresh the page. The package declares a `dsh.bundle.patch`, so the plugin activates automatically — no manual `cordis.patch.yml` editing.

> The MCP server's OAuth provider must allow a loopback redirect (`http://127.0.0.1:<port>/mcp-manager/callback/<id>`), which is where the DSH GUI webserver receives the code. The origin is derived from your browser's own address, so any host/port the GUI is served on works.

## Usage

1. Open **Settings → MCP** in the DSH web UI.
2. **＋ Add MCP server** (and later **编辑 / Edit** to change it):
   - **Scope (作用域)**: `user` — a global server available in every workspace; or `workspace` — a server bound to one workspace (its config lives in that workspace's `.dsh/dshmm/mcp.json`). Pick the workspace from the second dropdown.
   - **HTTP**: name (becomes the `mcp__<name>__*` prefix), URL, auth mode (OAuth, static token, or no auth), and optional headers (`headers` direct values, `headerEnv` values read from env vars). In OAuth mode you can additionally pre-register the client: **Client ID**, **Client secret environment variable**, and **Scope** (all optional).
   - **stdio**: name, command (e.g. `npx`), args (one per row), env vars (key/value rows), and optional working directory.
3. OAuth servers: click **去认证 (Authenticate)** → the browser opens the server's login page → after consent you are redirected back and the tools are registered immediately. If the authorization server advertises a `registration_endpoint` the plugin registers itself (RFC 7591) and you can leave Client ID empty. If it does not — GitHub's `https://github.com/login/oauth` is the common case — register an OAuth App with the provider, paste its **Client ID** (and the **name of the environment variable** holding its secret, if it is a confidential client), set **Scope** to what the MCP endpoint needs (e.g. `repo read:org`), and whitelist `http://127.0.0.1:<port>/mcp-manager/callback/<id>` as the redirect URI there. Without a Client ID the attempt fails with an explanation rather than a bare `HTTP 404`, and the **Logs** panel lists every URL that was tried.
4. Static-token servers: enter the **name of an environment variable** that holds the token (e.g. `MCP_BEARER_TOKEN`) — the token itself is never written to disk; stdio servers spawn and connect immediately on save.
5. No-auth servers: pick **No auth (server needs no credentials)** — the plugin sends no `Authorization` header and connects on save. Use it for an endpoint that authenticates nothing (for example a local `http://127.0.0.1:9316/mcp`).
6. Optional: turn on **On-demand MCP tool calls** at the top of the page. The setting is profile-wide, persists across restarts, and affects existing sessions on their next request.

Status badges: `connected (N tools)` / `needs-auth` / `authorizing` / `error` / `disabled`. Buttons: authenticate, edit, enable/disable (switch), delete. A non-empty error is also shown as a one-line summary under the server name while the card is collapsed, and the expanded card offers **日志 / Logs**. **Disable** unregisters that server's tools and drops its connection (config and OAuth tokens persist); **Enable** reconnects without re-authenticating. Disabled servers stay dormant across restarts. The toggle is global: it affects every session in this profile. State persists at `~/.dsh/mcp-manager.json` (server configs + OAuth client registrations + tokens; static tokens are referenced by env-var name, not stored).

### What the agent sees

With on-demand mode off (the default), every connected server's tools appear as first-class tools, e.g. for a server named `odin`:

```
mcp__odin__search_tools     mcp__odin__describe_tool
mcp__odin__execute_tool     mcp__odin__list_tool_scopes
```

Tool results are projected back as native DSH content blocks; MCP `isError` results surface through the registry's error path. Image blocks (`{ type: 'image', data, mimeType }`) are never forwarded raw — a raw MCP image block has no `attachment`, so it would crash the session on the next turn. Rendering is text-first: when the routed model declares image input, the host stores the image in DSH's durable attachment store and the block becomes a real `{ type: 'image', attachment }`; in every other case (no attachment store, model without image input, non-canonical base64, or a media type outside PNG/JPEG/WebP/GIF) the image degrades to an `[image unavailable: …]` text placeholder. Text blocks are preserved in order, and the same sanitizing applies to results returned through `mcp_execute_tool`.

With on-demand mode on, a Native-mode agent sees only these three MCP broker tools:

- `mcp_search_tools({ query?, server?, limit? })` is a pure-lexical ranked search (no embedding model, no network): NFKC normalization, camelCase/CJK tokenization with a small English stemmer, a built-in bilingual alias table (e.g. `查日志` → `log`/`logs`), BM25 over the tool/server/description fields, and a bounded edit-distance fallback for typos. Omit `query` to list the catalog (optionally `server`-filtered). It returns at most `limit` matches (default 10, clamped to 1-50) plus `total`, the number of results before truncation.
- `mcp_describe_tool({ name })` returns the exact registered description and input schema for one tool visible in that session.
- `mcp_execute_tool({ name, arguments })` executes any currently visible MCP tool through the normal DSH tool pipeline. Calling `describe` first is recommended but not required.

Raw `mcp__*` names are removed from the model request and direct calls to them are denied; only the nested dispatch owned by `mcp_execute_tool` is allowed. Search, describe, and execute all resolve the calling agent's live registry view, so workspace isolation and `exclude` masks remain effective.

### Workspace isolation

Global servers (added in **Settings → MCP**) are visible in every workspace. Use the **workspace dropdown** at the top of the Settings → MCP page to switch between "global" and a specific workspace; when a workspace is selected you see both its own servers and the global servers (with a **隐藏 / Hide** toggle to mask each global server). Workspace servers live in `<workspace>/.dsh/dshmm/mcp.json` (Claude/Codex-style):

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "unity-mcp": { "type": "http", "url": "http://localhost:8090/", "authMode": "static", "tokenEnv": "UNITY_MCP_TOKEN" },
    "local-mcp": { "type": "http", "url": "http://127.0.0.1:9316/mcp", "authMode": "none" }
  },
  "exclude": ["github"]
}
```

- Workspace servers can be **added / edited / deleted in the UI** for workspaces registered in DSH (the **＋** button while a workspace is selected writes to that workspace's `mcp.json`). Hand-editing the file also works — creating or changing it is hot-reloaded. Invalid JSON is shown as an error while the last valid live configuration stays active.
- `type` defaults to `http`; a stdio server's `cwd` defaults to the workspace root. `headers` / `headerEnv` / `env` / `args` follow the same shapes as the Settings form.
- A workspace server's tools register **only** into sessions whose working directory resolves to that workspace; another workspace's agents never see them. Global servers stay visible everywhere unless masked.
- `exclude` lists global servers to hide in this workspace (their tools are masked through the tool registry's per-agent restriction). Toggle it via the **隐藏 / Hide** checkbox on each global server in the workspace view.
- `serverName` must be unique across global + all workspace sources; a later duplicate is flagged as a conflict and skipped (shown in the UI).
- Config is re-read on each new session and hot-reloaded via a file watcher.
- Workspace servers support **stdio**, **HTTP static-token** (`tokenEnv`), **HTTP OAuth** (the same discovery + PKCE + dynamic client registration flow as global servers, including the optional `clientId` / `clientSecretEnv` / `scope` fields in the hand-written config), and **HTTP no-auth** (`authMode: "none"`, no `Authorization` header). Workspace OAuth tokens persist in `~/.dsh/mcp-manager.json` (never in the declarative `mcp.json`); each workspace server row exposes a **去认证 / Authenticate** button for OAuth servers.

## How it works

| Piece | Mechanism |
|---|---|
| Settings page | Client half registers a `settings.section` slot entry (MCP tab) |
| OAuth flow | Host half discovers the authorization server (RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata), then does dynamic client registration (or uses a manually configured Client ID) + PKCE; the redirect lands on a route mounted on the DSH GUI webserver itself |
| OAuth discovery | The MCP endpoint's 401 `WWW-Authenticate` is parsed for `resource_metadata`, which is cached on the server; resource metadata names the authorization server, whose metadata is fetched from the RFC 8414 path-inserted well-known URL (plus an OpenID-configuration and origin-level probe). Guessed `${origin}/oauth/*` endpoints are a last resort, tagged as a fallback |
| Diagnostics | A per-server in-memory ring buffer (last 20 entries) records discovery/register/authorize/token/initialize/tools-list/stdio phases with URL + HTTP status, exposed at `GET /mcp-manager/api/servers/:id/logs`; entries are redacted on write and never persisted (a log file would be a new secret-at-rest surface) |
| Token storage | `~/.dsh/mcp-manager.json`; OAuth tokens refreshed automatically on 401. Static tokens are read from the environment variable named by `tokenEnv`, and an OAuth `client_secret` is read from the environment variable named by `clientSecretEnv` — neither value is ever persisted. No-auth servers store no credential and send no `Authorization` header |
| Legacy state | On load, servers without an `id` are assigned one (and persisted), and legacy `[{ name, value }]` env/header lists are normalized to maps — without this, id-addressed APIs 404 and array env values are dropped silently |
| MCP transport (HTTP) | Streamable HTTP (JSON-RPC over POST, `Mcp-Session-Id`, SSE or JSON responses) with automatic fallback to the legacy HTTP-with-SSE session transport — a GET stream advertises the POST endpoint and delivers replies asynchronously; custom `headers`/`headerEnv` merged into every request |
| Reconnect | A failed connect retries with exponential backoff (3s → 6s → 12s … capped at 60s, reset on success); an SSE session whose stream drops immediately reconnects, and its in-flight calls fail fast instead of blocking until timeout |
| MCP transport (stdio) | `child_process.spawn` a local command, JSON-RPC over stdin/stdout (newline-delimited); reconnect reaps the old process first. On Windows it spawns through `cmd.exe` so `.cmd` shims resolve |
| Tool schema | Server JSON Schemas are sanitized to the registry's supported raw subset (unsupported vocabulary degrades to unconstrained) |
| Image results | `output.render` is text-first; `execute(args, exec)` stages a projection and `finalizeContent` installs durable DSH attachments only when the routed model declares image input — every other case degrades to a text placeholder |
| On-demand broker | A profile setting installs three broker tools, filters raw `mcp__*` schemas after prompt assembly, and guards execution so only `mcp_execute_tool` may dispatch a hidden MCP tool |
| Tool list changes | stdio notifications and the Streamable HTTP SSE channel refresh the live `tools/list`; unchanged registrations remain mounted |
| Workspace isolation | `agents.create`/`resume` are decorated to compose a per-agent setup that registers `<workspace>/.dsh/dshmm/mcp.json` tools into the agent scope and applies `tools.restrict({ deny })` for `exclude` |
| Harness compatibility | The composed agent setup takes the Agent from the setup callback's explicit second argument (DSH 0.1.5-alpha.1 and later) and only falls back to the legacy `agent` context accessor. Newer harness builds removed that accessor, so reading `ctx.agent` there throws `cannot get property "agent" without inject` and fails every `agents.resume`/`create`. The GUI webserver is injected lazily, so a profile without one keeps its MCP tools instead of leaving a pending entry |
| Hot path | Same-origin JSON API under `/mcp-manager/api/*` between the settings page and the host half |

## Verification and next gate

Releases are immutable and tagged, so consumers can pin one:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager#v0.13.0
```

The DSH STORE catalog additionally pins a full 40-character commit instead of a floating branch (release 0.12.0 = `b029407ca3d258e83abac6c06ff94f92e5687164`; the store re-pins the newest release after each push).

What is verified today, and what is not:

| Level | State | How |
|---|---|---|
| Automated (unit + contract) | verified | `npm test` (`node --test`) — host-half exported helpers plus a stubbed-context `apply()` API smoke test. Tests never write to a real `~/.dsh` |
| Disposable-profile runtime | verified | Scratch `$DSH_HOME`: install via the official CLI, boot `web` (`GET /mcp-manager/api/ping` → 200) and `headless` (agent setup applies; on `0.1.5-*` a registered `mcp__<server>__<tool>` is visible to the agent), once per declared `dshReleases` entry, then delete the profile |
| Real profile, store page, public artifacts | not verified here | E4/E5 acceptance is owned by the operator, not by this repository |

For 0.11.0, the locale contract is covered by the stubbed client/API tests. A disposable-profile CLI install succeeded, but the web boot was blocked by the sandbox (`listen EPERM 127.0.0.1:3080`), so live browser language switching remains unverified.

For 0.12.0, the no-auth mode is covered by the stubbed `apply()` API test (an unauthenticated local stub records the `Authorization` header of every request) and by the client-locale test. It has not been exercised in a live profile yet.

For 0.13.0, the HTTP-with-SSE transport, its reconnect/backoff path, and per-tool concurrency safety are covered by `test/sse-basic.test.js`, `test/sse-reconnect.test.js`, and `test/concurrency-safety.test.js`.

For 0.13.0, the discovery chain, manual `clientId`/`clientSecretEnv`/`scope` handling, the no-DCR error path, attempt-log redaction, and the stdio stderr tail are covered by `test/oauth-discovery.test.js`, which runs the real `apply()` API against a local stub server that reproduces the GitHub MCP topology (401 + `resource_metadata` pointer, path-carrying authorization server, no `registration_endpoint`) — plus `test/client-language.test.js` for the collapsed error and the lazily loaded log panel. A real GitHub OAuth round trip is **not** verified: it needs a registered GitHub OAuth App, and the stub stands in for that authorization server. The manual-client path has not been exercised in a live profile.

Next gate: a real-profile readback (resolved version, running process, visible Settings → MCP page) plus, for distribution, an unauthenticated readback of the tagged artifacts. Until those are recorded, read the compatibility declarations as disposable-profile verification only — not as proof of a live installation. The same applies to listing status on DSH STORE.

## Limitations

- `resources` and `prompts` MCP capabilities are not bridged (tools only).
- On-demand filtering currently targets DSH's default `native` presentation. Agents using `code` or `both` keep the full MCP catalog to avoid advertising an incomplete generated SDK or blocking valid Code Mode sub-dispatches.
- OAuth tokens live in a plain JSON file under `~/.dsh` — treat the file as a secret. Static bearer tokens and `headerEnv` values are read from environment variables and never persisted. Workspace OAuth tokens live in the same state file, never in the workspace's `mcp.json`.
- stdio servers run as long-lived child processes tied to the plugin lifecycle. On POSIX `args` are whitespace-tokenized (quotes protect args with spaces) with no shell expansion; on Windows the command line is passed to `cmd.exe`, so shell metacharacters (`&`, `|`, `>`, `%VAR%`) are interpreted — the command and any argument containing whitespace are quoted automatically (already-quoted values are left as-is), but prefer absolute paths.
- One OAuth client registration per server per GUI origin; moving the GUI to a new origin re-registers automatically on the next login. A manually configured Client ID is never re-registered — its redirect URI must already be whitelisted with the provider, so a GUI origin change shows up as a provider-side redirect error rather than an automatic fix.
- Attempt logs are in-memory on the host: they survive a browser refresh but not a DSH restart, and they are capped at 20 entries per server. The durable record remains the DSH server log (`ctx.logger`); the plugin deliberately writes no log file.
- The manual OAuth fields are validated but not proven against a live provider here — `client_secret_post` is the only supported client authentication method (no `client_secret_basic`).

## License

MIT
