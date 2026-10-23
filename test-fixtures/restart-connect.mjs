/**
 * Restart probe: a fresh process (no in-memory state from the test that issued
 * the tokens) mounts the plugin, reuses the persisted state file, and drives one
 * `connect` for the given server id. It prints a one-line JSON verdict so the
 * parent test can assert what happened without parsing logs.
 *
 * Usage: node test/fixtures/restart-connect.mjs <serverId>
 */
import { apply } from '../lib/index.js'

const serverId = process.argv[2]
if (!serverId) throw new Error('serverId is required')

const routes = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
  webServer: { register: (route) => { routes.push(route); return () => {} } },
  get: () => undefined,
  on: () => () => {},
  inject: (names, callback) => {
    if (typeof callback === 'function' && names.includes('webServer')) {
      callback({
        webServer: ctx.webServer,
        get: () => undefined,
        effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
      })
    }
    return { dispose: () => {} }
  },
  effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
}
apply(ctx)

const handler = routes[0]?.handler
if (!handler) throw new Error('the plugin mounted no route')

const req = { method: 'POST', url: `/mcp-manager/api/servers/${serverId}/connect`, headers: { host: '127.0.0.1:3080' }, async *[Symbol.asyncIterator]() {} }
const res = {
  code: 0,
  body: '',
  writeHead(code) { this.code = code },
  end(chunk) { this.body = chunk ?? '' },
}
await handler(req, res)
process.stdout.write(`${JSON.stringify({ code: res.code, body: String(res.body) })}\n`)
