# 0.13.2 — unreleased local candidate / 未发布本地候选

No tag, publication or deployment has been created. This candidate follows the owner repository's verified v0.13.1 release. Version0.13.6 from the contributor branch was intermediate fork metadata; it does not establish owner releases0.13.2–0.13.5. The cumulative local repair is assigned0.13.2 as the next owner patch version. Approval and distribution remain separate steps.

本地累计修复按官方 v0.13.1 的下一个补丁版本编号0.13.2；贡献者分支曾用的0.13.6不代表官方已发布中间版本。尚未创建 tag、发布或部署。

## Changes / 累计改动

- **OAuth state safety (#19/#20).** RFC8707 resource parameters on authorize/exchange/refresh; explicit callback origin allowlist and HTML escaping; IPv6 loopback callback support. Shared all-writer locking, atomic0600 replacement and changed-field merging preserve rotated pairs across processes. Disk adoption rebases local comparison state and respects permanent failures. Failed rotation persistence stops unsafe refresh replay. The existing immediate startup/reconnect path remains; the duplicate delayed restore that resurrected disabled/deleted servers is removed.
- **Additional pre-merge repairs.** FIFO ownership prevents queued saves overtaking each other; legacy duplicate-ID migration preserves exactly the repaired server rows; failed enable/disable persistence restores the previous flag so retries work. Stale reclaim is serialized and never evicts a live owner by age.
- **OAuth registration compatibility (#21).** HTTP loopback callbacks register as native; other callbacks register as web. Classification uses the callback rather than the MCP resource host. Error guidance displays only bounded OAuth error codes, keeping client identity, exact redirect binding, manual Client ID bypass, PKCE and state checks. This is a strict local-provider compatibility fix, not proof that a real Meta/WhatsApp account authorizes successfully.
- **Code/PTC fallback (#18, partial).** If run_code remains advertised while a custom prompt empties tools:sdk, preserve the conservative Code/PTC fallback so legitimate MCP subcalls remain callable. Native broker filtering remains supported; Code/PTC/both retains its full session-visible MCP catalog. UI/README and the interface investigation explicitly describe this limit. Full SDK catalog compression is not implemented and #18's broader request remains open.

中文：累计覆盖 OAuth resource、回调安全、跨进程 token 状态与锁恢复、三项合并前状态回归、按回调类型声明 native/web 注册，以及 run_code 可见但 SDK 提示段为空时的最小兼容修复。Code/PTC/both 的完整 SDK 压缩尚未实现，不应宣称彻底解决 #18；真实 Meta/WhatsApp 授权也尚未验证。

## Provenance / 独立来源

The six original #19 commits by Petr Bondarev / bondarevpm-tech remain unchanged in ancestry (47aed60 through9d0c6a4), followed by original #20 repair8fdf541. Additional integration commits keep sources separate:

| Source | Source identity | Local integration |
| --- | --- | --- |
| #19/#20 | main5bf55ceb; #19 head9d0c6a42; #20 head8fdf5416 | Original seven commits preserved |
| Three pre-merge repairs | reviewed local pr20-premerge-local.patch | c43449e |
| #21 | 217d5af17ee083ba6d8801efe6519e92605dc00a, Codex | 6a52eed, PR20-compatible host/test logic; README/version coordinated here |
| #18 | be501a37a360cfa67c7df45511e951e60eaa02a4, Yang Qihuang | 47d6bb0, runtime/UI/tests/investigation retained; README/version coordinated here |

Historical independent validation is retained in [#20 notes](pr19-validation.md) and [#18 investigation](on-demand-code-mode.md). Final integrated verification belongs to the integration report; independent pass counts do not substitute for combined tests.

## Reproduction / 复测

Use a supported Node runtime with no real credentials. All test fixtures use synthetic tokens, temporary HOME/USERPROFILE/DSH_HOME and owned loopback endpoints.

```sh
node --test
node scripts/verify-real-dsh.mjs /temporary/dsh-0.2.1-rc.2
node scripts/verify-oauth-dsh.mjs /temporary/dsh-0.2.1-rc.2 "$PWD/lib/index.js"
node scripts/verify-broker-dsh.mjs /temporary/dsh-0.2.0-rc.2
node scripts/verify-broker-dsh.mjs /temporary/dsh-0.2.1-rc.2
```

The OAuth Loader probe validates native registration, exact redirect and resource, S256 PKCE/state, synthetic token persistence, initialize/tools/list, native tool visibility and cached-client reuse. Broker probes use real agent/registry/PTC execution with mocked MCP and no model request; they cover visibility, policy denial, validation errors and empty-SDK fallback. Packed-artifact probes must target extracted package bytes, not a stale source checkout.

## Final integrated local verification / 最终整合验收

On macOS, the complete integrated suite passes **156/156** independently on Node22.23.2,24.12.0 and26.8.2, with zero failures, cancellations or skips. All22 JS/MJS files pass syntax checks; git diff --check passes. Offline npm pack with lifecycle scripts disabled produces exactly seven shipped files, each byte-identical to source.

Seven real Loader probes pass on the integrated candidate: packed workspace recovery; source and packed OAuth/native registration with exact resource/redirect and S256; source and packed broker/PTC on each of DSH0.2.0-rc.2 and0.2.1-rc.2. Broker probes confirm policy/isolation, validation error propagation, native-only filtering, custom empty-SDK dispatch, and no full SDK compression. All use sanitized environment, temporary profiles, synthetic OAuth and owned loopback endpoints, with zero model requests. These are local mocks through real host composition, not real-provider or live-profile acceptance.

## Limits / 验收边界

- Real Meta/WhatsApp registration POST, browser login/consent and real-account success were not performed. Provider admission, redirect, scope and audience policy can still reject a client. No production credentials or running services were touched.
- Code/PTC/both SDK compression remains open. The three broker tools add declarations there; their presence does not prove reduced context. Workspace exclusion changes capabilities, not presentation-only lazy loading.
- Real Loader verification targets exact DSH0.2.0-rc.2 and0.2.1-rc.2 runtimes, outside package's unchanged `<0.2.0` declaration. It does not certify the entire compatibility matrix. Windows, real IPv6 socket/browser behavior and browser GUI remain unverified; final report identifies actual Node versions tested.
- An orphaned .refresh.lock.reclaim requires verified manual cleanup. File-lock polling timeout is25s after reaching the local FIFO turn; earlier local owners add wait time. Process death between provider rotation and durable save, permanent storage failure and mixed old/new clients remain recovery risks.
- lastToolOkAt includes generic successful RPC; workspace views expose fewer OAuth health facts. Raw MCP input validation remains delegated to the server.

合并、回复/关闭 issue、设置草稿状态、tag、发布和部署均不在本地候选验证之中。后续操作须基于最终整合 SHA 单独确认；#18 只能回复最小修复已交付及完整需求仍开放，不能直接按全部解决关闭。
