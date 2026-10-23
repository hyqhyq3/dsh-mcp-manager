# On-demand tools and Code/PTC presentation (issue #18)

Status: native broker filtering is supported. Code/PTC/both deliberately keeps
the complete **session-visible** MCP catalog. This change does not implement SDK
catalog compression. It fixes the conservative fallback when a custom prompt
empties the SDK section but still advertises `run_code`.

## Checked interfaces

Checked on 2026-10-23 against the published `@deepseek-ai/dsh-tools` and DSH
`0.2.0-rc.2` / `0.2.1-rc.2` packages, plus current upstream source. These runtime
checks do not expand the plugin's overall compatibility declaration.

The published `0.1.2-rc.1` and `0.1.5-rc.1` tool-runtime sources were also
checked: both reserve `run_code` and reject user registration/shadowing of that
name, as do the two runtime-tested hosts. Recognizing that transport therefore
does not exempt an ordinary native tool with the same name on those hosts.
This older-version check is source inspection, not a new runtime certification.

| Host | Actual presentation vocabulary |
| --- | --- |
| `0.2.0-rc.2` | `native`, `ptc`, `both` |
| `0.2.1-rc.2` | `native`, `ptc` |

“Code Mode” in issue #18 refers to the generated-SDK/`run_code` path. Do not
configure literal `mode: code` on these versions or `both` on `0.2.1-rc.2`.

The relevant upstream contracts are in
[tools](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts),
[the TypeScript SDK renderer](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/ts-types.ts),
[the PTC bridge](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/ptc.ts),
and [system prompt assembly](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/system-prompt/src/index.ts).
For immutable artifacts, inspect the npm packages for the exact versions above
(`lib/index.js` and `lib/types/index.d.ts`).

1. `SystemPrompt.assemble()` evaluates section and tool providers **before** its
   `system-prompt/assemble` waterfall. A listener can replace the final sections
   and wire tools, but removing entries from `assembly.tools` does not regenerate
   `tools:sdk`.
2. `renderToolsSdk` and `renderToolsSdkPy` are exported pure renderers. Their
   input includes canonical **output** schemas, not just `tools.schemas()` input
   schemas. Runtime language and program format also affect their text.
3. `sdkSection`, `sdkSchemas`, `wireSchemas`, and `modeFor` are declared private.
   Neither checked release publishes a presentation-only, per-assembly SDK
   catalog filter. `tools.restrict()` changes lookup, search and dispatch too.
4. The `run_code` bridge constructs bindings from `registry.schemas(exec.agent)`
   at execution time and submits nested calls through the real registry with a
   parent execution token. The assembly's filtered wire schemas do not determine
   these bindings. The broker's own nested calls also traverse registry policy.

A **version-pinned adapter** could rebuild SDK text from public `schemas()` /
`get()` and the exported renderers. That is a possible implementation direction,
not proof that upstream makes all adaptation impossible. It would need to own
the entire SDK replacement, preserve other tools' input/output declarations,
select the active runtime language/format, cooperate with custom prompt
waterfalls, and align execution guards with the accepted presentation for each
agent/request. This plugin spans older hosts and intentionally does not ship an
adapter based on private method calls, SDK string surgery, or registry mutation.

Requested upstream seam: a scoped, per-assembly **presentation catalog** transform
before both native-schema and SDK generation, with input/output schemas and
runtime language/format supplied by the host. It must leave the execution
registry available for the broker's policy-checked nested dispatch and document
how the accepted presentation relates to runtime binding/authorization. Tests
must include mixed modes, concurrent sessions and tools contributed by other
plugins. Such a seam enables a reliable broker-only SDK; a text renderer alone
does not establish that contract.

No upstream tracking issue was identified by the repository searches for
`tools:sdk`, `SDK filter`, `on-demand`, and `MCP SDK` on the check date. This is not
a claim that no related issue exists. No upstream issue or reply was created.

## Available fallback

- Select a **native** agent/preset and enable on-demand MCP tools. Search returns
  names; describe returns the exact registered schema; execute calls through the
  host registry. Searching does not permanently inject/unlock raw tools.
- Keep Code/PTC and its full catalog when programmatic composition is needed.
  Calling the broker from `run_code` works, but the three broker declarations add
  context and do not hide the existing SDK declarations.
- Disable unneeded servers or use workspace `exclude` to reduce actual session
  capabilities. Excluded tools also disappear from search and execution; this
  is a deliberate capability change, not lazy loading.
- Shorter descriptions supplied by the MCP server can reduce prose, but retain
  all tool names, argument shapes and return types. No automatic truncation mode
  is added: the existing 2,000-character description cap remains unchanged.
