# v0.18.0: workspace trust gate, environment hardening, Windows shell fix

Related: a privately reported workspace auto-execution issue (reported through
GitHub private vulnerability reporting; the advisory stays private until
triage completes). The report described three defects in the workspace
transport path:

1. `agents.create`/`resume` read `<workspace>/.dsh/dshmm/mcp.json` and
   immediately spawned every declared stdio server — opening an untrusted
   repository was enough to execute arbitrary commands, with no prompt or
   allowlist.
2. The same config's `env` was merged over `process.env` unfiltered, so
   `NODE_OPTIONS` and friends turned an otherwise-benign command into
   arbitrary code.
3. On Windows, `shell: true` plus a `\"` quote escape in
   `quoteWindowsToken` let a crafted token break out of the quoted argument
   (`\"` is not an escape in `cmd.exe`).

All three are fixed in this release.

## Changes

- **Workspace trust gate.** A declared entry is *untrusted* until the user
  approves it. `doRescan` keeps the row (status `untrusted`, so Settings can
  offer the approval) but never connects it, never registers its tools, and
  logs one line per transition. `POST /mcp-manager/api/workspaces/trust
  { path, trusted }` backs the new **Approve and connect / 信任并连接** and
  **Revoke approval / 撤销信任** controls in the workspace view; the view
  reports `trusted` and `trustPending` per workspace, and an untrusted row
  also refuses `/workspaces/auth` and a manual `/connect` (409).
- **Approval is content-bound.** The record lives in
  `~/.dsh/mcp-manager.json` under `workspaceTrust[<canonical workspace>]` as
  `{ [name]: { fingerprint, approvedAt } }`. The fingerprint is a SHA-256 over
  the normalized entry's type, command, args, env, cwd, url, auth mode,
  headers, headerEnv, tokenEnv, OAuth client fields and scope (map keys are
  sorted, and the default cwd is canonicalized so a symlinked workspace does
  not lose its approval). Any of those changing asks again; `timeout` and the
  `disabled`/`exclude` switches deliberately do not. Nothing is written into
  the workspace file.
- **Settings writes are consent for their own entry.** `POST/PUT
  /workspaces/servers` approve exactly the entry the user wrote, and switching
  a workspace-local entry on through `/workspaces/server-state` approves it
  too; deleting or renaming drops the old name's record. A hand-injected
  sibling in the same file stays unapproved.
- **Environment hardening.** `spawnEnv` drops interpreter/loader hooks from a
  server's `env` (`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
  `LD_LIBRARY_PATH`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`,
  `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `PYTHONPATH`, `PYTHONSTARTUP`,
  `PERL5LIB`, `PERL5OPT`, `RUBYOPT`, `RUBYLIB`, `BASH_ENV`, `ENV`,
  `SHELLOPTS`) and logs which keys it ignored. This applies to global servers
  as well.
- **Windows spawn.** `spawn(..., { shell: true })` is gone.
  `windowsNeedsShell` resolves a bare command the way cmd does (PATH
  directories, then PATHEXT) and only `.cmd`/`.bat` shims are started through
  `cmd.exe`; `.exe` and everything on POSIX spawn without a shell.
  `buildWindowsCmdLine` quotes each token and rejects `"`, `%`, CR, LF and NUL
  — characters `cmd.exe` cannot be made to treat literally — instead of
  half-escaping them. `windowsShellSpec` wraps the built line in the single
  pair of quotes `cmd.exe /s` unwraps and the spawn call passes
  `windowsVerbatimArguments: true`, so Node cannot re-quote the line (its own
  quoting emits the `\"` cmd does not understand).
- `quoteWindowsToken` is replaced by `buildWindowsCmdLine` /
  `windowsNeedsShell` / `windowsShellSpec` (all exported); the UI gains the
  `untrusted` badge and bilingual strings for the trust bar.

## Verification

- `test/workspace-trust.test.js` (6 tests, real `apply()` API): an unapproved
  entry never connects, registers no tools and refuses a manual connect;
  approving connects and persists the fingerprint; a changed URL withdraws the
  old tools and asks again; a `disabled` edit does not; a Settings-API write
  approves only its own entry; a stdio server's `NODE_OPTIONS` never reaches
  the child (a fixture records the spawned environment).
- `test/legacy-config-migration.test.js` pins the Windows command-line builder
  (quoting, metacharacter quoting, rejection of `"`/`%`/newline), the
  `.cmd`/`.bat` detection (explicit paths, PATH/PATHEXT dir-major order), and
  the `/d /s /c "…"` + verbatim shape of `windowsShellSpec`.
- Full suite: `npm test` → 291 tests, 0 failures.
- `node --check lib/index.js && node --check lib/client.js`.

## Limits

- No browser click-through of the new trust bar was run, and Windows was not
  exercised: the Windows path is covered by unit tests only, as in previous
  releases.
- Existing installations start with every workspace unapproved (fail closed):
  one click per workspace re-enables its servers. This is intentional and not
  migrated, since a repository that was already opened must not be granted
  execution by an upgrade.
- The approval is per entry, not per file: an entry added or edited by a
  repository update asks again, but an entry the user approved and later
  re-enables keeps its approval. That matches the consent the user gave.
