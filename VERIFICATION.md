# Verification record — HTTP-with-SSE transport (v0.13.0)

Evidence for the behavior change described in the PR. Everything below was run on
Windows 11 / Node v24.21.0 against a live Burp Suite Professional 2026.7.3 exposing
BurpMCP-Ultra 2.3.2 on `127.0.0.1:9876`.

## Why the change is needed

BurpMCP-Ultra speaks the **HTTP-with-SSE** transport, not Streamable HTTP. A bare
`POST` to its endpoint answers:

```
HTTP/1.1 400 Bad Request
sessionId query parameter is not provided
```

`0.12.0` `openHttp` posts once, reads the reply from that same response, and gives up —
so such a server could never connect. Reproduction on the unmodified tree:

```
$ node --test test/sse-basic.test.js     # against the upstream code
  ✖ connects to a server that answers a bare POST with a sessionId complaint
```

## Wire protocol implemented

```
GET  <url>                  -> 200 text/event-stream
                               event: endpoint
                               data: ?sessionId=<uuid>        <- POST target
POST <url>?sessionId=<uuid> -> 202 Accepted, empty body
                               the JSON-RPC reply arrives on the GET stream:
                               event: message
                               data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

Detection is narrow, so an ordinary Streamable HTTP server is never mis-routed:

- a 2xx response whose body is not JSON (the 202/empty case), or
- a 4xx/5xx whose body names a session id

## Commands and results

### Unit / integration suite

```
$ node --test
ℹ tests 83
ℹ pass 83
ℹ fail 0
ℹ duration_ms 7000        # exits cleanly on its own
```

New files:

| File | Covers |
|---|---|
| `test/sse-basic.test.js` | 5 tests: session connect, `tools/call` over the stream, Streamable HTTP unaffected, 401 wording passthrough, protocol-revision warning |
| `test/sse-reconnect.test.js` | 2 tests: self-reconnect after the server drops the stream, in-flight calls failing fast |
| `test/concurrency-safety.test.js` | 6 tests over the real 150-tool Burp catalog |

### Against the live server

```
注册工具数: 150
INFO  mcp-manager: burp protocol 2025-03-26
INFO  mcp-manager: burp connected over sse transport (Streamable HTTP probe: HTTP 400: sessionId query parameter is not provided)
INFO  mcp-manager: burp connected, 150 tools

真实调用 mcp__burp__burp_version:
  {"product_name":"Burp Suite Professional","version":"2026.7.3","build":"52685","edition":"PROFESSIONAL"}
  isError = false

并发安全分类: 可并行 68 / 需串行 82
```

The process exits in ~1s after teardown, which also demonstrates that the SSE stream
and queued reconnect timers do not hold the event loop open.

## Incidentally fixed: Windows test isolation

`os.homedir()` reads `USERPROFILE` on Windows, not `HOME`. Six test files call
`apply()` while setting only `HOME`/`DSH_HOME`, so on Windows they were reading the
**real** `~/.dsh/mcp-manager.json` — connecting the test run to whatever MCP servers
the developer had configured. That is how this was noticed: the new SSE transport
opened a long-lived stream to a real server and `node --test` stopped exiting.

`process.env.USERPROFILE` is now pinned alongside the others. Effect on the existing
suite (same files, unmodified plugin logic):

| Test file | Before | After |
|---|---|---|
| `agent-setup-compat` | pass 5 / fail 5 | pass 10 / fail 0 |
| `language-settings` | pass 0 / fail 1 | pass 1 / fail 0 |
| `legacy-state-apply` | pass 0 | pass 6 |
| `no-auth-mode` | timed out | pass 3 |
| `broker-search` | pass 20, process hung | pass 20, exits |
| full `node --test` | never exited | exits in 7s |

`AGENTS.md` already says to set *both* `HOME` and `DSH_HOME`; the Windows variable is
the missing third leg.

## Other changes in this patch

- **Reconnect with exponential backoff** (3s → 6s → 12s … capped at 60s, reset on
  success). A failed connect previously stayed in `error` until the user pressed
  reconnect, so starting DSH before the MCP server was a dead end. `needs-auth` is
  never retried.
- **Concurrency classification**: `isConcurrencySafe` was unconditionally `true`, so
  `burp_shutdown`, `scanner_start_audit`, `proxy_intercept_enable` and friends could
  be dispatched in parallel. Tools are now classified from their name segments
  (writes before reads, ambiguous vocabulary via an explicit exceptions set); unknown
  names stay serial.
- **Error passthrough**: a 401 now reports the server's own wording
  (`unauthorized: missing or invalid token`) instead of a bare `authentication required`.
- **Protocol revision**: the requested revision is a named constant and a mismatch is
  logged rather than silently ignored.
- **Teardown**: queued reconnect timers are cancelled on plugin unload.
