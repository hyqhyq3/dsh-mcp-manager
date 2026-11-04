import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// Pin all profile paths before importing the shipping host module.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-redaction-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
mkdirSync(process.env.DSH_HOME, { recursive: true });
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

const secret = `synthetic-credential-prefix-${'x'.repeat(700)}-end`;
const bodies = {
  json: token => JSON.stringify({ access_token: token, reason: 'credential rejected' }),
  escapedJson: token => JSON.stringify({ client_secret: `escaped"\\${token}`, reason: 'credential rejected' }),
  free: token => `credential rejected; access_token="${token}"; retry later`,
  singleQuoted: token => `credential rejected; refresh_token='${token}'; retry later`,
  unquoted: token => `credential rejected; id_token=${token}; retry later`,
  bearer: token => `credential rejected: Bearer ${token}; retry later`,
};

async function until(predicate) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('local transport condition did not become ready');
}

// The external MCP boundary is real loopback HTTP; only the DSH ctx is stubbed.
async function fixture(t, { phase = 'initialize', status = 400, body = bodies.json, rpcError = false, scopeError = false } = {}) {
  const seen = [];
  let notificationStream;
  let fail = phase !== 'refresh' && phase !== 'tools/call';
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      if (phase !== 'refresh') { res.writeHead(405); res.end(); return; }
      notificationStream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ready\n\n');
      return;
    }
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const message = JSON.parse(raw);
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      seen.push({ method: message.method, authorized: token === secret });
      const reply = (code, value) => {
        res.writeHead(code, { 'Content-Type': 'application/json',
          ...(scopeError ? { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="read"' } : {}),
        });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
      };
      const target = phase === 'refresh' ? 'tools/list' : phase;
      if (fail && message.method === target) {
        const text = body(token);
        return reply(status, rpcError
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } }
          : text);
      }
      if (message.id === undefined) return reply(202, '');
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: phase === 'refresh' } }, serverInfo: { name: 'redaction', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : {};
      reply(200, { jsonrpc: '2.0', id: message.id, result });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  writeFileSync(join(process.env.DSH_HOME, 'mcp-manager.json'), JSON.stringify({ servers: [{
    id: 'redaction', name: 'redaction', type: 'http',
    ...(scopeError ? { authMode: 'oauth', oauth: { tokens: { access_token: secret } } } : { authMode: 'static', staticToken: secret }),
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  }] }));
  const logs = [];
  const registered = new Map();
  const cleanup = [];
  let handler;
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const webServer = { register(route) { handler = route.handler; return () => {}; } };
  apply({
    logger: Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => logs.push(String(message))])),
    tools: {
      register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
      guard: () => () => {}, restrict: () => () => {}, execute: async () => ({}),
    },
    webServer, get: () => undefined, on: () => () => {}, effect,
    inject(names, callback) {
      if (names.includes('webServer')) callback({ webServer, get: () => undefined, effect });
      return { dispose() {} };
    },
  });
  t.after(() => { for (const dispose of cleanup.reverse()) dispose(); });
  async function get(path) {
    const req = { method: 'GET', url: `/mcp-manager/api/${path}`, headers: { host: 'localhost' } };
    const res = { writeHead(code) { this.code = code; }, end(value) { this.body = value; } };
    await handler(req, res);
    assert.equal(res.code, 200);
    return JSON.parse(res.body);
  }
  return {
    logs, registered, seen, get,
    async failNext() {
      fail = true;
      if (phase === 'refresh') {
        await until(() => notificationStream);
        notificationStream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
      }
    },
  };
}

function assertRedacted(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes('synthetic-credential-prefix'), false, 'credential prefix must not escape');
  assert.match(text, /<redacted>/);
}

