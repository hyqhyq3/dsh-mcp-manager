# v0.16.1: configurable DCR client name and registration secret

Request: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/28> (Figma MCP).

Figma's `/v1/oauth/mcp/register` answers `403 Forbidden` for any
`client_name` outside an exact allowlist, and its authorization server accepts
only `client_secret_basic` / `client_secret_post` while the plugin sent
`token_endpoint_auth_method: "none"` and discarded the `client_secret` the
registration would return. This release fixes the parts that are the plugin's
responsibility and exposes the part that is the provider's policy.

## Behavior

- **Configurable `client_name` (RFC 7591).** `clientName` is an optional field on
  HTTP OAuth servers, global and workspace. It defaults to
  `dsh-mcp-manager-<server name>`, must be printable ASCII (≤128 chars), is
  validated in `parseOauthFields`, and is carried by both editor views and by
  workspace `mcp.json` (`clientName`). A provider that only registers
  pre-approved names can now be given the name it expects. The plugin never
  substitutes another product's name by default — the fork's `clientName:
  "Claude Code"` workaround is an operator decision, not a shipped default.
- **Registration secret is preserved.** When the authorization server advertises
  `client_secret_post`, the registration request asks for that method (otherwise
  it keeps `none`, the public-client default MCP expects). The `client_secret`
  returned by the registration is stored as `oauth.clientSecret` inside the same
  0600 state file as the tokens and sent as `client_secret` on token exchange and
  refresh. `clientSecretEnv` still wins when configured. The value is never
  returned by a view, an API response or an attempt log (only
  `client_secret issued` is recorded).
- **Re-registration semantics.** An unchanged `client_name` reuses the existing
  registration, including one made before `oauth.clientName` was recorded (so an
  upgrade does not force a re-registration). For a dynamically registered
  client, a changed `client_name` — or a changed GUI redirect origin, or a rename
  that changes the derived default name — replaces the client: the previous
  `client_secret` and token pair are dropped eagerly (they cannot be refreshed
  through the new registration) and the server returns to `needs-auth`. The
  workspace editor mirrors this: changing the dynamic client identity drops the
  stored workspace token slot, while an unchanged save keeps it. A manual Client
  ID never registers, so it is exempt from the name check.
- **Save-time OAuth state fix (found while testing this release).** The settings
  editor invalidated cached OAuth state by comparing the *discovered issuer*
  against the naive origin of the submitted URL, so any authorization server on
  another origin or under a path (GitHub, Figma) lost its registration and tokens
  on every save. The comparison is now the MCP endpoint **origin**, which is what
  discovery — and nothing else — is keyed on. Changing the client id, secret
  source or client name still invalidates the cache, as before.
- `clientName` joins the hand-edited fields adopted from disk before an
  authorization (`scope` / `clientId` / `clientSecretEnv` / `clientName`) and is
  deleted when the auth mode changes to `static` / `none` / stdio.

## Verification

Executed on macOS (Node v26.8.2) on 2026-11-02. Scratch `HOME`,
`USERPROFILE` and `DSH_HOME`; loopback stubs only; no real profile and no model
request.

- `npm test`: **213 passed**, zero failures, cancellations, or skips (200 before
  this release).
- `test/oauth-dcr-client-name.test.js` (13 cases) runs the real `apply()` API
  against a provider-gated stub and covers: the default name with a public client
  that sends no secret; an exact-name allowlist that rejects the default and
  accepts the configured name; `client_secret_post` requested only when
  advertised; the issued secret persisted and sent at exchange and refresh; the
  secret absent from `GET /servers` and `GET /servers/:id/logs`; `clientSecretEnv`
  precedence; re-registration on a name change with the old registration and
  tokens dropped; no re-registration on an unchanged save (which also pins the
  origin-based cache fix); reuse of a pre-0.16.1 registration; malformed-name
  rejection including the 128/129 boundary and non-ASCII; `clientName`
  round-tripping through a workspace `mcp.json` declaration and its projected
  row; a manual Client ID (global and workspace) keeping its tokens when only
  `clientName` changes; a rename that changes the derived default client name
  invalidating the cached registration; a provider error body that echoes the
  `client_secret` being redacted from both the attempt log and the callback page;
  the workspace editor keeping an omitted field, keeping a manual client's token
  slot only while its client identity is unchanged, and dropping a dynamic
  client's slot on a changed name or secret source; a new GUI origin replacing
  the registration without inheriting the old token pair; and a same-origin path
  change keeping the cached pair while a real origin change drops it.
- Differential: the same file against the pre-release `0f41abc` `lib/index.js`
  fails **11 of 13** cases; the two that pass assert preserved behaviour
  (environment secret precedence and pre-0.16.1 registration reuse).
- `test/client-language.test.js` keeps the `mcp` dictionaries balanced and
  asserts the **Client name** input (localized placeholder) renders, updates and
  disappears with the auth mode; `lib/client.js` was syntax-checked.
- Two independent read-only reviews of the final diff found no secret
  serialized into a view, API response or log. They did find four defects, all
  fixed with regression tests before the PR: the workspace `keepOAuth` name
  comparison dropping a manual client's token slot; the workspace PUT erasing
  an omitted field (which then dropped the slot); a rename-derived default
  client name not invalidating the cache; and a JSON-quoted secret in a
  provider error body surviving log/page redaction. A follow-up pass also
  localized the new input's placeholder and replaced a vacuous `/workspaces`
  secret assertion with real coverage.

## Known boundaries

- Cached discovery (`oauth.resourceMetadataUrl` / `oauth.resource`) survives a
  same-origin path change by design — invalidation is origin-scoped — and the
  next 401 refreshes the pointer. Only an endpoint-origin change or a changed
  client identity (`clientId` / `clientSecretEnv` / dynamic `clientName`, or a
  replaced registration) drops the cached registration and tokens; the cached
  issuer is refreshed by discovery, not compared by the editor.
- Redaction masks known credential field names (query string, `key=value`,
  JSON-quoted) and `Bearer` values. A provider echoing a secret under an
  unrelated field name would still be stored verbatim; the plugin itself never
  puts a credential into an error message or a log entry.
- A workspace `mcp.json` hand-edit that changes `clientName` keeps the stored
  token slot until the next authorization re-registers (the editor path drops
  it immediately, like the global editor).

## Not verified

- A real Figma consent + token round trip. The provider gate was reported by the
  issue author (and confirmed for the default name only with `curl` in that
  report); this repository's stub models the allowlist and confidential-client
  behaviour, not Figma's live responses. If Figma's registration endpoint also
  requires the redirect host or another field, the attempt log still records the
  provider's error.
- Windows and a live browser click-through.
- Whether Meta's or Figma's allowlists change over time; `clientName` makes the
  name an operator choice rather than a plugin guess.
