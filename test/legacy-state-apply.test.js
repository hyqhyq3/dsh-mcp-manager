import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// STATE_PATH is derived from homedir() when the module is evaluated, so point
// HOME at a scratch directory *before* the dynamic import below.
const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.dsh'), { recursive: true });
const statePath = join(home, '.dsh', 'mcp-manager.json');
writeFileSync(statePath, JSON.stringify({
  // A ≤0.1.x config: no `id` on any server, env as a [{ name, value }] list.
  servers: [
    { name: 'docker', type: 'stdio', command: 'docker', args: [], enabled: false },
    { name: 'github', type: 'stdio', command: 'npx', args: [], enabled: false, env: [{ name: 'UV_CACHE_DIR', value: '/tmp/uv' }] },
    { name: 'github-write', type: 'stdio', command: 'npx', args: [], enabled: false },
  ],
}, null, 2));

const { apply } = await import('../lib/index.js');

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx() {
  const routes = [];
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
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

describe('apply() over a legacy state file (issue #9 bug 1)', () => {
  const { routes } = makeCtx();
  const handler = routes[0]?.handler;
  let servers;

  it('mounts the API route', () => {
    assert.equal(routes.length, 1);
    assert.equal(typeof handler, 'function');
  });

  it('assigns a distinct id to every server and persists it', () => {
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    const ids = persisted.servers.map((server) => server.id);
    assert.equal(ids.length, 3);
    for (const id of ids) assert.equal(typeof id, 'string');
    assert.equal(new Set(ids).size, 3, 'ids must be unique or live status cross-wires');
  });

  it('normalizes the legacy env array in the persisted state', () => {
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(persisted.servers[1].env, { UV_CACHE_DIR: '/tmp/uv' });
  });

  it('lists every server with its own id instead of a shared undefined key', async () => {
    const list = await request(handler, 'GET', '/mcp-manager/api/servers');
    assert.equal(list.code, 200);
    servers = list.json.servers;
    assert.equal(servers.length, 3);
    assert.deepEqual(servers.map((server) => server.name), ['docker', 'github', 'github-write']);
    for (const server of servers) assert.equal(typeof server.id, 'string');
    assert.equal(new Set(servers.map((server) => server.id)).size, 3);
  });

  it('routes an id-addressed request to the right server instead of 404', async () => {
    const target = servers[2];
    const removed = await request(handler, 'DELETE', `/mcp-manager/api/servers/${target.id}`);
    assert.equal(removed.code, 200);
    const list = await request(handler, 'GET', '/mcp-manager/api/servers');
    assert.deepEqual(list.json.servers.map((server) => server.name), ['docker', 'github']);
  });

  it('still 404s for an unknown id', async () => {
    const missing = await request(handler, 'DELETE', '/mcp-manager/api/servers/does-not-exist');
    assert.equal(missing.code, 404);
  });
});