for (const [phase, status, rpcError] of [
  ['initialize', 401, false], // serverReason: authentication diagnostic
  ['initialize', 400, false], // serverReason: generic HTTP diagnostic
  ['initialize', 400, true],  // HTTP failure with an encoded JSON-RPC message
  ['initialize', 200, true],  // initialize failed: JSON-RPC error body
  ['tools/list', 400, false], // generic mcpRpc HTTP error
  ['tools/list', 400, true],  // encoded JSON-RPC message in a non-2xx response
]) {
  for (const [format, body] of Object.entries(bodies)) {
    it(`redacts ${format} credentials before truncating ${phase} HTTP ${status}${rpcError ? ' JSON-RPC error' : ''}`, async t => {
      const f = await fixture(t, { phase, status, rpcError, body });
      let row;
      await until(async () => {
        row = (await f.get('servers')).servers[0];
        return row.status === 'error';
      });
      assert.ok(f.seen.some(call => call.method === phase && call.authorized), 'fixture must echo the transmitted token');
      assertRedacted(row.error); // the error text consumed by the server card
      assertRedacted(await f.get('servers/redaction/logs'));
      assertRedacted(f.logs);
      assert.match(row.error, /HTTP|initialize failed/);
    });
  }
}

it('redacts a malformed 2xx initialize body in the SSE fallback probe diagnostic', async t => {
  const f = await fixture(t, { status: 200, body: bodies.free });
  let row;
  await until(async () => { row = (await f.get('servers')).servers[0]; return row.status === 'error'; });
  assert.match(row.error, /HTTP-with-SSE/);
  assertRedacted(row.error);
  assertRedacted(f.logs);
  assertRedacted(await f.get('servers/redaction/logs'));
});

for (const [format, body] of Object.entries(bodies)) {
  it(`redacts ${format} credentials from rejected tool-call errors`, async t => {
    const f = await fixture(t, { phase: 'tools/call', body });
    await until(() => f.registered.has('mcp__redaction__echo'));
    await f.failNext();
    await assert.rejects(f.registered.get('mcp__redaction__echo').execute({}), error => {
      assert.match(error.message, /MCP tools\/call HTTP 400/);
      assertRedacted(error.message);
      return true;
    });
  });
}

for (const [format, body] of Object.entries(bodies)) {
  it(`redacts ${format} credentials in OAuth insufficient-scope diagnostics`, async t => {
    const f = await fixture(t, { status: 403, scopeError: true, body });
    let row;
    await until(async () => { row = (await f.get('servers')).servers[0]; return row.status === 'needs-auth'; });
    assert.match(row.error, /insufficient scope \(requires: read\)/);
    assertRedacted(row.error);
    assertRedacted(f.logs);
    assertRedacted(await f.get('servers/redaction/logs'));
    assert.equal(f.seen.filter(call => call.method === 'initialize').length, 1, 'scope failures must not retry');
  });
}

for (const rpcError of [false, true]) {
  it(`redacts tools/list_changed host warnings for ${rpcError ? 'JSON-RPC' : 'HTTP'} errors`, async t => {
    const f = await fixture(t, { phase: 'refresh', status: rpcError ? 200 : 400, rpcError });
    await until(() => f.registered.has('mcp__redaction__echo'));
    await f.failNext();
    await until(() => f.logs.some(line => line.includes('refreshing tools')));
    const warning = f.logs.find(line => line.includes('refreshing tools'));
    assertRedacted(warning);
    assert.match(warning, /MCP tools\/list/);
    assert.equal((await f.get('servers')).servers[0].status, 'connected');
  });
}

for (const body of [() => 'temporary upstream outage; retry later', () => JSON.stringify({ error: 'temporary upstream outage; retry later' })]) {
  it('retains useful non-sensitive server diagnostics', async t => {
    const f = await fixture(t, { status: 503, body });
    let row;
    await until(async () => { row = (await f.get('servers')).servers[0]; return row.status === 'error'; });
    assert.match(row.error, /initialize HTTP 503: temporary upstream outage; retry later/);
    assert.match(JSON.stringify(await f.get('servers/redaction/logs')), /temporary upstream outage/);
    assert.ok(f.logs.some(line => line.includes('temporary upstream outage')));
  });
}
