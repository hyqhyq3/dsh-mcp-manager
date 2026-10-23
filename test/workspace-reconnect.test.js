import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-workspace-life-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = scratch;
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 5500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  assert.ok(await fn(), 'condition did not become true');
}

// Actual loopback MCP wire fixture; no credentials or external services.
async function endpoint({ sse = false, hold = false, fail = '' } = {}) {
  let opens = 0;
  let tool = 'echo';
  const streams = new Map();
  const held = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET' && sse) {
      const id = String(++opens);
      streams.set(id, res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      req.on('close', () => streams.delete(id));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const msg = JSON.parse(body);
      const stream = streams.get(new URL(req.url, 'http://localhost').searchParams.get('sessionId'));
      if (sse && !stream) { res.writeHead(400); res.end('sessionId query parameter is not provided'); return; }
      const reply = () => {
        if (fail && msg.method === 'initialize') { res.writeHead(503); res.end(fail); return; }
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
          : msg.method === 'tools/list' ? { tools: [{ name: tool, inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'ok' }] };
        if (sse) {
          res.writeHead(202); res.end();
          if (msg.id !== undefined) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        } else if (msg.id === undefined) { res.writeHead(202); res.end(); }
        else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); }
      };
      if (msg.method === 'initialize') {
        if (!sse) opens++;
        if (hold) { held.push(reply); return; }
      }
      reply();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stop = async () => {
    for (const stream of streams.values()) stream.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return {
    url: `http://127.0.0.1:${port}/mcp`, opens: () => opens, streams: () => streams.size,
    stop, start: () => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)),
    drop: () => { for (const stream of streams.values()) stream.destroy(); },
    tool: value => { tool = value; },
    fail: value => { fail = value; },
    release: () => { hold = false; for (const reply of held.splice(0)) reply(); },
  };
}

