import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, it } from 'node:test';
import { startTimeoutMcp } from './fixtures/timeout-mcp.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-timeouts-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = join(scratch, '.dsh');
mkdirSync(process.env.DSH_HOME);
const statePath = join(process.env.DSH_HOME, 'mcp-manager.json');
const mod = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));
const fixture = fileURLToPath(new URL('./fixtures/timeout-mcp.mjs', import.meta.url));

function mount(t, config = {}) {
  writeFileSync(statePath, JSON.stringify({ servers: [] }));
  const workspace = mkdtempSync(join(scratch, 'workspace-'));
  const tools = new Map();
  const cleanup = [];
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const registry = {
    register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    restrict: () => () => {}, schemas: () => [], get: () => undefined, execute: async () => ({}),
  };
  const agent = { session: { header: { cwd: workspace } }, ctx: { tools: registry } };
  const agents = { create: options => options.setup({ effect }, agent), resume: options => options.setup({ effect }, agent) };
  let handler;
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  mod.apply({
    logger: { info() {}, warn() {}, error() {} }, tools: registry,
    get: name => name === 'workspaceRegistry' ? { list: () => [{ path: workspace }] } : undefined,
    on: () => () => {}, effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  }, config);
  t.after(() => { for (const fn of cleanup.reverse()) fn(); });
  const request = async (method, path, body) => {
    let status, value;
    await handler({ method, url: '/mcp-manager/api' + path, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } }, {
      writeHead(code) { status = code; }, end(data) { value = data ? JSON.parse(data) : undefined; },
    });
    return { status, ...value };
  };
  const connect = async body => {
    const created = await request('POST', '/servers', body);
    assert.equal(created.status, 201);
    const connected = await request('POST', `/servers/${created.server.id}/connect`);
    assert.equal(connected.server.status, 'connected', connected.server.error);
    return connected.server;
  };
  return { tools, request, connect, workspace, attach: () => agents.create({}), rescan: () => agents.resume({}) };
}

it('normalizes optional millisecond budgets without throwing', () => {
  assert.equal(typeof mod.normalizeTimeout, 'function');
  for (const value of [undefined, null, '', ' ', 0, -1, 999, NaN, Infinity, 'oops', {}, [], Symbol('bad')]) {
    assert.equal(mod.normalizeTimeout(value), undefined);
  }
  assert.equal(mod.normalizeTimeout(1000), 1000);
  assert.equal(mod.normalizeTimeout('600000.9'), 600000);
  assert.equal(mod.resolveToolCallTimeout({ timeout: 2500 }, { toolCallTimeoutMs: 3000 }), 2500);
  assert.equal(mod.resolveToolCallTimeout({ timeout: 999 }, { toolCallTimeoutMs: '3000' }), 3000);
  assert.equal(mod.resolveToolCallTimeout({}, { toolCallTimeoutMs: null }), 60000);
});

it('preserves and cancels budgets above the Node timer limit', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fired = 0;
  mod.rpcTimeout(() => fired++, 2147483648);
  t.mock.timers.tick(2147483647);
  assert.equal(fired, 0);
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
  const cancelled = mod.rpcTimeout(() => fired++, 2147483648);
  t.mock.timers.tick(2147483647);
  cancelled.cancel();
  t.mock.timers.tick(1);
  assert.equal(fired, 1);
});

it('round-trips global and workspace budgets and clears them on PUT', async t => {
  const h = mount(t);
  const payload = { name: 'config', url: 'http://127.0.0.1:9/mcp', authMode: 'oauth', timeout: '600000.9' };
  const added = await h.request('POST', '/servers', payload);
  assert.equal(added.server.timeout, 600000);
  assert.equal(JSON.parse(readFileSync(statePath)).servers[0].timeout, 600000);
  assert.equal((await h.request('GET', '/servers')).servers[0].timeout, 600000);
  await h.request('POST', `/servers/${added.server.id}/enabled`, { enabled: false });
  assert.equal((await h.request('GET', '/servers')).servers[0].timeout, 600000);
  for (const timeout of [undefined, '', null, 999]) {
    const updated = await h.request('PUT', `/servers/${added.server.id}`, { ...payload, timeout });
    assert.equal(updated.status, 200);
    assert.equal(updated.server.timeout, undefined);
    assert.equal('timeout' in JSON.parse(readFileSync(statePath)).servers[0], false);
  }
  const wsPayload = { ...payload, name: 'workspace', path: h.workspace };
  assert.equal((await h.request('POST', '/workspaces/servers', wsPayload)).status, 200);
  const wsFile = join(h.workspace, '.dsh/dshmm/mcp.json');
  assert.equal(JSON.parse(readFileSync(wsFile)).mcpServers.workspace.timeout, 600000);
  assert.equal((await h.request('GET', '/workspaces')).workspaces[0].servers[0].timeout, 600000);
  const cleared = await h.request('PUT', '/workspaces/servers', { ...wsPayload, timeout: '', oldName: 'workspace' });
  assert.equal(cleared.status, 200);
  assert.equal('timeout' in JSON.parse(readFileSync(wsFile)).mcpServers.workspace, false);
});

for (const transport of ['http', 'sse', 'stdio']) {
  it(`${transport} applies per-server and profile budgets only to tools/call`, { timeout: 20000 }, async t => {
    const h = mount(t, { toolCallTimeoutMs: 1000 });
    let payload;
    if (transport === 'stdio') payload = { name: transport, type: 'stdio', command: process.execPath, args: [fixture, '--stdio', '1100'] };
    else {
      const remote = await startTimeoutMcp({ sse: transport === 'sse', handshakeDelay: 1100 });
      t.after(remote.close);
      payload = { name: transport, type: 'http', url: remote.url, authMode: 'none' };
    }
    const server = await h.connect({ ...payload, timeout: 2000 });
    const call = () => h.tools.get(`mcp__${transport}__wait`).execute({ delayMs: 1300 });
    assert.equal((await call()).text, 'finished');
    // A timeout-only edit must change the actual call budget, not just its view.
    await h.request('PUT', `/servers/${server.id}`, { ...payload, timeout: 1000 });
    const started = Date.now();
    await assert.rejects(call(), /timeout.*1000ms/i);
    assert.ok(Date.now() - started < 2500);
    await h.request('PUT', `/servers/${server.id}`, payload);
    await assert.rejects(call(), /timeout.*1000ms/i);
    if (transport === 'sse') {
      await assert.rejects(h.tools.get('mcp__sse__wait').execute({ holdPost: true }), /timeout.*1000ms/i);
    }
  });
}

it('reads hand-written workspace budgets and reconnects on a timeout-only rescan', { timeout: 8000 }, async t => {
  const remote = await startTimeoutMcp(); t.after(remote.close);
  const h = mount(t, { toolCallTimeoutMs: 1000 });
  const path = join(h.workspace, '.dsh/dshmm'); mkdirSync(path, { recursive: true });
  const write = timeout => writeFileSync(join(path, 'mcp.json'), JSON.stringify({ mcpServers: { ws: { url: remote.url, authMode: 'none', timeout } } }));
  write(2000);
  await h.attach();
  assert.equal((await h.tools.get('mcp__ws__wait').execute({ delayMs: 1300 })).text, 'finished');
  write(1000);
  await h.rescan();
  assert.equal((await h.request('GET', '/workspaces')).workspaces[0].servers[0].timeout, 1000);
  await assert.rejects(h.tools.get('mcp__ws__wait').execute({ delayMs: 1300 }), /timeout.*1000ms/i);
});
