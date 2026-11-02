# v0.16.0: per-workspace enable/disable for MCP servers

Request: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/27>.

## Behavior

- `<workspace>/.dsh/dshmm/mcp.json` accepts a new `disabled` list of server
  names. It is the per-workspace off switch and covers **both** scopes:
  - a **global** server named there is masked for that workspace's agents (the
    same `tools.restrict({ deny })` path as `exclude`), while its profile-wide
    connection and every other workspace are untouched;
  - a **workspace-local** server named there is never connected or registered in
    that workspace, but its row stays visible with status `disabled` and its
    declaration — plus any OAuth token — is retained, so re-enabling needs
    neither a re-add nor a re-authentication.
- The workspace view gives every row (global and workspace-local) a
  **Enabled in this workspace** switch. A disabled row is dimmed and says
  **Disabled in this workspace**; the profile-wide enable/disable switch stays in
  the global view and is documented as profile-wide.
- New endpoint: `POST /mcp-manager/api/workspaces/server-state`
  `{ path, name, enabled }`. Enabling clears the name from both `disabled` and
  the legacy `exclude`; disabling adds it to `disabled` and removes it from
  `exclude`, so the two lists cannot disagree. Unknown keys in the workspace file
  survive the write, and the same read-modify-write path is shared with the
  existing workspace endpoints.
- `exclude` keeps its existing behaviour (mask a global server in one
  workspace); the UI folds its entries into `disabled` on the next toggle, and a
  name in either list is masked.
- Renaming or deleting a workspace server keeps the list in sync: the new name
  inherits the off state and a deleted name is removed so re-adding it starts
  enabled. A name that is **also** a global server keeps its list entry on
  rename/delete, because the entry may be that global server's mask. The reader
  and every writer share one normalizer (trim + dedupe), so a hand-written
  `" name "` stays toggleable; an emptied `exclude`/`disabled` list is removed
  from the file instead of being rewritten as `[]`.
- Hand edits are hot-reloaded through the existing file watcher. Unknown names in
  `disabled` are ignored and logged only when the list changes; they never
  invalidate the workspace file.
- `GET /mcp-manager/api/workspaces` now returns `disabled` per workspace and a
  `disabled` flag on workspace-local rows (including workspaces that are listed
  from disk but not loaded yet).

## Verification

Executed on macOS with Node v26.8.2 on 2026-11-02. Scratch `HOME`,
`USERPROFILE` and `DSH_HOME`; loopback MCP servers only; no real profile and no
model request.

- `npm test`: **200 passed**, zero failures, cancellations, or skips.
- `test/workspace-disable.test.js` runs the real `apply()` API and covers the
  acceptance criteria: a hand-written `disabled` global masks the tool in that
  workspace only (with `exclude` still behaving the same, and another workspace
  unmasked); a disabled workspace-local server never connects or registers while
  its declaration survives; re-enabling connects it, disables it again, and a
  **new** agent in that workspace also starts without it; the endpoint toggle
  applies to existing agents' registrations/restrictions without reconnecting
  unrelated servers; removing the name by hand is hot-reloaded through the file
  watcher; an unknown `disabled` name is ignored; unknown keys survive the write;
  a registry-only (not yet loaded) workspace projects the disabled row; the
  global-row switch and the local-row switch render in the client test and post
  the documented body; renaming a disabled server keeps it off, deleting one
  clears the stale name, a shared global/local name keeps the mask on
  rename/delete, and a hand-written padded name remains toggleable.
- `test/client-language.test.js` renders both row shapes with the switch, checks
  its accessible name/state, and asserts the endpoint payload; the
  dictionary-parity test covers the three new bilingual strings.
- Disposable-profile runtime: the packed tarball was installed with the official
  `dsh plugin --profile web add` CLI into a scratch profile (DSH `0.2.2-alpha.2`),
  the installed `lib` files are byte-identical to the tested source, the web
  profile answered `GET /mcp-manager/api/ping` → 200, and
  `GET /mcp-manager/api/workspaces` → 200 with an empty list.
- `npm pack --dry-run`: 7 files, `dsh-mcp-manager@0.16.0`; tests, scripts and
  docs are not shipped.

## Boundaries

- The switch was verified through the rendered component tree and the real API,
  not by clicking in a live browser; Windows was not exercised.
- Workspace-scoped OAuth **re-authorization after re-enable** is covered by the
  retained-token design and the existing OAuth tests, but not by a live
  provider round trip in this release.
- The per-workspace switch has no effect on a server that is disabled
  profile-wide (the row shows the profile state and the switch is inert).
- A workspace-local declaration that shares a GLOBAL server's name is a conflict
  row; `disabled: ["name"]` masks that name, which covers both the local
  declaration and the global server. The UI does not split that mask per
  source.
- The compatibility declarations are unchanged; this does not expand the DSH
  matrix.