function mount(t, config, extraRegistry = []) {
  const dir = mkdtempSync(join(scratch, 'ws-'));
  const path = join(dir, '.dsh/dshmm/mcp.json');
  mkdirSync(join(dir, '.dsh/dshmm'), { recursive: true });
  const write = value => writeFileSync(path, JSON.stringify({ mcpServers: value }));
  write(config);
  mkdirSync(join(scratch, '.dsh'), { recursive: true });
  writeFileSync(join(scratch, '.dsh/mcp-manager.json'), JSON.stringify({ servers: [] }));
  const cleanup = [];
  const registered = new Map();
  const registry = {
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    restrict: () => () => {}, execute: async () => ({}),
  };
  const agentCleanup = [];
  const agent = { session: { header: { cwd: dir } }, ctx: { tools: registry } };
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const agents = {
    create: options => options.setup({ effect: fn => { agentCleanup.push(fn()); } }, agent),
    resume: options => options.setup({ effect: fn => { agentCleanup.push(fn()); } }, agent),
  };
  let handler;
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} }, tools: registry,
    get: name => name === 'workspaceRegistry' ? { list: () => [{ path: dir }, ...extraRegistry.map(path => ({ path }))] } : undefined,
    on: () => () => {}, effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  };
  apply(ctx);
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const fn of cleanup.reverse()) fn(); };
  t.after(dispose);
  const request = async (method, suffix, body) => {
    const req = { method, url: `/mcp-manager/api${suffix}`, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    let code, data;
    await handler(req, { writeHead(value) { code = value; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
    return { code, ...data };
  };
  const view = async () => (await request('GET', '/workspaces')).workspaces.find(ws => ws.path === dir)?.servers[0];
  return { dir, write, request, view, registered, dispose, attach: () => agents.create({}), rescan: () => agents.resume({}), release: () => { for (const fn of agentCleanup.splice(0)) fn(); } };
}
const config = url => ({ local: { type: 'http', url, authMode: 'none' } });
// Mirrors workspaceServerId: sha256(`${canonicalPath}\n${name}`)[0:20].
const workspaceId = (dir, name) => `ws-${createHash('sha256').update(`${realpathSync(dir)}\n${name}`).digest('hex').slice(0, 20)}`;

it('recovers a delayed workspace endpoint, projects tools and exposes redacted diagnostics', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  await remote.stop();
  const h = mount(t, config(remote.url));
  await h.attach();
  const failed = await h.view();
  assert.equal(failed.status, 'error');
  await remote.start();
  await h.rescan(); // unchanged config must not disable the pending recovery
  await until(() => h.registered.has('mcp__local__echo'));
  assert.equal((await h.view()).status, 'connected');
  assert.equal(remote.opens(), 1);
  assert.match(failed.error, /ECONNREFUSED/);
  const logs = await h.request('GET', `/servers/${failed.id}/logs`);
  assert.equal(logs.code, 200);
  assert.ok(logs.logs.some(log => /ECONNREFUSED/.test(log.detail)));
  const reply = await h.registered.get('mcp__local__echo').execute({});
  assert.ok(reply);
  const manual = await h.request('POST', `/servers/${failed.id}/connect`);
  assert.equal(manual.code, 200);
  assert.equal(manual.server.status, 'connected');
});

it('reconnects workspace SSE loss and replaces the tools visible to existing agents', async t => {
  const remote = await endpoint({ sse: true }); t.after(remote.stop);
  const h = mount(t, config(remote.url)); await h.attach();
  assert.ok(h.registered.has('mcp__local__echo'));
  remote.tool('replacement'); remote.drop();
  await until(() => h.registered.has('mcp__local__replacement'));
  assert.equal(h.registered.has('mcp__local__echo'), false);
  assert.equal(remote.opens(), 2);
});

it('manual workspace connect supersedes retries and concurrent requests share one handshake', async t => {
  const remote = await endpoint({ hold: true }); t.after(remote.stop);
  await remote.stop();
  const h = mount(t, config(remote.url)); await h.attach();
  const { id } = await h.view(); await remote.start();
  const one = h.request('POST', `/servers/${id}/connect`);
  const two = h.request('POST', `/servers/${id}/connect`);
  await until(() => remote.opens() >= 1); remote.release();
  assert.equal((await one).server.status, 'connected');
  assert.equal((await two).server.status, 'connected');
  await sleep(3300);
  assert.equal(remote.opens(), 1);
});

for (const action of ['delete', 'edit', 'release', 'unload']) {
  it(`cleans queued workspace retries on ${action}`, async t => {
    const old = await endpoint(); t.after(old.stop); await old.stop();
    const next = await endpoint(); t.after(next.stop);
    const h = mount(t, config(old.url)); await h.attach();
    if (action === 'delete') { h.write({}); await h.rescan(); }
    if (action === 'edit') { h.write(config(next.url)); await h.rescan(); }
    if (action === 'release') h.release();
    if (action === 'unload') h.dispose();
    await old.start(); await sleep(3300);
    assert.equal(old.opens(), 0);
    if (action === 'edit') assert.ok(h.registered.has('mcp__local__echo'));
  });
}

it('addresses a never-loaded workspace row by the deterministic id a rescan will use', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const other = mkdtempSync(join(scratch, 'ws-other-'));
  mkdirSync(join(other, '.dsh/dshmm'), { recursive: true });
  writeFileSync(join(other, '.dsh/dshmm/mcp.json'), JSON.stringify({ mcpServers: { local: { type: 'http', url: remote.url, authMode: 'none' } } }));
  const h = mount(t, config(remote.url), [other]);
  await h.attach(); // loads only h.dir; `other` stays registry-only
  const row = (await h.request('GET', '/workspaces')).workspaces.find(ws => ws.path === other).servers[0];
  assert.equal(row.status, 'configured');
  assert.equal(row.id, workspaceId(other, 'local'), 'a projected row must not carry a per-call random id');
  assert.equal((await h.request('GET', `/servers/${row.id}/logs`)).code, 200);
  assert.equal((await h.request('POST', `/servers/${row.id}/connect`)).code, 404, 'nothing is loaded to reconnect');
  assert.equal(remote.opens(), 1, 'reading the row must not open a second connection');
});

it('answers for a name-conflict workspace row without shadowing the global server', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  // The global server owns the name first, so the workspace entry is the one
  // that loses: it must stay addressable and never project a second tool set.
  const h = mount(t, config(remote.url));
  const global = await h.request('POST', '/servers', { name: 'local', type: 'http', authMode: 'none', url: remote.url });
  assert.equal(global.code, 201);
  await h.attach();
  const id = workspaceId(h.dir, 'local');
  const conflict = await h.view();
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.id, id);
  assert.equal((await h.request('GET', `/servers/${id}/logs`)).code, 200);
  const refused = await h.request('POST', `/servers/${id}/connect`);
  assert.equal(refused.code, 409);
  assert.match(refused.error, /taken by another server/);
  assert.equal(h.registered.has('mcp__local__echo'), false, 'a conflict row must never project tools');
  // Freeing the name must re-derive the conflict instead of leaving the entry
  // wedged until the config file is touched.
  assert.equal((await h.request('DELETE', `/servers/${global.server.id}`)).code, 200);
  await until(async () => (await h.view()).status === 'connected');
  assert.ok(h.registered.has('mcp__local__echo'), 'the workspace entry connects once the name is free');
});

