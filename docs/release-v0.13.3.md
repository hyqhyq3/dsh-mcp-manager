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
