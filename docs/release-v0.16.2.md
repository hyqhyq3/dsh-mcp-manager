# v0.16.2: redact MCP transport diagnostics before truncation

Related: <https://github.com/hyqhyq3/dsh-mcp-manager/issues/30>.

An MCP server that echoes a credential in an error body could expose its prefix
because transport diagnostics truncated the response before redacting it. A
`notifications/tools/list_changed` refresh failure could also send the complete
JSON-RPC error message to the host logger without redaction.

## Changes

- Generic HTTP RPC failures and failed initialization now use `serverReason`,
  which reads the complete body, selects a JSON-RPC error message when present,
  and redacts before applying the diagnostic length limit. This also covers
  authentication/scope messages and the Streamable HTTP probe in SSE fallback
  diagnostics.
- The shared redactor recognizes single- and double-quoted credential values in
  free-form text as well as the existing JSON fields, unquoted values, query
  parameters and Bearer syntax.
- Tool-list refresh warnings use `describeError` before reaching the host
  logger. Method, HTTP status and ordinary non-sensitive reasons remain useful.

## Verification

Verified on macOS arm64 with synthetic credentials and owned loopback servers;
all tests resolve profile paths to disposable directories before plugin import.

- The same 53 regression tests against base
  `e2afcbb7b39758be260eb32af6f349de5dceb27a` pass 16 and fail 37 on credential
  assertions, with no fixture timeout. The fixed candidate passes all 53.
- `npm test`: 269 passed on each of Node v22.23.2, v24.12.0 and v26.8.2,
  with no failures, cancellations or skips.
- `test/transport-redaction.test.js` exercises the shipping `apply()` API,
  registered tool calls, card error data, attempt logs and host warnings. It
  covers long credentials crossing the old 200/300-character cutoffs in JSON,
  escaped JSON values, quoted and unquoted free-form values and Bearer text;
  HTTP 401/400 and OAuth insufficient-scope 403; non-2xx JSON-RPC messages;
  2xx JSON-RPC initialization errors; malformed initialization/SSE probe
  diagnostics; tool-call errors; and HTTP/JSON-RPC tool-list refresh failures.
  Ordinary JSON and text 503 diagnostics retain their useful reason.
- `scripts/verify-transport-redaction-dsh.mjs` checks a keyless snapshot through
  the real DSH 0.2.2-alpha.2 Loader, web API and structured host logger on Node
  v22.23.2. The host logger is observed through its real exporter, not replaced
  by a stub. The release validation artifact also records a run against the
  extracted package's host bytes.
- Both source entry points and the new test/verifier pass `node --check`;
  `git diff --check` passes. There are no build, lint or typecheck scripts.
- Offline `npm pack --ignore-scripts` produces the expected seven package files.
  Release validation checks their bytes against the release source and excludes
  tests, scripts, docs, private evidence and local paths from the tarball.

The GitHub Release contains the package tarball, `release-validation.json` and
`SHA256SUMS`. The validation JSON binds the checks to the exact release commit;
the manifest covers both uploaded files. This does not publish to npm or upgrade
an installed profile.

## Limits

- Redaction recognizes named credential fields and Bearer syntax; arbitrary
  unlabeled secrets and arbitrary encodings are outside its coverage. This is a
  scoped transport-diagnostic fix, not an audit of all tool-result content or
  OAuth/API error surfaces.
- No real-provider credentials or model requests were used. Browser rendering,
  real-provider consent, Windows and Linux were not exercised.
- Real Loader coverage is limited to DSH 0.2.2-alpha.2 on Node 22 and does not
  expand the compatibility matrix. Package/transport checks do not establish
  that an existing user profile was upgraded.

中文：本版修复 MCP 传输错误先截断后脱敏造成的凭据前缀泄露，并在工具列表刷新失败写入
宿主日志前脱敏。三个 Node 版本各 269 项通过；真实 DSH Loader 与打包字节使用合成凭据
验证。任意无标记秘密、任意编码、真实提供方授权、浏览器及其他操作系统仍不在已验证范围。
