# Security Policy

## Supported versions

Only the latest tagged release of `dsh-mcp-manager` receives security fixes. Pin an
annotated `vX.Y.Z` tag when installing (for example `dsh plugin add <repo>#v0.13.4`) and
update to the newest tag to pick up fixes.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). This is the only supported private channel;
public issues are not a substitute. Include:

- the affected version/commit;
- a description of the impact;
- reproduction steps or a proof of concept.

You can expect an initial response within 7 days.

## Scope and design notes

- The plugin state file `~/.dsh/mcp-manager.json` stores OAuth tokens and static
  credentials. It is treated as secret-at-rest; reports involving that file should
  describe how a value could leak outside the machine.
- In-GUI diagnostics are redacted on write and never persisted; a report showing a
  token in the logs view, `ctx.logger` output, or a core dump of the state file is in
  scope.
- The stdio transport spawns local processes without shell expansion; command/argument
  injection from a workspace-supplied config is in scope.
- `<workspace>/.dsh/dshmm/mcp.json` is treated as untrusted input: its entries never
  connect until the user approves them, and the approval is bound to a fingerprint of
  the command, args, env, cwd, url, headers and auth fields. Interpreter/loader hooks
  in a server `env` (`NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`,
  `PYTHONPATH`, `BASH_ENV`, …) are stripped. On Windows only `.cmd`/`.bat` shims go
  through `cmd.exe`, and a token containing `"` or `%` is rejected rather than escaped.
  A report showing how an unapproved entry can still execute, or how a changed entry
  can keep its old approval, is in scope.
