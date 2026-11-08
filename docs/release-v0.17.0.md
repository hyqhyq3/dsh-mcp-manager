# v0.17.0: collapse the on-demand MCP schema surface on routes without toolUpdate

Related: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/33> (the core-side root
cause analysis and measurements live in that thread; this release is the
plugin-side mitigation, not the final resolution of the mechanism).

On a DSH 0.2.2-rc.1 route whose model catalog declares no `toolUpdate` (an
`llm-pi-ai` provider with `api: openai-completions` is the common case), the
core's `projectToolUpdates` takes its "immediately available tools" branch and
strips the `deferLoading` marker from every definition after the plugin's
waterfall hook has returned, so the provider request carries the full
`mcp__*` schemas regardless of the marker (the issue report measured 82,078
prompt tokens for 197 tools where the broker should have collapsed the
surface), while the guard still refuses every direct call. The plugin-side
mitigation gives native agents on exactly those routes a collapsed surface in
their own tool scope, and leaves the upstream core fix (preserve or honor the
marker per adapter) as the right final state.

## Changes

- The `system-prompt/assemble` waterfall hook now resolves the agent's route
  before its presentation logic: `ctx.get('llm').resolveModelInfo(provider,
  model)` (the DSH 0.2.2-rc.1 contract, verified against the installed
  bundles: `LlmResolvedModelInfo.toolUpdate` is `'in-history'` or
  `'addition-only'` when declared, absent otherwise `context.modelSelection`
  is `{ provider, model, reasoningEffort? }`). The verdict is honored
  fail-safe: a missing llm service, an unknown provider, a thrown or
  non-object resolution, or an assemble context without a usable route all
  degrade to the previous behavior. The verdict is never persisted.
- One materialization funnels everything that reaches a registry tier:
  `materializeDefinition(base, agent, { stubbed })`. Full mode keeps the
  state-driven `deferLoading` marker (`withDeferredDirectTool`);
  `retagDirectToolDeferral` and `syncToolRegistrations` route through it, so
  the toggle lifecycle stays in one place.
- For a native agent on a route whose model lacks `toolUpdate` while
  on-demand injection is on, a per-agent compositor registers one shadow stub
  per globally owned MCP tool into the agent's own `agent.ctx` tool scope.
  A stub keeps the raw name executable, carries the original server/tool
  metadata, a pointer description capped at 160 characters
  (`<name> (MCP server "<server>"): args hidden for prompt budget. Call via
  mcp_execute_tool(name="<name>") or inspect it with mcp_describe_tool.`),
  and parameters `{ type: 'object', properties: {} }`. The scoped view
  shadows the full global definition on the same name (the dsh-tools
  documented mechanism, already used for workspace-tier registrations).
- Eligibility excludes the agent's `exclude`/`disabled` workspace servers
  through one shared pure rule (`deniedGlobalToolNames`) reused by the
  restrict-mask reconcile, so the two lists cannot drift. Code/PTC/both
  presentations (executor probe plus the existing waterfall signals) are
  never shadowed; the global tier is never shadowed, so disconnected agents
  and other presentations keep the full marked surface.
- The compositor diffs per agent on compose time and on assemble-time
  gate/presentation flips by registration signature of the stub plus the
  full definition it was derived from; repeats are no-ops. Each entry's
  disposer comes from the agent's own scoped registry, and the plugin also
  registers one `mcp-shadows-release` teardown effect on the agent context,
  so agent teardown, the on-demand toggle, and the plugin unload all clear
  remaining rows. No new debounce, and `register(def, { when })` step gating
  is deliberately not used.
- `mcp_search_tools` and `mcp_describe_tool` keep serving the full content
  while visibility stays registry-driven: catalog entries join the full
  definition from the plugin-owned global registration store, and the
  describe result field wording changed to "The tool's full normalized input
  schema." For names the plugin does not own (foreign `mcp__*`
  registrations) the visible fields are served, out of documented scope.

## Verification

- (RED) Before the implementation, `node --test test/agent-shadow-stubs.test.js`
  reproduced the issue: 7 tests, `pass 3 / fail 4` (the shadow, broker-join,
  toggle-dispose and teardown-effect cases failed as expected; the fail-safe,
  honoring and code-presentation cases already held).
- (GREEN) After the implementation the full suite passes: 282 tests, 0
  failures (275 existing plus the 7 new). The invariant that honoring routes
  never receive stubs and keep full marked global definitions is pinned by
  the second new test.
- `node scripts/verify-deferral-dsh.mjs <prefix>` (keyless, no model request)
  ran against npm-installed runtimes of both declared-relevant `0.2.*`
  targets, each booting a disposable web profile with a mock MCP server with
  this branch's plugin inserted through the real Loader:
  `0.2.1-rc.5` → `ok: true, contract: "waterfall filter: direct tools removed
  from the Assembly payload", routeGateFailSafe: true`; `0.2.2-rc.1` →
  `ok: true, contract: "registry assembly: direct tools stay registered with
  deferLoading", directToolsInAssemblyWhileEnabled: 2, deferLoadingMarked: 2,
  routeGateFailSafe: true`. Each run also re-asserts broker dispatch, PTC
  direct access and the toggle.
- The verifier itself had drifted out of date: since v0.16.3 every
  `/mcp-manager/api` route answers through the DSH connection fence, so the
  old unauthenticated ping probe timed out. It now parses the launcher token
  from the boot URL, exchanges it on `/connect` for an API operator session
  cookie, carries that cookie on every call, and probes the new route gate
  with a `modelSelection` naming an unregistered provider, asserting the
  fail-safe leaves the marked global definitions in the agent's visible view.

## Limits

- No model request was submitted, and no live provider route was exercised:
  the real-harness run proves the route gate fails safe against a real
  `resolveModelInfo` and the existing 0.2.x contracts hold; a successful
  shadow materialization against a live adapter catalog without
  `toolUpdate` is only covered by the unit tests (stubbed llm service).
- The runtime's session projection admits tools to a step's toolSet before
  the assemble waterfall runs, so a stub first registered inside the
  waterfall becomes visible to the step from the next step on; within the
  registering step a nested broker dispatch through that name can hit the
  mismatch. Signature equality makes every later step stable. This window
  compounds only in the very first turn and was not observed against a real
  model turn here.
- Browser UI, Windows, real-provider credentials and the headless profile
  were not exercised in this release's run. `dsh.compatibility.dshReleases`
  was not extended by this change; declaring `0.2.2-rc.1` compatible stays
  with the documented per-release gate (a headless boot was not repeated).
- The mitigation does not remove the underlying defect: without the core
  fix the marker semantics stay delegated per adapter, and a future DSH
  release that preserves the marker upstream supersedes this plugin-side
  surface (the shadow path is driven only where the route still resolves to
  a marker-stripping model).

中文：v0.17.0 在模型目录缺少 `toolUpdate` 的路由上为 native agent 按需注册按 agent 的
影子桩（空参数 schema + 指针描述），把承载全量 `mcp__*` schema 的请求面收敛为 broker
三件套加桩，同时 describe/search 从插件自有注册存储返回完整 schema；支持路由、
code/PTC/both agent 与任何解析失败都保持原行为、安全降级。陶套测试 282 项全部通过；
`scripts/verify-deferral-dsh.mjs` 在 0.2.1-rc.5 与 0.2.2-rc.1 的真实 disposable profile
上均验证通过（并附带 connection fence 认证修复）。未提交真实模型请求，未验证浏览器
UI、Windows 与 headless profile；上游核心修复仍是最正确的最终状态。
