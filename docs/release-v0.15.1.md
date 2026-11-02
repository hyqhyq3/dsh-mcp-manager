# v0.15.1: DSH 0.2.x on-demand broker compatibility

Upstream PR: <https://github.com/hyqhyq3/dsh-mcp-manager/pull/26> (contributed by
[@yuyang0](https://github.com/yuyang0)). Fixes issue #25.

## Behavior

- DSH `0.2.2` moved the model-facing tool list out of the `system-prompt/assemble`
  payload and appends the registry-owned list afterwards. The on-demand broker no
  longer reads `assembly.tools` unconditionally; when the payload has no `tools`
  array it leaves the assembly untouched and hides direct `mcp__*` definitions
  with the registry's `deferLoading` marker instead. `0.2.1-rc.5` and older still
  pass `tools` through the waterfall and keep the previous filter path.
- Presentation detection moved to the executor interface: a code/PTC presentation
  is one whose executor owns prompt sections (`ctx.tools.selectExecutor(agent)`),
  with the waterfall payload (`tools:sdk`, `run_code`) as a second signal on
  harnesses that still supply it. PTC programs keep the full MCP catalog and are
  not blocked by the direct-call guard.
- `deferLoading` is captured per registration (`registrationSignature`), so the
  broker toggle re-registers live global and workspace registrations and takes
  effect without reconnecting. Definitions stay registered and executable, so
  `mcp_execute_tool` can dispatch them.
- Broker dispatch sends one `ctx.tools.execute()` call carrying both the `0.2.2`
  single-call batch (`calls: [{ id, name, arguments: <JSON string> }]`) and the
  flat pre-0.2.2 fields (`callId`/`name`/`arguments`/`parent`, plus the step's
  `toolSet` when supplied); the batch answer is unwrapped from
  `results[0].result`. `0.2.2` no longer carries a parent token, so an in-flight
  dispatch is tracked per agent for the guard's nested-call admission.
- `dsh.compatibility.dsh` widened to `>=0.1.2-rc.1 <0.3.0`; `dshReleases` gains
  `0.2.1-rc.5` and `0.2.2-alpha.2`. Both READMEs and `AGENTS.md` were updated.

## Review fixes (merged on top of the PR)

- The shipped verifier could not run against a real npm/npx prefix: it joined
  `node_modules/@deepseek-ai/dsh-agent-tool-presentation` onto the `dsh` package
  directory. It now resolves the sibling package for both hoisted and nested
  installs. It also asserts the correct hiding mechanism per version, sends the
  same dual `execute()` shape the plugin sends (so `0.2.1-rc.5` is verifiable),
  and records measured evidence instead of a hardcoded "waterfall never carried
  tools" string.
- Documentation corrected to the real boundary: `0.2.2` (not "0.2") moved the
  list out of the waterfall, `deferLoading` is honoured provider-side (the
  DeepSeek adapter forwards `defer_loading`, the pi-ai adapter filters, routes
  without tool-update support send the schema), and a `run_code` program cannot
  call the broker on `0.2.2` — it calls `mcp__*` tools directly.
- Added unit coverage for the flat `execute()` answer and for the per-agent
  nested-dispatch window (admitted while the dispatch is in flight, denied after
  it settles, denied again after a rejected dispatch).
- Lockfile, install pins, verification paragraphs and these release notes.

## Verification

Executed on macOS with Node v26.8.2 on 2026-11-02. Every run used scratch `HOME`,
`USERPROFILE`, and `DSH_HOME`; no real profile, credentials, or model request.

- `npm test`: **191 passed**, zero failures, cancellations, or skips
  (`main@f34805c` had 185; the PR added 4 and this release adds 2). The new
  `test/on-demand-deferral.test.js` fails 4/4 against `main`'s `lib/index.js`
  with `TypeError: Cannot read properties of undefined (reading 'some')` at the
  old `assembled.tools` read — it genuinely guards the issue #25 crash.
- Real harness, `node scripts/verify-deferral-dsh.mjs <prefix>`:
  - `0.2.2-alpha.2` → `ok: true`, contract `registry assembly`, two direct tools
    kept in the assembly with `deferLoading: true`, broker dispatch reached the
    mock MCP server, PTC called a tool directly, the toggle unmarked them again.
  - `0.2.1-rc.5` → `ok: true`, contract `waterfall filter`, the direct tools are
    absent from the model-facing assembly while the broker is on, broker dispatch
    and PTC direct call both reached the server, the toggle restored them.
  - Both runs submit zero model requests.
- Disposable profiles: the packed `0.15.1` tarball was installed with the
  official `dsh plugin --profile web add` CLI once per host (`0.2.1-rc.5` and
  `0.2.2-alpha.2`); the installed manifest reads 0.15.1, both installed `lib`
  files are byte-identical to the tested source, and each profile booted on its
  own port with `GET /mcp-manager/api/ping` →
  `200 {"ok":true,"version":4,"stdio":true,"workspace":true,"onDemandTools":true}`.
- `npm pack --dry-run`: 7 files, `dsh-mcp-manager@0.15.1`; tests, scripts and
  docs are not shipped.

## Boundaries

- No model request was submitted, so whether a provider actually omits a
  `deferLoading` tool from the model context is **provider-side and unverified**.
  The deepseek adapter maps it to `defer_loading`; the pi-ai adapter filters;
  routes without tool-update support send the schema normally.
- A `run_code` program cannot call `mcp_execute_tool` on `0.2.2` (the PTC
  executor only makes `run_code` directly callable). Code presentations call
  `mcp__*` tools directly; the broker stays callable on `0.2.1-rc.5`.
- The `0.2.*` compatibility entries are backed by the deferral verifier and the
  disposable-profile install + web boot above; the `headless` check was not
  repeated for them. `0.1.x` entries are unchanged and were not re-run.
- Workspace-scoped re-registration on toggle is covered by the shared code path
  and the unit tests only; the live verifier uses global servers.
- The guard remains a context/UX gate, not a security boundary: an in-flight
  dispatch admits direct `mcp__*` calls for that agent, and an executor that
  owns prompt sections is treated as a code presentation.
- Windows and Node 22/24 were not exercised in this run.