it('retries a conflict workspace entry when a global rename frees its name', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t, config(remote.url));
  const global = await h.request('POST', '/servers', { name: 'local', type: 'http', authMode: 'none', url: remote.url });
  await h.attach();
  assert.equal((await h.view()).status, 'conflict');
  const renamed = await h.request('PUT', `/servers/${global.server.id}`, { name: 'other', type: 'http', authMode: 'none', url: remote.url });
  assert.equal(renamed.code, 200, renamed.error);
  await until(async () => (await h.view()).status === 'connected');
});

it('does not resurrect an in-flight connection after workspace release', async t => {
  const remote = await endpoint({ hold: true }); t.after(remote.stop); await remote.stop();
  const h = mount(t, config(remote.url)); await h.attach(); await remote.start();
  const { id } = await h.view();
  const connect = h.request('POST', `/servers/${id}/connect`);
  await until(() => remote.opens() === 1);
  h.release(); remote.release(); await connect;
  assert.equal(h.registered.size, 0);
  await sleep(3300); assert.equal(remote.opens(), 1);
});

it('does not retry workspace servers requiring credentials', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t, { local: { type: 'http', url: remote.url, authMode: 'oauth' } }); await h.attach();
  const { id } = await h.view();
  const res = await h.request('POST', `/servers/${id}/connect`);
  assert.equal(res.code, 200); assert.equal(res.server.status, 'needs-auth');
  await sleep(3300); assert.equal(remote.opens(), 0);
});

it('backs off repeated failures, resets after success, and redacts workspace error causes', async t => {
  const remote = await endpoint({ fail: 'unavailable?access_token=private-token-value' }); t.after(remote.stop);
  const h = mount(t, config(remote.url)); await h.attach();
  const { id } = await h.view();
  assert.equal(remote.opens(), 1);
  assert.doesNotMatch(JSON.stringify(await h.view()), /private-token-value/);
  await until(() => remote.opens() === 2);
  remote.fail('');
  await sleep(3300);
  assert.equal(remote.opens(), 2, 'second retry waits 6s rather than 3s');
  await until(() => h.registered.has('mcp__local__echo'));
  assert.equal(remote.opens(), 3);
  assert.doesNotMatch(JSON.stringify(await h.request('GET', `/servers/${id}/logs`)), /private-token-value/);
  remote.fail('unavailable again');
  await h.request('POST', `/servers/${id}/connect`);
  const before = remote.opens(); remote.fail('');
  await until(() => h.registered.has('mcp__local__echo'), 4500);
  assert.equal(remote.opens(), before + 1, 'success resets the next failure to the 3s delay');
});

for (const action of ['edit', 'delete', 'unload']) {
  it(`discards a stale handshake that finishes after ${action}`, async t => {
    const remote = await endpoint({ hold: true }); t.after(remote.stop); await remote.stop();
    const next = await endpoint(); t.after(next.stop);
    const h = mount(t, config(remote.url)); await h.attach(); await remote.start();
    const { id } = await h.view();
    const pending = h.request('POST', `/servers/${id}/connect`);
    await until(() => remote.opens() === 1);
    if (action === 'unload') h.dispose();
    else { h.write(action === 'edit' ? config(next.url) : {}); await h.rescan(); }
    remote.tool('stale'); remote.release(); await pending;
    assert.equal(h.registered.has('mcp__local__stale'), false);
    assert.equal(h.registered.has('mcp__local__echo'), action === 'edit');
    await sleep(3300); assert.equal(remote.opens(), 1);
  });
}

it('preserves global delayed-start recovery, logs and enable/disable behavior', async t => {
  const remote = await endpoint(); t.after(remote.stop); await remote.stop();
  const h = mount(t, {});
  const created = await h.request('POST', '/servers', { name: 'global', type: 'http', authMode: 'none', url: remote.url });
  const id = created.server.id;
  await until(async () => (await h.request('GET', '/servers')).servers[0].status === 'error');
  await remote.start();
  await until(() => h.registered.has('mcp__global__echo'));
  assert.equal((await h.request('GET', `/servers/${id}/logs`)).code, 200);
  await h.request('POST', `/servers/${id}/enabled`, { enabled: false });
  assert.equal(h.registered.has('mcp__global__echo'), false);
  await h.request('POST', `/servers/${id}/enabled`, { enabled: true });
  assert.ok(h.registered.has('mcp__global__echo'));
  await h.request('DELETE', `/servers/${id}`);
});

it('closes a failed SSE handshake before retrying it', async t => {
  const remote = await endpoint({ sse: true, fail: 'temporary outage' }); t.after(remote.stop);
  const h = mount(t, config(remote.url)); await h.attach();
  assert.equal((await h.view()).status, 'error');
  await until(() => remote.streams() === 0);
  remote.fail('');
  await until(() => h.registered.has('mcp__local__echo'));
  assert.equal(remote.streams(), 1);
  h.dispose();
  await until(() => remote.streams() === 0);
});
