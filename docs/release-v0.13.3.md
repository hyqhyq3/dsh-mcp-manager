# 0.13.3 — unreleased local candidate / 未发布本地候选

No tag, publication or deployment has been created. This candidate follows the
verified 0.13.2 candidate on `main` and closes the two residual defects found
while answering GitHub issues #17 and #18. Issue replies, closures, tags and
publishing are separate owner decisions and are **not** part of this document.

本地候选接在 0.13.2 之后，修掉在回复 #17 / #18 过程中发现的两处残留缺陷。
回复/关闭 issue、打 tag、发布与部署均不在本文档范围内。

## Changes / 改动

- **Workspace attempt logs are addressable without a loaded connection (#17
  residual).** `listWorkspaces` no longer hands out a fresh random
  `ws-<b64url(random)>` id per request for a workspace that has no attached
  agent. Those rows now carry the same deterministic
  `ws-<sha256(canonicalPath + "\n" + name)[0:20]>` id that the later
  `doRescan` will assign, so `GET /mcp-manager/api/servers/:id/logs` returns the
  same log stream before and after the workspace is loaded, and the id a UI row
  shows stays valid across the transition. `POST .../connect` on such a row
  answers `404` (nothing is loaded to reconnect) instead of pretending.
- **Conflict rows are readable and refuse to shadow (#17 residual).**
  `GET .../logs` answers `200` for a row whose name collides with another
  server, and `POST .../connect` answers `409` with
  `server name "…" is taken by another server` — a conflicted workspace entry
  never opens a second connection under a duplicate name.
- **Conflict rows clear themselves (#17 residual).** A conflict is decided by
  global-vs-workspace name ownership, so it is re-derived whenever that
  ownership changes: `DELETE /mcp-manager/api/servers/:id` and a global `PUT`
  rename now rescan the loaded workspaces and let a previously blocked
  workspace entry connect and register its tools, without waiting for an
  unrelated `mcp.json` edit or a session restart.
- **Upstream tracking citation (#18).** `docs/on-demand-code-mode.md` no longer
  says that no upstream tracking item was identified. It now cites upstream
  Discussion
  [#10485](https://github.com/deepseek-ai/deepseek-harness/discussions/10485)
  (`PTC/code 模式：工具面裁剪 seam + 程序内子调用记账入口`, Ideas, opened
  2026-10-21 by the issue #18 reporter, still open with no maintainer reply),
  notes that `deepseek-ai/deepseek-harness` has Issues disabled so Discussions
  is the only upstream surface, and lists the related discussions found by
  search (#9670, #9385, #10648, #9143, #10163).

中文：工作区未加载条目改用确定性 id，日志在加载前后是同一份；冲突条目可读日志、
重连返回 409 而不会重复注册同名工具；删除或改名占用名称的全局服务器后会重新判定
冲突并自动连上；`docs/on-demand-code-mode.md` 改为引用上游 Discussion #10485。

## Provider finding: Meta/WhatsApp dynamic registration (issue #21)

Recorded here because the reply to #21 depends on it and it is not a plugin
defect. Live probes on 2026-10-23 (macOS, curl 8.7.1, Node 26.8.2):

- `GET https://mcp.facebook.com/whatsapp_business_tools/.well-known/oauth-protected-resource/whatsapp_business_tools`
  → 200, names AS `https://www.facebook.com/whatsapp_business_tools` and scopes
  `business_management`, `whatsapp_business_management`,
  `whatsapp_business_messaging`. The bare and path-appended PRM forms 404.
- AS metadata at `https://www.facebook.com/.well-known/oauth-authorization-server/whatsapp_business_tools`
  → 200 with `registration_endpoint`
  `https://mcp.facebook.com/.well-known/register/whatsapp_business_tools`,
  `token_endpoint_auth_methods_supported: ["none"]`,
  `code_challenge_methods_supported: ["S256"]`.
- The advertised `registration_endpoint` is live and issues real clients, but
  only for an allowlist of `client_name` **substrings** (`codex`, `chatgpt`,
  `claude`, case-insensitive). The plugin's own
  `dsh-mcp-manager-${server.name}` is refused with
  `400 {"error":"invalid_client_metadata","error_description":"Dynamic registration is not available for this client."}`.
  Holding the name fixed, `application_type` (native/web/absent), `scope` and
  the loopback port never change the outcome, so the SEP-837 classification
  does not affect this provider. A non-loopback `redirect_uris` is a separate
  gate (`invalid_redirect_uri`), and Meta rewrites `localhost` to `127.0.0.1`.
- Adopting an allowlisted vendor name is **not** shipped: it would impersonate
  another product's client identity. An invented numeric Client ID does not
  work either — `authorize` with one redirects to
  `https://www.facebook.com/oauth/error/` carrying
  `error_code=PLATFORM__INVALID_APP_ID`, whereas a DCR-issued id reaches the
  real `https://www.facebook.com/login.php` flow.

Supported path: a Meta app the **user** owns, entered as `clientId` (+ optional
`clientSecretEnv`, `scope`), with the exact loopback callback registered in that
app. That path reaches the provider authorize URL with `client_id`, `scope`,
`resource=<the MCP URL>` and PKCE `S256`; consent and token issuance were not
exercised.

## Verification / 验收

- `npm test` on the frozen commit: **159/159 pass, 0 fail, 0 cancelled, 0
  skipped** (Node 26.8.2, macOS). The 0.13.2 baseline was 156/156; the three new
  cases are the deterministic-id row, the conflict row (logs 200 / connect 409 /
  no shadowing / self-clearing after the blocking delete) and the rename path.
- `test/workspace-reconnect.test.js` is the focused file: 18 tests.
- Every new case runs against owned loopback fixtures with temporary profiles;
  no real credential, no model request. The tests assert the negative
  properties too: a projected row must not open a second connection, and a
  conflict row must never project `mcp__*` tools.

## Limits / 边界

- Windows remains unverified, and the browser GUI was exercised only through
  the host HTTP API contract, not by clicking the Settings → MCP page.
- Workspace rows still expose fewer health facts than global rows (no `oauth`
  or `enabled` fields), and there is intentionally still no per-workspace
  enable/disable switch.
- A conflict is re-derived on delete/rename and on any config rescan; it is not
  re-derived on a bare profile reload of a workspace that has never been loaded.
- #18's broader request (filtering the generated SDK catalog in Code/PTC) is
  still not implemented. The citation change is documentation accuracy only.
- Real Meta/WhatsApp OAuth remains unproven end-to-end; see the #21 evidence
  section in the issue reply. This candidate does not change the provider
  admission outcome.
