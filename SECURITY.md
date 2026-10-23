# Security Policy

## Supported versions

Only the latest tagged release of `dsh-mcp-manager` receives security fixes. Pin an
annotated `vX.Y.Z` tag when installing (for example `dsh plugin add <repo>#v0.13.4`) and
update to the newest tag to pick up fixes.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security reports.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**), or contact the maintainer via a GitHub issue
requesting a private channel. Include:

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
