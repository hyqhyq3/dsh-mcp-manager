# v0.15.0: OAuth scope selection and insufficient-scope recovery

Upstream PR: <https://github.com/hyqhyq3/dsh-mcp-manager/pull/24> (contributed by
[@mrbeandev](https://github.com/mrbeandev)).

## Behavior

- Scope selection follows the MCP authorization spec: the manual **Scopes**
  field (or a hand-edited `oauth.scope`) → the `scope` in the endpoint's 401
  `WWW-Authenticate` challenge (cached as `oauth.challengeScope`) → the RFC 9728
  protected-resource metadata `scopes_supported` → the RFC 8414 authorization
  server `scopes_supported` → no `scope` parameter. Servers that advertise
  nothing keep the previous wire behaviour exactly.
- `resource` (RFC 8707) continues to ride the authorize and token requests
  whenever the protected-resource metadata names one; discovery caching is
  unchanged.
- An authenticated OAuth request answered with `403` becomes `needs-auth` with an
  *insufficient scope* message instead of a raw `initialize HTTP 403`: every 403
  on `initialize` and a 403 carrying
  `WWW-Authenticate: Bearer error="insufficient_scope"` on `tools/call`, for
  Streamable HTTP, HTTP-with-SSE, and global and workspace servers. There is no
  retry loop; the next authorization is a step-up that adds the challenged
  scopes to the base selection.
- The Settings → MCP row shows the localized message and a **Re-authenticate with
  scopes** button (zh and en). A bare 403 from `tools/call` is still treated as
  that tool's own denial.
- Starting an authorization re-reads a global server's `scope` / `clientId` /
  `clientSecretEnv` / `oauth.scope` from the state file after the in-process
  state-lock queue drains, so hand edits are honoured and cannot be rebased onto
  a state file another save is about to replace.
- Non-secret bookkeeping: `oauth.grantedScope` (what the token grants),
  `oauth.insufficientScope` (what a 403 asked for, cleared by the next token
  grant). No token material is added to logs or diagnostics.

## Review fix (merged on top of the PR)

The PR's step-up merged the challenged scopes with `baseScope`, but
`insufficientScopeError` also cached the **403** challenge scope as
`oauth.challengeScope`, which outranks the advertised scopes. When a server names
only the *missing* scopes (`WWW-Authenticate: Bearer error="insufficient_scope",
scope="posts:write"` while RFC 9728 advertises `mcp:use`), the "merge" became a
replacement: the next authorize asked for `posts:write` alone, failed again, and
the user was trapped clicking re-authenticate. Fixes in this release:

- `captureResourceMetadata` gained `{ cacheScope }`; the 403 path caches only the
  `resource_metadata` pointer, never the challenged scope, so the step-up extends
  the base selection as documented.
- An over-long merged scope string now keeps the base selection instead of
  silently sending no `scope` at all.
- `adoptExternalAuthEdits` waits out the in-process state-lock queue before
  reading disk, so a concurrent save/refresh cannot have its just-saved field
  rebased back to older disk state.
- `test/oauth-scope.test.js` gained the delta-only challenge case (it fails on
  the unpatched PR); `test/client-language.test.js` renders both row shapes in
  both locales and asserts the localized message, the primary button, and that
  the raw host error is not duplicated.

## Verification

Executed on macOS with Node v26.8.2 on 2026-10-30. Every run used scratch `HOME`,
`USERPROFILE`, and `DSH_HOME`; no real profile or credentials were used.

- RED: on the unpatched PR branch the new delta-challenge test fails
  (`7 passed / 1 failed` in `test/oauth-scope.test.js`); before the PR, the same
  file fails against `main@8198ac9` because no scope is requested at all.
- `npm test`: **185 passed**, zero failures, cancellations, or skips
  (75.9 seconds). `main@8198ac9` had 176; the PR added 7 and this release adds
  the delta-challenge and client-rendering cases.
- An end-to-end loopback probe (real `apply()` HTTP API, TryPost-shaped stub)
  with RFC 9728 `scopes_supported: ["mcp:use"]` and a 403 naming only
  `posts:write`: unpatched, the second authorize sent `scope="posts:write"` and
  connect returned to `needs-auth`; patched, it sent
  `scope="mcp:use posts:write"` and the same connect reached `connected`.
- `npm pack --dry-run`: **7 files**, `dsh-mcp-manager@0.15.0`, 90.9 kB; tests
  and docs are not shipped. (Tarball hashes are not reproducible across
  checkouts because npm records source mtimes, so only the extracted contents
  were compared.) The tarball was installed with the official
  `dsh plugin --profile web add <tarball>` CLI into a disposable profile
  (`dsh` 0.2.1-rc.5, scratch `DSH_HOME`); the installed manifest reads 0.15.0
  and both installed `lib` files are byte-identical to the tested source. The
  profile booted on its own port and `GET /mcp-manager/api/ping` returned
  `200 {"ok":true,"version":4,"stdio":true,"workspace":true,"onDemandTools":true}`.

## Boundaries

- A live browser consent round trip through the plugin UI is not verified in
  this run; the authorize requests are exercised through the real API and the
  local stub, and the UI rendering through the client test harness.
- Real providers (Laravel Passport/TryPost, GitHub) are not exercised here — the
  stubs reproduce their topology. Windows is not verified.
- A workspace server that gets `insufficientScope` **mid-session** (from a
  `tools/call`) is recorded on `oauth` but its row still reads `connected` until
  the next reconnect; the connect-time 403 path does flip it to `needs-auth`.
  The manual re-authenticate button remains available (tracked as a follow-up).
- When a 403 advertises no scopes at all and no metadata scope exists, the
  message offers re-authentication but the next authorize still sends no scope;
  such a server needs the **Scopes** field filled in.
- A local 403 classification does not prove a remote scope problem; a bare 403
  on `initialize` is reported as insufficient scope even when the server meant
  something else (the server's own wording is appended to the message).
- The compatibility declarations are unchanged; this does not expand the DSH
  matrix.
