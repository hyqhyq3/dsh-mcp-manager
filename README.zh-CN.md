# dsh-mcp-manager

[English](README.md) | 简体中文

**[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 MCP 服务器管理插件** —— 在 设置 → MCP 页签里添加 MCP 服务器（远程 HTTP 或本地 stdio 进程），HTTP 服务器可在 **浏览器里完成 OAuth 登录**，工具既可直接暴露，也可通过紧凑的按需 broker 调用。

内置的 `@deepseek-ai/dsh-mcp-client` 只接受静态 `headers` 配置——不支持 OAuth，也不支持本地 stdio 进程。本插件补上这块：

- **OAuth（授权码 + PKCE）**：RFC 7591 动态客户端注册、`refresh_token` 自动轮换、重启后自动重连——浏览器登录一次，之后一直可用。
- **静态 Bearer Token** 模式：适配没有 OAuth 的服务器——以环境变量**名称**（Codex 风格 `tokenEnv`）引用，token 明文不落盘。
- **无鉴权**模式：适配完全不需要凭据的服务器（例如本机 `http://127.0.0.1:9316/mcp`）——插件不发送 `Authorization` 头，保存后直接连接。
- **自定义 HTTP 标头**：`headers`（直接值）+ `headerEnv`（值取自环境变量），对齐 Codex 的 `http_headers` / `env_http_headers`。
- **stdio 本地进程**：直接跑 `npx` / `uvx` / `python` 等命令，插件用 JSON-RPC over stdin/stdout 与之通信（自动拉起子进程、重连、退出时回收），无需任何远程服务器或认证。Windows 的 `.cmd` shim（如 `npx.cmd`）通过 `cmd.exe` 解析。
- **HTTP-with-SSE 服务器**：自动识别并接入旧式 SSE 传输（GET 事件流先给出会话端点，响应全部经该流异步回传），服务器拒绝普通 POST 时自动切换。Streamable HTTP 服务器不受影响。
- **就地编辑**：重命名、stdio ↔ HTTP 切换、改认证方式/标头，无需删除重建。
- **工具注册**：与内置客户端相同的 `mcp__<server>__<rawName>` 命名约定，含 DSH 工具注册表的严格 schema 清洗，并标记 `isConcurrencySafe`。
- **工作区隔离**：在 `<workspace>/.dsh/dshmm/mcp.json` 声明项目专属服务器——其工具只注册进该工作区的会话，还可按工作区屏蔽指定的全局服务器。
- **可选按需 broker**：模型侧固定只暴露 `mcp_search_tools`、`mcp_describe_tool`、`mcp_execute_tool`，不再每轮发送所有 `mcp__*` schema。默认关闭，必须手动开启。 `mcp_search_tools` 是零依赖词法排序器（BM25 + CJK/别名/模糊，且支持列目录兜底）。
- **稳定刷新工具列表**：stdio 与 Streamable HTTP 收到 `notifications/tools/list_changed` 后，只更新新增、删除或 schema 变化的注册，未变化工具保持挂载。

MCP 界面通过 `mcp` locale 命名空间跟随 DSH 在**设置 → 通用 → 语言**中的语言偏好。浏览器回退、偏好持久化和实时语言更新均由 DSH 管理；插件不再提供独立语言选择器或语言 API。标签、表单、状态徽标和确认提示均支持双语；服务器返回的诊断信息保持原文。`~/.dsh/mcp-manager.json` 中遗留的 `language` 值会被忽略并原样保留。

0.11.0 需要 `@deepseek-ai/dsh-client-locale` 和槽位系统提供的 locale `t` 属性。下列兼容性运行验证早于本次集成，并未验证所有已列出 DSH 版本上的实时语言切换。部署到旧版 web profile 前，请切换 DSH 语言并检查设置 → MCP 页面。

## 前置要求

- DeepSeek Harness；设置 → MCP 页面需要 web profile（`npx @deepseek-ai/dsh web`）。在没有 GUI webserver 的 profile（headless/tui）上，插件仍会注册 MCP 工具并连接服务器，只是没有设置页。
- Node.js `^22.19` 或 `>=24`；`PATH` 里有 pnpm
- 已验证的 DSH 版本在 `package.json` → `dsh.compatibility.dshReleases` 中逐条声明（`0.1.2-rc.1`、`0.1.5-alpha.1`、`0.1.5-alpha.2`、`0.1.5-rc.1` 为 `compatible`；支持范围 `>=0.1.2-rc.1 <0.2.0`）。未列出的版本是未经测试，不代表不兼容。上述声明来自一次性 Profile 实测：装进临时 `$DSH_HOME`，启动 `web` profile（`GET /mcp-manager/api/ping` 返回 200）、启动 `headless` profile 并确认 agent setup 生效（`0.1.5-*` 上还可确认 agent 能看到注册的 `mcp__<服务器>__<工具>`），随后删除该 Profile——全程不碰真实的 `~/.dsh`。
- Windows 10/11：stdio 命令经 `cmd.exe` 启动，以便 `.cmd` shim（`npx`、`uvx`）正确解析

## 安装

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager
```

重启 `dsh --profile web` 并刷新页面。包内声明了 `dsh.bundle.patch`，插件自动激活——无需手动改 `cordis.patch.yml`。

> MCP 服务器的 OAuth 提供方需要允许回环重定向（`http://127.0.0.1:<port>/mcp-manager/callback/<id>`）——DSH GUI 自身的 webserver 会接收授权码。origin 从浏览器实际地址动态派生，GUI 用任意 host/port 访问都可以。

## 使用

1. 打开 DSH Web UI 的 **设置 → MCP**。
2. **＋ 添加 MCP 服务器**（之后可用 **编辑** 修改）：
   - **作用域 Scope**：`user` = 全局服务器（所有工作区可用）；`workspace` = 绑定到某个工作区（配置写入该工作区的 `.dsh/dshmm/mcp.json`），从第二个下拉框选择工作区。
   - **HTTP**：名称（决定 `mcp__<name>__*` 前缀）、URL、认证方式（OAuth、静态 token 或无鉴权）、可选标头（`headers` 直接值、`headerEnv` 值取自环境变量）。
   - **stdio**：名称、命令（如 `npx`）、参数（逐行填写）、环境变量（键/值逐行）、可选工作目录。
3. OAuth 服务器：点 **去认证** → 浏览器打开登录页 → 同意授权后跳回，工具立即注册。
4. 静态 token 服务器：填写**存放 token 的环境变量名**（如 `MCP_BEARER_TOKEN`）——token 本身不写入磁盘；stdio 服务器保存后立即拉起本地进程并连接。
5. 无鉴权服务器：选择 **无鉴权（服务器无需认证）**——插件不发送 `Authorization` 头，保存后直接连接；适用于不做认证的端点（例如本机 `http://127.0.0.1:9316/mcp`）。
6. 可选：打开页面顶部的**按需 MCP 工具调用**。该开关对整个 profile 生效，重启后保持，并在现有会话的下一次请求开始生效。

状态徽章：`已连接 (N 个工具)` / `待认证` / `认证中` / `错误` / `已禁用`。按钮：去认证、编辑、启用/禁用（开关）、删除。**禁用**会注销该服务器的全部工具并断开连接（配置与 OAuth token 保留）；**启用**时自动重连，无需重新认证。被禁用的服务器重启后保持休眠。该开关为全局生效：影响此 profile 下的所有会话。状态持久化在 `~/.dsh/mcp-manager.json`（服务器配置 + OAuth 客户端注册信息 + token；静态 token 仅以环境变量名引用，不落盘）。

### Agent 看到什么

按需模式关闭时（默认），每个已连接服务器的工具以一等工具出现，例如名为 `odin` 的服务器：

```
mcp__odin__search_tools     mcp__odin__describe_tool
mcp__odin__execute_tool     mcp__odin__list_tool_scopes
```

工具结果投影回 DSH 原生内容块；MCP `isError` 结果走注册表错误路径。图片块（`{ type: 'image', data, mimeType }`）**绝不原样透传**——原始 MCP 图片块没有 `attachment`，下一轮请求就会让会话崩溃。渲染始终文本优先：当当前模型路由声明支持图片输入时，host 会把图片存入 DSH 持久化 attachment 存储，该块变成真正的 `{ type: 'image', attachment }`；其余情况（无 attachment 存储、模型不支持图片、base64 非规范、媒体类型不在 PNG/JPEG/WebP/GIF 白名单）一律降级为 `[image unavailable: …]` 文本占位符。文本块按原顺序保留；经 `mcp_execute_tool` 返回的结果同样会做这层清洗。

按需模式开启后，Native agent 只看到三个 MCP broker 工具：

- `mcp_search_tools({ query?, server?, limit? })`：纯词法排序检索（不引入 embedding、不发网络请求）——NFKC 归一、camelCase/CJK 分词 + 轻量英文词干、内置中英别名词典（如 `查日志` → `log`/`logs`）、对工具名/服务器名/描述做 BM25，并对拼写错误做有界编辑距离兜底。省略 `query` 即列出目录（可按 `server` 过滤）。最多返回 `limit` 条（默认 10，夹取 1-50）以及 `total`（截断前结果数）。
- `mcp_describe_tool({ name })`：返回当前会话可见工具的完整描述和精确输入 schema。
- `mcp_execute_tool({ name, arguments })`：通过 DSH 标准工具流水线执行当前可见 MCP 工具；建议先 describe，但不强制。

模型请求中不再出现原始 `mcp__*` schema，直接调用这些隐藏名称也会被拒绝；只有 `mcp_execute_tool` 拥有的嵌套调用可以通过。三个 broker 都读取调用 agent 的实时工具视图，因此继续遵守 workspace 隔离与 `exclude` 屏蔽。

### 工作区隔离

全局服务器（在 **设置 → MCP** 添加）对所有工作区可见。用设置页顶部的**工作区下拉框**在「全局」与某个工作区之间切换；选中工作区后，会同时显示该工作区自己的服务器与全局服务器（每条全局服务器带一个**隐藏**开关）。工作区服务器存放在 `<workspace>/.dsh/dshmm/mcp.json`（Claude/Codex 风格）：

```json
{
  "mcpServers": {
    "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "unity-mcp": { "type": "http", "url": "http://localhost:8090/", "authMode": "static", "tokenEnv": "UNITY_MCP_TOKEN" },
    "local-mcp": { "type": "http", "url": "http://127.0.0.1:9316/mcp", "authMode": "none" }
  },
  "exclude": ["github"]
}
```

- 已在 DSH 注册的工作区服务器可以**在 UI 里增删改**（选中工作区后点 **＋** 会写回该工作区的 `mcp.json`）。也可以直接手改文件——创建或修改文件都会被热重载；JSON 无效时界面会显示错误，并继续使用上一次有效的运行配置。
- `type` 缺省为 `http`；stdio 服务器的 `cwd` 缺省为工作区根。`headers` / `headerEnv` / `env` / `args` 与设置页表单的格式一致。
- 工作区服务器的工具**只**注册进「工作目录解析到该工作区」的会话；其他工作区的 agent 看不到它们。全局服务器除非被屏蔽，否则处处可见。
- `exclude` 列出要在此工作区隐藏的全局服务器（通过工具注册表的按 agent 限制屏蔽其工具）。在工作区视图里点每条全局服务器上的**隐藏**复选框即可切换。
- `serverName` 在「全局 + 所有工作区来源」之间必须唯一；重复的名称会被标记为冲突并跳过（UI 里可见）。
- 配置在每个新会话时重读，并通过文件监听热更新。
- 工作区服务器支持 **stdio**、**HTTP 静态 token**（`tokenEnv`）、**HTTP OAuth**（与全局服务器相同的 PKCE + 动态客户端注册流程）与 **HTTP 无鉴权**（`authMode: "none"`，不发 `Authorization` 头）。工作区 OAuth token 持久化在 `~/.dsh/mcp-manager.json`（绝不写进声明式的 `mcp.json`）；每条工作区 OAuth 服务器行都有「去认证」按钮。

## 工作原理

| 组成 | 机制 |
|---|---|
| 设置页 | client 半注册 `settings.section` 槽位（MCP 页签） |
| OAuth 流程 | host 半做动态客户端注册 + PKCE；重定向落在 DSH GUI webserver 自身挂载的路由上 |
| Token 存储 | `~/.dsh/mcp-manager.json`；OAuth token 401 时自动刷新。静态 token 从 `tokenEnv` 指定的环境变量读取，不落盘。无鉴权服务器不存凭据、也不发送 `Authorization` 头 |
| 旧状态迁移 | 加载时给缺少 `id` 的服务器补一个并落盘，同时把 `[{ name, value }]` 形式的 env/header 列表归一化为映射——否则按 id 的 API 会 404、数组形式的 env 会被静默丢弃 |
| MCP 传输（HTTP） | Streamable HTTP（POST JSON-RPC、`Mcp-Session-Id`、SSE/JSON 双格式响应），并在服务器拒绝普通 POST 时自动降级到旧式 HTTP-with-SSE 会话传输（GET 流给出 POST 端点、响应经该流异步回传）；每次请求合并自定义 `headers`/`headerEnv` |
| 断线重连 | 连接失败按指数退避重试（3s → 6s → 12s … 上限 60s，成功即重置）；SSE 会话的流一旦断开立即重连，在途调用快速失败而不是阻塞到超时 |
| MCP 传输（stdio） | `child_process.spawn` 拉起本地命令，JSON-RPC over stdin/stdout（换行分隔），重连时先回收旧进程。Windows 下经 `cmd.exe` 启动以解析 `.cmd` shim |
| 工具 schema | 服务器 JSON Schema 清洗为注册表支持的 raw 子集（不支持的关键字降级为无约束） |
| 图片结果 | `output.render` 文本优先；`execute(args, exec)` 暂存投影，`finalizeContent` 仅在路由模型声明图片输入时装上持久化 DSH attachment，其余情况降级为文本占位符 |
| 按需 broker | Profile 开关注册三个 broker 工具，在提示词组装后过滤原始 `mcp__*` schema，并用执行守卫确保只有 `mcp_execute_tool` 能调用隐藏工具 |
| 工具列表变化 | stdio 通知与 Streamable HTTP SSE 通道触发重新读取 `tools/list`；未变化的注册保持挂载 |
| 工作区隔离 | 装饰 `agents.create`/`resume`，组合出 per-agent setup：把 `<workspace>/.dsh/dshmm/mcp.json` 的工具注册进 agent 作用域，并按 `exclude` 应用 `tools.restrict({ deny })` |
| 新版本兼容 | 组合出的 agent setup 优先取 setup 回调的第二个参数（DSH 0.1.5-alpha.1 起），仅在缺失时回退到旧的 `agent` 上下文访问器。新版 harness 移除了该访问器，直接读 `ctx.agent` 会抛 `cannot get property "agent" without inject`，导致每次 `agents.resume`/`create` 失败。GUI webserver 改为惰性注入，没有它的 profile 也能继续注册 MCP 工具，而不会留下未激活的条目 |
| 交互通道 | 设置页与 host 半之间走同源 JSON API（`/mcp-manager/api/*`） |

## 验证与下一个门禁

发行版不可变且带 tag，消费者可以固定到某个版本：

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:hyqhyq3/dsh-mcp-manager#v0.12.0
```

DSH STORE 目录额外固定完整的 40 位 commit，而不是浮动分支（0.11.0 发行 = `1d1bb9c3851db3aefb7dd6c54a9a9dda4e4c8781`；每次推送后由商城重新固定最新发行版）。

目前已验证与尚未验证的边界：

| 层级 | 状态 | 方式 |
|---|---|---|
| 自动化（单元 + 契约） | 已验证 | `npm test`（`node --test`）——覆盖 host 半导出的辅助函数，以及基于 stub context 的 `apply()` API 冒烟测试。测试绝不写真实的 `~/.dsh` |
| 一次性 Profile 运行时 | 已验证 | 临时 `$DSH_HOME`：用官方 CLI 安装，启动 `web`（`GET /mcp-manager/api/ping` 返回 200）与 `headless`（agent setup 生效；在 `0.1.5-*` 上还可确认 agent 能看到注册的 `mcp__<服务器>__<工具>`），对 `dshReleases` 中每条已声明版本各跑一次，随后删除 Profile |
| 真实 Profile、商城页面、公开产物 | 未验证 | E4/E5 验收由运维方负责，不属于本仓库的验证范围 |

0.11.0 的 locale 契约由客户端/API stub 测试覆盖。一次性 Profile 的 CLI 安装成功，但 web 启动被沙箱阻止（`listen EPERM 127.0.0.1:3080`），因此尚未验证浏览器中的实时语言切换。

0.12.0 的无鉴权模式由基于 stub context 的 `apply()` API 测试（本地无鉴权 stub 会记录每次请求的 `Authorization` 头）与 client-locale 测试覆盖；尚未在真实 Profile 中实测。

下一个门禁：真实 Profile 的回读（解析出的版本、运行进程、设置 → MCP 页面可见），以及在分发场景下对已打 tag 产物的免登录回读。在这些证据补齐之前，兼容性声明只代表一次性 Profile 的验证结果，**不代表**你的实际安装已被验证；DSH STORE 的上架状态同理。

## 已知限制

- 只桥接 MCP 的工具能力（resources / prompts 不支持）。
- 按需过滤目前只支持 DSH 默认的 `native` 工具呈现模式。使用 `code` 或 `both` 的 agent 会保留完整 MCP 目录，避免生成式 SDK 不完整或误拦截 Code Mode 子调用。
- OAuth token 明文存于 `~/.dsh` 下的 JSON 文件——请当作机密对待。静态 token 与 `headerEnv` 的值从环境变量读取，不落盘。工作区 OAuth token 也存于同一状态文件，不写进工作区的 `mcp.json`。
- stdio 服务器以子进程常驻运行，随插件生命周期存活。POSIX 下 `args` 按空格分词（引号可保护含空格的参数），不含 shell 展开；Windows 下整条命令行交给 `cmd.exe`，`&`、`|`、`>`、`%VAR%` 等会被 shell 解释——命令与含空格的参数会被自动加引号（已加引号的原样保留），但仍建议使用绝对路径。
- 每个 GUI origin 一次 OAuth 客户端注册；GUI 换地址后下次登录会自动重新注册。

## License

MIT
