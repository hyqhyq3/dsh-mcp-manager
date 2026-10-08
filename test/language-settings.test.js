import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-language-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx() {
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    // The plugin injects `webServer` lazily (it is optional), so hand the
    // callback a child ctx exposing the stubbed webserver.
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({
          webServer: ctx.webServer,
          get: () => undefined,
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
        });
      }
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  apply(ctx);
  return { routes, disposers };
}

/** Call the mounted route with a minimal req/res pair. */
async function request(handler, method, path, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ?? ''; },
  };
  await handler(req, res);
  return { code: res.code, json: res.body ? JSON.parse(res.body) : undefined };
}


it('settings omits language, rejects the removed route, and preserves legacy state', async () => {
  let handler = makeCtx().routes[0].handler;
  const get = () => request(handler, 'GET', '/mcp-manager/api/settings');
  assert.deepEqual((await get()).json, { onDemandToolInjection: false });
  mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ servers: [], language: 'zh' }));
  handler = makeCtx().routes[0].handler;
  assert.deepEqual((await get()).json, { onDemandToolInjection: false });
  for (const body of [{ language: 'en' }, { language: 'zh' }, {}, null]) {
    assert.equal((await request(handler, 'POST', '/mcp-manager/api/settings/language', body)).code, 404);
  }
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).language, 'zh');
  assert.equal((await request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true })).code, 200);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).language, 'zh');
  handler = makeCtx().routes[0].handler;
  assert.deepEqual((await get()).json, { onDemandToolInjection: true });
});
