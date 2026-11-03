# dsh-mcp-manager

[简体中文](README.zh-CN.md) | English

> Local **0.13.3 unreleased candidate**: see the [release notes](docs/release-v0.13.3.md) for cumulative changes, provenance and verification limits. It supersedes [0.13.2](docs/release-v0.13.2.md).

**MCP server manager for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — a Settings → MCP page where you add MCP servers once (remote HTTP or local stdio process), authenticate HTTP servers with **OAuth in the browser**, and expose their tools either directly or through a compact on-demand broker.

The built-in `@deepseek-ai/dsh-mcp-client` only accepts a static `headers` config — it has no OAuth support and no local stdio transport. This plugin fills that gap:

- **OAuth (authorization code + PKCE)** with spec-compliant discovery, RFC 7591 dynamic client registration, `refresh_token` rotation, and auto-reconnect across restarts — one browser login, then it keeps working.
  - **Registration identity and secret** (RFC 7591): the `client_name` sent to the registration endpoint is `dsh-mcp-manager-<server>` by default and configurable per server (**Client name**) for providers that gate registration on an exact name. When the authorization server advertises `client_secret_post`, the client registers confidentially: the issued `client_secret` is stored in the 0600 state file and sent on token exchange and refresh (never in a view, response or log). For a dynamically registered client, a changed client name — or a new GUI origin — re-registers and drops the old client's tokens; a manually configured Client ID is unaffected.
  - **Client application type** follows MCP SEP-837: HTTP loopback callbacks (`localhost`, IPv4 loopback, or `[::1]`) register as `native`; other callbacks register as `web`. This avoids OIDC providers defaulting a local GUI to `web` and rejecting its redirect. Registration failures show the provider's OAuth error code when available; the Logs panel retains the detailed reason. Providers may still restrict which clients or redirects they accept.
  - **Callback origin** accepts direct loopback `Host` values (including `[::1]:port`). Configure
    `publicOrigins` for a reverse proxy: one configured origin is the default callback even without
    forwarded headers; with multiple origins, a complete `X-Forwarded-Proto`/`X-Forwarded-Host` pair
    must match the allowlist. A foreign direct Host is rejected when no default is configured.
    Malformed forwarded host values are rejected. Callback messages are HTML-escaped.
  - **Discovery** follows RFC 9728 → RFC 8414: the MCP endpoint's 401 `WWW-Authenticate` header names its protected-resource metadata, that document names the authorization server, and the authorization server's metadata is read from the RFC 8414 path-inserted URL (e.g. `https://github.com/.well-known/oauth-authorization-server/login/oauth`). Only when nothing is discoverable does it fall back to guessing `${origin}/oauth/*`, and the attempt log says so.
  - **RFC 8707 `resource`** taken from the protected-resource document and sent on authorize, token
    exchange and refresh. A server that binds tokens to an audience (Kontrcheck's connector does)
    rejects every step without it as `invalid_target`. Providers that publish no resource keep
    the previous behaviour exactly: nothing is invented.
  - **Manual client credentials** for authorization servers that do not support dynamic registration (GitHub's does not): set **Client ID** to an app you registered with the provider, optionally a **Client secret environment variable** name (sent as `client_secret`; the secret itself is never persisted), and a **Scopes** string. When the provider only accepts pre-approved `client_name` values, set **Client name** rather than letting the default through.
  - **Scope selection** (MCP authorization spec): the authorize request carries `scope` from, in order, the **Scopes** field (or a hand-edited `oauth.scope` in `~/.dsh/mcp-manager.json`), the `scope` in the server's 401 `WWW-Authenticate` challenge, the protected-resource metadata's `scopes_supported` (RFC 9728), then the authorization server's `scopes_supported` (RFC 8414). When none is advertised no scope is sent. `resource=<MCP server URL>` (RFC 8707) goes on both the authorize and token requests whenever the protected-resource metadata names it.
  - **Insufficient scope**: when an authenticated request gets `403` or `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, the server shows *Insufficient scope (scopes)* instead of the raw `initialize HTTP 403`, and offers a **Re-authenticate with scopes** button. The next authorization adds the scopes the server asked for. (On a single `tools/call`, only an explicit `insufficient_scope` triggers this; a bare 403 there is treated as that tool's own denial.)
  - **External edits**: every write re-reads `~/.dsh/mcp-manager.json` under a file lock and merges field by field, so hand edits made while DSH runs are kept. Starting an authorization also re-reads a global server's `scope` / `clientId` / `clientSecretEnv` / `clientName` / `oauth.scope` from disk (workspace servers take those fields from the workspace `mcp.json`).
- **Static Bearer token** mode for servers without OAuth — stored as an environment-variable **name** (Codex-style `tokenEnv`), never as plaintext in the config.
- **No auth** mode for servers that need no credentials at all (e.g. a local `http://127.0.0.1:9316/mcp`) — the plugin sends no `Authorization` header and connects on save.
- **Custom HTTP headers** (`headers` for direct values, `headerEnv` for values read from environment variables) — matches Codex's `http_headers` / `env_http_headers`.
- **stdio local processes**: run `npx` / `uvx` / `python` etc. directly; the plugin speaks JSON-RPC over the child's stdin/stdout (spawns the process, reconnects, and reaps it on exit) — no remote server or auth required. Windows `.cmd` shims (e.g. `npx.cmd`) are resolved through `cmd.exe`.
- **HTTP-with-SSE servers**: the legacy SSE transport (a GET event stream that advertises a session endpoint, with replies delivered asynchronously on that stream) is detected automatically and used when a server rejects a plain POST. Streamable HTTP servers are unaffected.
- **Edit-in-place**: rename a server, switch stdio ↔ HTTP, or change auth/headers without deleting and re-adding it.
- **In-GUI diagnostics**: a failed server shows its reason on the collapsed card (no need to expand it), and the expanded card has a **Logs** panel — an on-demand, redacted trace of every discovery URL and HTTP status, client registration, authorization, token exchange/refresh, `initialize`, `tools/list`, and the stderr tail of a stdio child that exited. Secrets (bearer values, `code`/`state`, `client_secret`, tokens) are stripped when the entry is written, never when it is rendered.
- **Tool registration** with the same `mcp__<server>__<rawName>` naming convention as the built-in client, including strict-schema sanitization for the DSH tool registry and `isConcurrencySafe` marking.
- **Workspace isolation**: declare per-project servers in `<workspace>/.dsh/dshmm/mcp.json` — their tools register only into that workspace's sessions, and every row (global or workspace-local) has a per-workspace **enable** switch that never affects other workspaces.
- **Opt-in on-demand broker**: keep the model-facing MCP surface fixed at `mcp_search_tools`, `mcp_describe_tool`, and `mcp_execute_tool` instead of sending every `mcp__*` schema on every Native-mode request. It is disabled by default. `mcp_search_tools` is a zero-dependency lexical ranker (BM25 + CJK/alias/fuzzy, plus a catalog-listing fallback). Direct tools are hidden with the registry's `deferLoading` marker on DSH 0.2.2 and newer; `0.2.1` and older get the equivalent filter in the system-prompt waterfall.
- **Stable tool refresh**: `notifications/tools/list_changed` refreshes only added, removed, or schema-changed registrations for both stdio and Streamable HTTP servers.

The MCP UI follows DSH's language preference in **Settings → General → Language** through the `mcp` locale namespace. DSH owns browser fallback, preference persistence, and live language updates; the plugin has no separate language selector or language API. Labels, forms, status badges, and confirmations are translated; server-supplied diagnostics remain in their original language. Legacy `language` values in `~/.dsh/mcp-manager.json` are ignored and left untouched.

Version 0.11.0 requires `@deepseek-ai/dsh-client-locale` and the slot system's locale `t` prop. The compatibility runs listed below predate this integration and do not verify live locale switching on every listed DSH release. Recheck Settings → MCP while switching DSH's language before deploying to an older web profile.

## Requirements

- DeepSeek Harness, web profile for the Settings → MCP page (`npx @deepseek-ai/dsh web`). On a profile without a GUI webserver (headless/tui) the plugin still registers MCP tools and connects servers — only the settings page is missing.
- Node.js `^22.19` or `>=24`; pnpm on your `PATH`
- Verified DSH releases are declared one by one in `package.json` → `dsh.compatibility.dshReleases` (`0.1.2-rc.1`, `0.1.5-alpha.1`, `0.1.5-alpha.2`, `0.1.5-rc.1`, `0.2.1-rc.5`, `0.2.2-alpha.2` are `compatible`; supported range `>=0.1.2-rc.1 <0.3.0`). Releases that are not listed are untested, not declared broken. These declarations are backed by disposable-profile runs: install into a scratch `$DSH_HOME`, boot the `web` profile (`GET /mcp-manager/api/ping` → 200), boot the `headless` profile and confirm the agent setup applies (on `0.1.5-*` a registered `mcp__<server>__<tool>` is also visible to the agent), then delete the profile — never against a real `~/.dsh`. From `0.2.2` the model-facing tool list is assembled from the registry after the system-prompt waterfall, so the broker hides direct tools with `deferLoading`; `0.2.1-rc.5` still passes the list through the waterfall and is filtered there. The `0.2.*` entries additionally pass `node scripts/verify-deferral-dsh.mjs <prefix>` (real web profile + mock MCP server, no model request); the `headless` boot was not repeated for them.
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
   - **HTTP**: name (becomes the `mcp__<name>__*` prefix), URL, auth mode (OAuth, static token, or no auth), and optional headers (`headers` direct values, `headerEnv` values read from env vars). In OAuth mode you can additionally pre-register the client: **Client ID**, **Client secret environment variable**, and **Scopes** (all optional; leave Scopes empty to use what the server advertises). **Client name** sets the `client_name` used for dynamic registration (default `dsh-mcp-manager-<name>`) — needed when the provider only registers pre-approved names.
   - **stdio**: name, command (e.g. `npx`), args (one per row), env vars (key/value rows), and optional working directory.
3. OAuth servers: click **去认证 (Authenticate)** → the browser opens the server's login page → after consent you are redirected back and the tools are registered immediately. If the authorization server advertises a `registration_endpoint` the plugin registers itself (RFC 7591) and you can leave Client ID empty. If it does not — GitHub's `https://github.com/login/oauth` is the common case — register an OAuth App with the provider, paste its **Client ID** (and the **name of the environment variable** holding its secret, if it is a confidential client), set **Scopes** to what the MCP endpoint needs (e.g. `repo read:org`), and whitelist `http://127.0.0.1:<port>/mcp-manager/callback/<id>` as the redirect URI there. Without a Client ID the attempt fails with an explanation rather than a bare `HTTP 404`, and the **Logs** panel lists every URL that was tried.
4. Static-token servers: enter the **name of an environment variable** that holds the token (e.g. `MCP_BEARER_TOKEN`) — the token itself is never written to disk; stdio servers spawn and connect immediately on save.
5. No-auth servers: pick **No auth (server needs no credentials)** — the plugin sends no `Authorization` header and connects on save. Use it for an endpoint that authenticates nothing (for example a local `http://127.0.0.1:9316/mcp`).
6. Optional: turn on **On-demand MCP tool calls** at the top of the page. The setting is profile-wide, persists across restarts, and affects existing sessions on their next request.

Status badges: `connected (N tools)` / `needs-auth` / `authorizing` / `error` / `disabled`. Buttons: authenticate, edit, enable/disable (switch), delete. A non-empty error is also shown as a one-line summary under the server name while the card is collapsed, and the expanded card offers **日志 / Logs**. **Disable** unregisters that server's tools and drops its connection (config and OAuth tokens persist); **Enable** reconnects without re-authenticating. Disabled servers stay dormant across restarts. The toggle is global: it affects every session in this profile; the workspace view's per-row switch turns a server off for one workspace only. State persists at `~/.dsh/mcp-manager.json` (server configs + OAuth client registrations + tokens; static tokens are referenced by env-var name, not stored).

### Tool-call timeouts

Since v0.14.0, the add/edit form has an optional **Tool-call timeout (ms)** for
both HTTP and stdio servers, in user and workspace scope. For example, `600000`
allows a simulation tool to run for ten minutes. Clear the input to inherit the
default. The same field works in `<workspace>/.dsh/dshmm/mcp.json`:

```json
{
  "mcpServers": {
    "simulation": {
      "type": "http",
      "url": "http://127.0.0.1:9316/mcp",
      "authMode": "none",
      "timeout": 600000
    }
  }
}
```

Resolution order: server `timeout`, then the plugin row's
`config.toolCallTimeoutMs`, then `60000` milliseconds. Values must be finite and
at least `1000`; numeric strings are accepted and fractions are floored. Invalid,
empty, or missing values are treated as unset. PUT clears the server override
when `timeout` is omitted or invalid. Disabling a server preserves its override.

The override applies only to `tools/call` over stdio, Streamable HTTP, and legacy
HTTP-with-SSE. Initialization, tool listing, and notifications keep their existing
60-second defaults. Timeout errors include the elapsed budget; a client timeout
does not guarantee that a remote server has stopped its work. A surrounding
Code/PTC runtime may impose its own deadline.

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

Raw `mcp__*` names are kept out of the model request and direct calls to them are denied; only the nested dispatch owned by `mcp_execute_tool` is allowed. On DSH `0.2.2` and newer the exclusion is the registry's `deferLoading` marker: the harness preserves it through schema projection and the provider adapter decides whether the request omits the tool (the DeepSeek adapter forwards `defer_loading`, the pi-ai adapter filters it out, and routes without tool-update support send the schema unchanged). The definitions stay registered and executable, so `mcp_execute_tool` still dispatches them. `0.2.1-rc.5` and older pass the tool list through the system-prompt waterfall and are filtered there. Search, describe, and execute all resolve the calling agent's live registry view, so workspace isolation and `exclude` masks remain effective.

Code/PTC/both agents retain their full session-visible MCP catalog, even with
this switch on. On `0.2.2` the broker is not callable from inside a `run_code`
program (the PTC executor only makes `run_code` directly callable), so those
programs call the `mcp__*` tools directly; on `0.2.1-rc.5` the broker stays
callable. Either way the generated SDK is not shrunk. DSH `0.2.0-rc.2` names its modes `native/ptc/both`; `0.2.1-rc.2` supports
`native/ptc`. See [issue #18 investigation and isolated verification](docs/on-demand-code-mode.md)
for the checked interfaces, safe fallbacks, context-cost measurements and test
commands. The local 0.13.3 candidate also keeps this conservative fallback when a custom
prompt empties `tools:sdk` but still exposes `run_code`.

### Workspace isolation

Global servers (added in **Settings → MCP**) are visible in every workspace. Use the **workspace dropdown** at the top of the Settings → MCP page to switch between "global" and a specific workspace; when a workspace is selected you see both its own servers and the global servers, each with a per-workspace **Enabled in this workspace** switch. Workspace servers live in `<workspace>/.dsh/dshmm/mcp.json` (Claude/Codex-style):

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "unity-mcp": { "type": "http", "url": "http://localhost:8090/", "authMode": "static", "tokenEnv": "UNITY_MCP_TOKEN" },
    "local-mcp": { "type": "http", "url": "http://127.0.0.1:9316/mcp", "authMode": "none" }
  },
  "disabled": ["github"]
}
```

- Workspace servers can be **added / edited / deleted in the UI** for workspaces registered in DSH (the **＋** button while a workspace is selected writes to that workspace's `mcp.json`). Hand-editing the file also works — creating or changing it is hot-reloaded. Invalid JSON is shown as an error while the last valid live configuration stays active.
- `type` defaults to `http`; a stdio server's `cwd` defaults to the workspace root. `headers` / `headerEnv` / `env` / `args` follow the same shapes as the Settings form.
- A workspace server's tools register **only** into sessions whose working directory resolves to that workspace; another workspace's agents never see them. Global servers stay visible everywhere unless masked.
- `disabled` is the per-workspace off switch and covers **both** global and workspace-local names. A disabled server registers no tools and never connects in this workspace; other workspaces and the profile-wide state are untouched. Toggle it with the switch on any row in the workspace view — a disabled row stays visible (dimmed, `disabled in this workspace`) so re-enabling is one click. Disabling keeps the declaration and any OAuth token, so re-enabling needs no re-authentication. Hand-editing the list is hot-reloaded; unknown names are ignored (and logged) rather than failing the file. Renaming or deleting a workspace server keeps the list in sync — the new name inherits the off state, and a deleted name is removed so re-adding it starts enabled (a name shared with a global server keeps its entry, because it may be that server's mask).
- `exclude` (legacy) still masks global servers in this workspace through the same per-agent restriction; the UI folds a name into `disabled` on the next toggle and either list masks it. `POST /mcp-manager/api/workspaces/server-state { path, name, enabled }` backs the switch and preserves unknown keys in the file.
- `serverName` must be unique across global + all workspace sources; a later duplicate is flagged as a conflict and skipped (shown in the UI). A conflict is re-derived when the blocking global server is deleted or renamed, so the workspace entry connects on its own instead of waiting for a `mcp.json` edit.
- Config is re-read on each new session and hot-reloaded via a file watcher.
- Workspace connection failures retry automatically after 3s, 6s, 12s, up to 60s; a successful connection resets the delay. SSE session loss reconnects immediately and refreshes tools for existing agents. Credential-gated servers remain `needs-auth`. Editing/deleting a server, closing its last session, or unloading the plugin cancels pending retries.
- Workspace **Logs** work for every row, not just loaded ones: ids are deterministic (`ws-<sha256(workspace+name)[0:20]>`), so a row listed from disk keeps the same id after it is loaded, and `GET /mcp-manager/api/servers/:id/logs` returns 200 for loaded, conflict and not-yet-loaded rows alike. `POST .../connect` reconnects loaded rows, answers 409 for a conflict row (`server name is taken by another server`), and 404 when nothing is loaded for that id. Logs retain redacted failure causes (such as `ECONNREFUSED`) across config rescans; deleting the server clears them.

Recovery regression tests run with `node --test test/workspace-reconnect.test.js`. For an opt-in real Loader smoke, install `@deepseek-ai/dsh@0.2.1-rc.2` into a disposable npm prefix, then run `node scripts/verify-real-dsh.mjs <prefix>`. The script creates and deletes its own temporary profile and workspace, uses loopback MCP only, and submits no model request. Verified on macOS / Node 24.12.0; Windows remains unverified.
- Workspace servers support **stdio**, **HTTP static-token** (`tokenEnv`), **HTTP OAuth** (the same discovery + PKCE + dynamic client registration flow as global servers, including the optional `clientId` / `clientSecretEnv` / `clientName` / `scope` fields in the hand-written config), and **HTTP no-auth** (`authMode: "none"`, no `Authorization` header). Workspace OAuth tokens persist in `~/.dsh/mcp-manager.json` (never in the declarative `mcp.json`); each workspace server row exposes a **去认证 / Authenticate** button for OAuth servers.

## How it works

In v0.13.4, pre-registered OAuth clients reuse the configured Client ID for both
token exchange and refresh; client secrets are read from their configured
environment variable for each grant. Global connections discard handshakes and
failures that finish after disable, delete, edit, or plugin unload, so stale
attempts cannot restore tools or clear a newer connection.

| Piece | Mechanism |
|---|---|
| Settings page | Client half registers a `settings.section` slot entry (MCP tab) |
| OAuth flow | Host half discovers the authorization server (RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata), then does dynamic client registration (or uses a manually configured Client ID) + PKCE; the redirect lands on a route mounted on the DSH GUI webserver itself |
| OAuth discovery | The MCP endpoint's 401 `WWW-Authenticate` is parsed for `resource_metadata`, which is cached on the server; resource metadata names the authorization server, whose metadata is fetched from the RFC 8414 path-inserted well-known URL (plus an OpenID-configuration and origin-level probe). Guessed `${origin}/oauth/*` endpoints are a last resort, tagged as a fallback |
| Diagnostics | A per-server in-memory ring buffer (last 20 entries) records discovery/register/authorize/token/initialize/tools-list/stdio phases with URL + HTTP status, exposed at `GET /mcp-manager/api/servers/:id/logs`; entries are redacted on write and never persisted (a log file would be a new secret-at-rest surface) |
| Token storage | `~/.dsh/mcp-manager.json`; OAuth tokens refreshed automatically on 401. Static tokens are read from the environment variable named by `tokenEnv`, and an OAuth `client_secret` is read from the environment variable named by `clientSecretEnv` when one is configured — otherwise a `client_secret` issued by a confidential (`client_secret_post`) dynamic registration is used, stored in the same 0600 state file as the tokens and never returned by an API or written to a log. A public-client (`none`) registration never presents the secret it was issued, and a manual Client ID never reuses one. No-auth servers store no credential and send no `Authorization` header |
| Refresh safety | Refresh is single-flight per process and serialized across DSH processes that share the state file: a shared lock covers refresh and all configuration writes, with FIFO ownership within each process so queued saves cannot overtake each other. A re-read adopts the latest disk pair even when its access token has expired, and changed-field merging preserves other processes’ server/workspace tokens. Stale locks are reclaimed only for dead or incomplete owners; live owners are never evicted by age. Reclamation is itself exclusive; an orphaned `.refresh.lock.reclaim` guard after a crash requires operator inspection/removal before stale recovery resumes (writes time out rather than steal a lock). The state file is replaced atomically (0600, fsync + rename). If a rotated pair cannot be persisted, that process keeps its access token but stops further refreshes until successful reauthorization; repair the state path before reauthorizing. An `invalid_grant` marks the server `needs-auth` and stops replaying the spent token. `/api/servers` reports `oauth.expiresAt`, `needsReauth`, `lastRefreshAt`, `lastRefreshError`, `lastToolOkAt` — timestamps and error codes only, never token material |
| Legacy state | On load, servers without an `id` are assigned one (and persisted), and legacy `[{ name, value }]` env/header lists are normalized to maps — without this, id-addressed APIs 404 and array env values are dropped silently |
| MCP transport (HTTP) | Streamable HTTP (JSON-RPC over POST, `Mcp-Session-Id`, SSE or JSON responses) with automatic fallback to the legacy HTTP-with-SSE session transport — a GET stream advertises the POST endpoint and delivers replies asynchronously; custom `headers`/`headerEnv` merged into every request |
| Reconnect | Startup uses the existing immediate connection path; disabling or deleting a server does not queue a second delayed restore. A failed connect retries with exponential backoff (3s → 6s → 12s … capped at 60s, reset on success); an SSE session whose stream drops immediately reconnects, and its in-flight calls fail fast instead of blocking until timeout |
| MCP transport (stdio) | `child_process.spawn` a local command, JSON-RPC over stdin/stdout (newline-delimited); reconnect reaps the old process first. On Windows it spawns through `cmd.exe` so `.cmd` shims resolve |
| Tool schema | Server JSON Schemas are sanitized to the registry's supported raw subset (unsupported vocabulary degrades to unconstrained) |
| Image results | `output.render` is text-first; `execute(args, exec)` stages a projection and `finalizeContent` installs durable DSH attachments only when the routed model declares image input — every other case degrades to a text placeholder |
| On-demand broker | A profile setting installs three broker tools; on DSH `0.2.2+` raw `mcp__*` definitions stay registered with `deferLoading` (the provider adapter hides them), older harnesses filter the system-prompt waterfall; an execution guard admits only `mcp_execute_tool` (and PTC programs, whose executor owns prompt sections) |
| Tool list changes | stdio notifications and the Streamable HTTP SSE channel refresh the live `tools/list`; unchanged registrations remain mounted |
| Workspace isolation | `agents.create`/`resume` are decorated to compose a per-agent setup that registers `<workspace>/.dsh/dshmm/mcp.json` tools into the agent scope and applies `tools.restrict({ deny })` for `exclude`/`disabled` global names; a `disabled` workspace-local server stays declared but is neither connected nor registered |
| Harness compatibility | The composed agent setup takes the Agent from the setup callback's explicit second argument (DSH 0.1.5-alpha.1 and later) and only falls back to the legacy `agent` context accessor. Newer harness builds removed that accessor, so reading `ctx.agent` there throws `cannot get property "agent" without inject` and fails every `agents.resume`/`create`. The GUI webserver is injected lazily, so a profile without one keeps its MCP tools instead of leaving a pending entry |
| Hot path | Same-origin JSON API under `/mcp-manager/api/*` between the settings page and the host half |

## Verification and next gate

Releases are immutable and tagged, so consumers can pin one:

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager#v0.16.1
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

For v0.15.0, `test/oauth-scope.test.js` covers the scope-selection order
(configured → 401 challenge → RFC 9728 → RFC 8414 → none), `resource` on the
authorize and token requests, recovery from a bare 403 and from
`insufficient_scope` on both transports, and the case where the 403 challenge
names only the missing scopes — the step-up must extend the advertised base, not
replace it. `test/client-language.test.js` renders the localized
insufficient-scope message and the **Re-authenticate with scopes** button for
the global and workspace row shapes in both locales. A real
TryPost/Laravel-Passport browser consent round trip and Windows remain
unverified; see [v0.15.0 verification](docs/release-v0.15.0.md). This does not
expand the compatibility matrix.

For v0.15.1, `test/on-demand-deferral.test.js` reproduces the DSH 0.2.2
breakage (the waterfall no longer carries `tools`) and covers the `deferLoading`
marking, the toggle re-registration, the per-agent dispatch admission and both
`ctx.tools.execute()` shapes. `node scripts/verify-deferral-dsh.mjs <prefix>`
boots the real web profile with a mock MCP server and no model request on
`0.2.2-alpha.2` (registry assembly, marked deferred) and on `0.2.1-rc.5`
(waterfall filter); both pass and record which contract they observed. What a
provider actually does with a deferred tool is provider-side and unverified
here (no model request): the DeepSeek adapter forwards `defer_loading`, the
pi-ai adapter filters. Windows and pre-0.2 harnesses were not re-run. See
[v0.15.1 verification](docs/release-v0.15.1.md). This does not expand the
compatibility matrix beyond the two tested entries.

For v0.16.0, `test/workspace-disable.test.js` covers the per-workspace
`disabled` list end to end over the real `apply()` API: masking a global server
in one workspace only (with `exclude` unchanged), a disabled workspace-local
server that stays declared but never connects or registers, the
`/workspaces/server-state` toggle applying to existing **and** new agents of that
workspace, hot reload after a file edit, an unknown name being ignored, and
unknown keys surviving the write. `test/client-language.test.js` renders the
switch for both row shapes and asserts the endpoint contract; the bilingual
dictionary parity test covers the new strings. A live browser click-through and
Windows remain unverified; see [v0.16.0 verification](docs/release-v0.16.0.md).
This does not expand the DSH compatibility matrix.

For v0.16.1, `test/oauth-dcr-client-name.test.js` runs the real `apply()` API
against a provider-gated stub: the default `client_name` is used and a public
client sends no secret; a configured **Client name** passes an exact-name
allowlist that rejects the default; `client_secret_post` is requested only when
the authorization server advertises it; the issued registration secret is
persisted, sent at token exchange and refresh, and absent from every API view
and attempt log; a secret issued by a `none` registration is stored but never
presented, and a manual Client ID does not replay a stored registration secret;
a long provider error body that echoes the secret past the truncation cutoff is
redacted before truncation; an environment-variable secret source wins over it;
a changed client name re-registers and drops the old client's tokens; a pre-0.16.1
registration is still reused; malformed names are rejected; and a workspace
`mcp.json` declaration round-trips `clientName`. It also pins the save-time
regression found here: an unchanged save no longer drops cached OAuth state when
the discovered authorization server sits on another origin or under a path
(GitHub, Figma), a same-origin path change keeps the pair while a real origin
change drops it, a rename that changes the derived default name re-registers, a
new GUI origin replaces the registration without inheriting the old token pair,
and a provider error body echoing the secret is redacted from the attempt log
and the callback page. A real Figma consent/token round trip remains unverified;
see [v0.16.1 verification](docs/release-v0.16.1.md). This does not expand the
DSH compatibility matrix.

Next gate: a real-profile readback (resolved version, running process, visible Settings → MCP page) plus, for distribution, an unauthenticated readback of the tagged artifacts. Until those are recorded, read the compatibility declarations as disposable-profile verification only — not as proof of a live installation. The same applies to listing status on DSH STORE.

For v0.14.0, `test/tool-timeout.test.js` covers budget validation, large-timer
overflow, configuration round trips, workspace rescans, and actual timeout and
success paths over all three transports. The client test covers both locales,
transports, and scopes. `node scripts/verify-timeout-dsh.mjs <prefix>` runs the
real DSH 0.2.1-rc.2 Loader, agents, tool registry, and native-mode broker against
loopback MCP fixtures: all three transports and the broker complete 61-second
calls with a 65-second budget, then clearing overrides restores the tested
one-second profile default. The assembled results are checked against a keyless
snapshot. See [v0.14.0 verification](docs/release-v0.14.0.md) for evidence and
remaining platform boundaries. This does not expand the compatibility matrix.

## Limitations

- `resources` and `prompts` MCP capabilities are not bridged (tools only).
- On-demand filtering targets `native` presentation. Code/PTC/both agents keep the full session-visible MCP catalog; their presentation is read from the executor's prompt sections (and, on harnesses that still supply one, from the waterfall payload). Exported SDK renderers provide no presentation-only catalog contract; see the [interface evidence and fallbacks](docs/on-demand-code-mode.md). Full SDK compression remains open in [#18](https://github.com/hyqhyq3/dsh-mcp-manager/issues/18).
- OAuth tokens live in a plain JSON file under `~/.dsh` — treat the file as a secret. Static bearer tokens and `headerEnv` values are read from environment variables and never persisted. Workspace OAuth tokens live in the same state file, never in the workspace's `mcp.json`.
- stdio servers run as long-lived child processes tied to the plugin lifecycle. On POSIX `args` are whitespace-tokenized (quotes protect args with spaces) with no shell expansion; on Windows the command line is passed to `cmd.exe`, so shell metacharacters (`&`, `|`, `>`, `%VAR%`) are interpreted — the command and any argument containing whitespace are quoted automatically (already-quoted values are left as-is), but prefer absolute paths.
- One OAuth client registration per server per GUI origin; moving the GUI to a new origin re-registers automatically on the next login, and changing the configured **Client name** re-registers with the new name (the old client's tokens are dropped, so a re-authorization is required). A manually configured Client ID is never re-registered — its redirect URI must already be whitelisted with the provider, so a GUI origin change shows up as a provider-side redirect error rather than an automatic fix.
- Attempt logs are in-memory on the host: they survive a browser refresh but not a DSH restart, and they are capped at 20 entries per server. The durable record remains the DSH server log (`ctx.logger`); the plugin deliberately writes no log file.
- The manual OAuth fields are validated but not proven against a live provider here — `client_secret_post` is the only supported client authentication method (no `client_secret_basic`). Some providers (Meta, Figma) gate dynamic registration on a `client_name` allowlist; setting **Client name** is the supported path, but the plugin deliberately does not ship another product's name as a default. A registration-issued `client_secret` is stored in `~/.dsh/mcp-manager.json` (0600) like the tokens; it is never returned by the API or written to a log, and it is presented only by a registration that asked for `client_secret_post` — never with a manual Client ID.

## License

MIT
