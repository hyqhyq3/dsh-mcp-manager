# v0.14.0: configurable tool-call timeouts

Issue: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/23>

## Behavior

- Optional per-server `timeout` in milliseconds, for global and workspace
  servers, including the bilingual Settings form and hand-written `mcp.json`.
- Resolution: server `timeout` -> plugin row `config.toolCallTimeoutMs` -> 60000.
  Finite numbers/numeric strings >=1000 are floored; invalid values are unset.
- Applies to `tools/call` on stdio, Streamable HTTP, and legacy HTTP-with-SSE.
  Initialization, tool listing, and notifications retain their existing budgets.
- PUT omission/invalid input clears the override. Disable preserves it.
  Workspace timeout-only edits trigger reconnection. Both API views return it.
- Timeout errors include the actual budget. Bounded timer chaining avoids Node's
  >2147483647ms overflow-to-1ms behavior and supports cancellation/unref cleanup.

## Verification

Executed on macOS with Node v26.8.2 on 2026-10-26. All DSH processes use scratch
`HOME`, `USERPROFILE`, and `DSH_HOME`; no real profile or credentials are used.

- RED: the normalization and API tests failed before implementation (helper
  missing; configured timeout absent from the returned server).
- `npm test`: 176 passed, zero failures, cancellations, or skips (75.5 seconds).
  Includes real loopback transports, a spawned Node stdio server, delayed
  initialize/tools-list responses, profile fallback, per-server precedence,
  global/workspace persistence and clearing, hot rescan, GUI payloads in both
  locales/scopes/transports, and a mocked-clock large-timer regression.
- `node scripts/verify-timeout-dsh.mjs <temporary-npm-prefix> <evidence.json>`:
  real `@deepseek-ai/dsh@0.2.1-rc.2` Loader + agents + registry. The protocol
  contract matches `test/fixtures/tool-timeout.snapshot.json`.

| Registry path | Configured budget | Actual successful call |
| --- | --- | --- |
| Streamable HTTP | 65000ms | 61008ms |
| HTTP-with-SSE | 65000ms | 61027ms |
| stdio | 65000ms | 61006ms |
| Native on-demand broker -> HTTP | 65000ms on underlying server | 61009ms |

Clearing each server override then produced a 1000ms timeout through the real
registry, using the plugin row default. A hand-written workspace override
allowed a 1300ms call at 2000ms; editing it to 1000ms failed as expected.

The `npm pack` tarball was installed with the official `dsh plugin --profile web
add <tarball>` CLI in a second disposable profile. The installed manifest reads
0.14.0, and both installed `lib` files are byte-identical to the tested source.
The web process returned 200 from `/mcp-manager/api/ping`. In Chrome, Settings ->
MCP displayed the new Chinese timeout input; saving `600000` and reopening Edit
returned the same value, independently confirmed in the scratch state file. The
form screenshot showed no overlap. Live English switching was not tested in
this run; both locale payloads are covered by the client tests.

## Boundaries

- Windows is not verified in this run. Existing compatibility declarations are
  unchanged; this single-version smoke does not establish support for every
  DSH release.
- Long calls were exercised through the real registry and native broker without
  a model request. Code/PTC programs may impose an independent outer deadline.
- A timeout stops waiting locally; it does not establish remote cancellation.
- GitHub issue #21 was already answered and closed, including its v0.13.4 manual
  OAuth refresh fix. No OAuth behavior changes in this release.
- Issue #18 remains dependent on upstream presentation-catalog support, tracked
  in <https://github.com/deepseek-ai/deepseek-harness/discussions/10485>.
