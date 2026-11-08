# v0.16.3: admit every /mcp-manager route through the DSH connection fence

Related: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/31>, merged via
[PR #32](https://github.com/hyqhyq3/dsh-mcp-manager/pull/32).

Every `/mcp-manager` route (add/edit/delete servers, OAuth connect, workspaces,
settings) mounts on the DSH GUI webserver with no admission check of its own.
On a public deployment (the report used a Cloudflare tunnel in front of DSH) an
unauthenticated client got HTTP 200 from `/mcp-manager/api/ping` and the full
server configuration list from `/api/servers`; the DSH token login on the main
page did not extend to plugin-registered routes.

## Changes

- The route handler now admits requests through the composition's `connection`
  service with `requestRejection(req)` — the same fence the native
  `open-in-app` and `inspector` routes use. No DSH session cookie answers 401;
  the native Host/Origin fence answers 403; and when the connection service is
  absent the handler answers 503 instead of degrading to anonymous access.
- One exception preserves the OAuth flow: a GET on the exact callback path
  whose `state` matches the server's still-pending authorization flow bypasses
  the session requirement, because the IdP redirect carries no DSH cookie and
  the state value reached only the browser that started the flow. Forged,
  stale, or non-GET callbacks are rejected, and the original handler still
  runs its server lookup, state check, and PKCE code exchange.
- README and README.zh-CN document the fence.

## Verification

Verified on macOS arm64 with no real credentials and no model requests; live
runs used isolated `HOME`, a disposable profile and an owned loopback OAuth
stub.

- `test/admin-auth-fence.test.js` landed red first (commit `d5d5a4f`): the
  401/403/503 and callback-forgery cases fail on the unfixed code. Green after
  the fix, and the whole suite is 275/275 (17 suites).
- Fresh release validation on the release commit: `npm test` 275/275 on each
  of Node v24.12.0 and v26.8.2, with zero failures, cancellations or skips.
- A live curl matrix against a real DSH 0.2.2-rc.1 web profile: unauthenticated
  `ping`/`servers` answer 401 with no server data, a cross-site Origin answers
  403 with and without a session, a foreign Host answers 403, a forged callback
  answers 401; after token login `ping` and `servers` answer 200, and a
  callback carrying the pending state without a session completes the PKCE
  exchange and registers tools.
- Two independent verification rounds are on record in the PR thread: the PR's
  own run plus a full re-run on the merged tip, the latter also exercising the
  OAuth callback end to end against a local stub issuer (RFC 8414 discovery,
  dynamic client registration, S256 PKCE): the correct-state callback returned
  200 and the server showed `connected` with a registered tool, while the same
  callback with a wrong state, and as a POST with the correct state, both
  answered 401.
- Both source entry points and the new test file pass `node --check`. There
  are no build, lint or typecheck scripts.
- Offline `npm pack --ignore-scripts` produces exactly 7 package files, all
  byte-identical to the release commit, with tests, scripts and docs excluded
  from the tarball.

## Limits

- The callback exception is deliberate: a matching-state GET skips the session
  check, bounded by the state value's entropy and the exact-path match; every
  other method, path and state is fenced. An IdP error redirect that arrives
  without a state answers 401 instead of rendering a provider error page.
- Verification covers the HTTP admission layer; no browser was driven, and the
  settings-page behavior behind the fence was checked at the API level only.
  Windows and Linux were not exercised. The on-demand deferral verifier
  targeted at this fence is re-authenticated and green in the v0.17.0 line
  (`scripts/verify-deferral-dsh.mjs` against DSH 0.2.1-rc.5 and 0.2.2-rc.1).

中文：本版把 `/mcp-manager` 全部管理路由接入 DSH 原生连接准入（会话 Cookie 或 401、
Host/Origin 栅栏或 403、connection 服务缺失时 503 失败关闭），仅放行 state 与在途
授权流程匹配的 GET OAuth 回调。新增围栏测试先红后绿，全量 275 项通过；两个 Node
版本各 275 项通过；并在真实 DSH 0.2.2-rc.1 上完成 curl 矩阵与两轮独立验证。
浏览器 UI 层、其他操作系统未验证；本次发布 GitHub Release，不发布 npm，也不升级
已安装 Profile。