- A per-server facade would be a new capability-routing API. It must preserve
  visibility, input validation, policy, cancellation, result/image handling and
  audit identity. Simply unregistering the underlying tools or bypassing
  `ctx.tools.execute()` would break those properties. The current three-tool
  broker already provides a server-independent facade in native mode.

## Reproduce without real user configuration

Use Node 24 and separate temporary npm prefixes containing the two exact DSH
versions (installing dependencies may need network access). Then run:

```sh
node --test test/broker-presentation.test.js test/client-language.test.js
node scripts/verify-broker-dsh.mjs /temporary/prefix-0.2.0-rc.2 /tmp/broker-020.json
node scripts/verify-broker-dsh.mjs /temporary/prefix-0.2.1-rc.2 /tmp/broker-021.json
```

The opt-in verifier boots the actual CLI/Loader and web profile, creates two
loopback HTTP MCP servers with 35 + 34 tools, creates independent agents, runs
the real Node PTC runtime, and cleans up its profile, workspaces and processes.
It supplies scratch `HOME`, `USERPROFILE`, and `DSH_HOME` only to its child.
No model request or credential is used. `npm test` remains dependency-free;
this verifier needs the separately installed host and permission to bind local
ports. It prints deterministic presentation counts and UTF-8 byte measurements;
these are **not token counts** or whole-conversation costs.

Observed with the fixture on macOS / Node 24.12.0 (broker off → on):

| Host / mode | Raw MCP wire schemas | MCP + broker wire JSON bytes | Whole generated SDK bytes |
| --- | --- | --- | --- |
| Both checked hosts / native | 69 → 0 (3 broker schemas) | 51,662 → 1,353 | 0 → 0 |
| `0.2.0-rc.2` / PTC | 0 → 0 | 2 → 2 (`[]`) | 52,302 → 53,724 |
| `0.2.0-rc.2` / both | 69 → 69 (+3 broker schemas) | 51,662 → 53,014 | 52,302 → 53,724 |
| `0.2.1-rc.2` / PTC | 0 → 0 | 2 → 2 (`[]`) | 52,712 → 54,134 |

Every PTC/both SDK still declares all 69 MCP tools. SDK byte totals also include
the web profile's other tools and usage instructions; they are not an estimate
of MCP-only token usage. Enabling the broker adds 1,422 SDK bytes in this fixture.

It covers broker off/on, native/PTC/both where supported, full registry versus
wire schema/SDK presentation, search → describe → execute, direct native denial,
direct PTC/both calls, workspace exclusion, server identity, host guard denial,
MCP schema errors, and the empty-SDK custom-prompt regression. Unit tests also
check mode changes, warning deduplication and broker parent-token cleanup.

Input validation boundary: these hosts' raw `tools.register()` does not run the
`defineTool` argument validator. The verifier's invalid argument reaches the
mock MCP, which rejects it; that error must propagate through both paths. This
does **not** prove host-side argument rejection. Registering a schema is not an
input-validation security boundary here; MCP servers must validate inputs.

Limitations: macOS / Node 24 / TypeScript function-body runtime only; no model
reasoning, Windows, Python/REPL runtime, live OAuth, or real profile acceptance is
covered. This feature investigation does not certify all plugin behavior on
DSH 0.2.x.

## 中文结论

本次保留 native 按需 broker，修复自定义提示词将 SDK 段清空时误拦截
`run_code` 子调用的问题，并明确 UI 的降级提示。**没有实现 Code/PTC/both
常驻 SDK 压缩**。已检查版本没有公开的“仅呈现目录过滤”接口；SDK renderer
确实已导出，但不能仅过滤 `assembly.tools` 或用 `restrict()` 替代该接口。
针对固定宿主版本重建 SDK 是可探索的适配方案，需另外验证返回类型、运行时
语言/格式、提示词瀑布和请求/会话授权的一致性，不应据此宣称跨版本兼容。

优先降级为 native agent + broker；必须使用 Code/PTC 时保留完整目录，或明确
排除不需要的服务器。搜索不会把工具永久注入 SDK。缩短服务端工具描述只能
降低描述成本；按服务器分组的门面需要完整的权限、校验和审计设计。

上面的本地脚本仅使用临时 profile 和模拟 MCP，验证 69 个工具、双服务器、
会话隔离、真实 PTC 调用、宿主 guard 和 MCP 校验错误传播。字节数不是 token
数。raw `register()` 不自动执行输入参数校验，此边界已明确记录；没有把
“错误抵达 MCP 后被拒绝”误报为“宿主拦截”。建议 #18 保留开放，跟进上游呈现
接口，并在维护者授权后另行提交上游需求；本次没有对外发言或修改真实配置。
