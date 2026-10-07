import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// STATE_PATH is derived from homedir() at module evaluation, so point HOME at a
// scratch directory *before* the dynamic import below. Never touch a real ~/.dsh.
// USERPROFILE matters on Windows: os.homedir() reads it, not HOME, so omitting it
// let an earlier revision of this suite write reg-oauth/reg-static/reg-bogus/
// noauth straight into the developer's real ~/.dsh/mcp-manager.json.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-noauth-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');

const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx({ workspacePath } = {}) {
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: (name) => (name === 'workspaceRegistry' && workspacePath
      ? { list: () => [{ path: workspacePath }] }
      : undefined),
    on: () => () => {},
    // The plugin injects 'webServer' lazily (it is optional), so hand the
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
  return { routes, handler: routes[0]?.handler };
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

/**
 * A dependency-free unauthenticated MCP stub. Records the Authorization header
 * of every request so a test can prove the no-auth mode never sends one.
 */
function startStub() {
  const seen = [];
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
      seen.push({ method: payload.method, authorization: req.headers.authorization ?? null });
      const reply = (result) => {
        if (payload.id === undefined) { res.writeHead(202); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
      };
      if (payload.method === 'initialize') reply({ protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'noauth-stub', version: '1' } });
      else if (payload.method === 'tools/list') reply({ tools: [{ name: 'echo', description: 'echo back', inputSchema: { type: 'object' } }] });
      else reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        seen,
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

it('connects an authMode:"none" HTTP server without sending Authorization', async () => {
  const stub = await startStub();
  const { handler } = makeCtx();

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'noauth', type: 'http', url: stub.url, authMode: 'none' });
  assert.equal(created.code, 201);
  assert.equal(created.json.server.authMode, 'none');
  assert.notEqual(created.json.server.status, 'needs-auth', 'a no-auth server must not wait for credentials');

  const connected = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/connect`);
  assert.equal(connected.code, 200);
  assert.equal(connected.json.server.status, 'connected');
  assert.equal(connected.json.server.toolCount, 1);

  assert.ok(stub.seen.some((call) => call.method === 'initialize'), 'the server must actually be called');
  assert.deepEqual([...new Set(stub.seen.map((call) => call.authorization))], [null], 'no request may carry an Authorization header');

  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(persisted.servers.find((server) => server.name === 'noauth').authMode, 'none');

  const authAttempt = await request(handler, 'POST', `/mcp-manager/api/servers/${created.json.server.id}/auth`);
  assert.equal(authAttempt.code, 400, 'OAuth must not start for a no-auth server');

  await stub.close();
});

it('keeps oauth, static, and unknown auth modes gated behind credentials', async () => {
  const { handler } = makeCtx();
  for (const [name, authMode] of [['reg-oauth', 'oauth'], ['reg-static', 'static'], ['reg-bogus', 'bogus']]) {
    const res = await request(handler, 'POST', '/mcp-manager/api/servers', { name, type: 'http', url: 'http://127.0.0.1:9/mcp', authMode });
    assert.equal(res.code, 201);
    assert.equal(res.json.server.status, 'needs-auth', name + ' must stay needs-auth');
    assert.equal(res.json.server.authMode, authMode === 'bogus' ? 'oauth' : authMode);
  }
});

it('accepts authMode:"none" for a workspace server and writes no tokenEnv', async () => {
  const wsDir = mkdtempSync(join(tmpdir(), 'dsh-mm-noauth-ws-'));
  const { handler } = makeCtx({ workspacePath: wsDir });
  const res = await request(handler, 'POST', '/mcp-manager/api/workspaces/servers', { path: wsDir, name: 'ws-noauth', type: 'http', url: 'http://127.0.0.1:9316/mcp', authMode: 'none' });
  assert.equal(res.code, 200);
  const raw = JSON.parse(readFileSync(join(wsDir, '.dsh', 'dshmm', 'mcp.json'), 'utf8'));
  assert.equal(raw.mcpServers['ws-noauth'].authMode, 'none');
  assert.equal('tokenEnv' in raw.mcpServers['ws-noauth'], false);
  rmSync(wsDir, { recursive: true, force: true });
});
