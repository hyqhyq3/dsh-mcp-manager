/**
 * Per-workspace enable/disable (`disabled` in `<workspace>/.dsh/dshmm/mcp.json`).
 *
 * The names may be global or workspace-local; masking is scoped to the
 * workspace's own agents, the config entry is kept (and its OAuth tokens are not
 * dropped), and the existing `exclude` list keeps its behaviour.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-ws-disable-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = scratch;
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 2500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(10); }
  assert.ok(await fn(), 'condition did not become true');
}

// Loopback MCP fixture: one `echo` tool, no auth, counts connections.
async function endpoint() {
  let opens = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const msg = JSON.parse(body || '{}');
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      if (msg.method === 'initialize') opens++;
      if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, opens: () => opens, stop };
}

function toolRegistry() {
  const registered = new Map();
  let currentDeny = [];
  const registry = {
    registered,
    deny: () => currentDeny,
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    guard: () => () => {},
    restrict(options) {
      currentDeny = options?.deny ?? [];
      return () => { currentDeny = []; };
    },
    get: name => registered.get(name),
    schemas: () => [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    execute: async () => ({ content: [] }),
  };
  return registry;
}

function mount(t) {
  const stateDir = join(scratch, '.dsh');
  mkdirSync(stateDir, { recursive: true });
  const rootRegistry = toolRegistry();
  const agentRegistries = new Map();
  const agentsByPath = new Map();
  const cleanup = [];
  const workspaces = new Map();
  let handler;
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  const makeAgent = cwd => {
    // Every agent gets its own registry so "existing agent vs new agent" is
    // observable; `agentRegistries` keeps the newest one for the row helpers.
    const registry = toolRegistry();
    agentRegistries.set(cwd, registry);
    const agent = { id: `agent-${cwd}`, session: { header: { cwd } }, ctx: { tools: registry } };
    agentsByPath.set(cwd, agent);
    return { agent, registry };
  };
  const agents = {
    create(options) {
      const { agent, registry } = makeAgent(options.cwd);
      const ready = Promise.resolve(options.setup({ effect: fn => { cleanup.push(fn()); } }, agent));
      return { agent, registry, ready, dispose() {} };
    },
    resume(options) { return this.create(options); },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: rootRegistry,
    get: name => name === 'connection' ? { requestRejection: () => undefined } : name === 'workspaceRegistry' ? { list: () => [...workspaces.keys()].map(path => ({ path })) } : undefined,
    on: () => () => {},
    effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  };
  writeFileSync(join(stateDir, 'mcp-manager.json'), JSON.stringify({ servers: [] }));
  apply(ctx);
  t.after(() => {
    for (const fn of cleanup.reverse()) { try { fn(); } catch {} }
  });

  const workspace = (path, config) => {
    const dir = join(scratch, `ws-${path}`);
    mkdirSync(join(dir, '.dsh/dshmm'), { recursive: true });
    const file = join(dir, '.dsh/dshmm/mcp.json');
    const write = value => writeFileSync(file, JSON.stringify(value, null, 2));
    write(config);
    workspaces.set(dir, file);
    return {
      dir,
      write,
      read: () => JSON.parse(readFileSync(file, 'utf8')),
      attach: () => agents.create({ cwd: dir }),
      registry: () => agentRegistries.get(dir),
    };
  };

  const request = async (method, suffix, body) => {
    const req = { method, url: `/mcp-manager/api${suffix}`, headers: { host: 'localhost' }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
    let code, data;
    await handler(req, { writeHead(value) { code = value; }, end(value) { data = value ? JSON.parse(value) : undefined; } });
    return { code, ...data };
  };
  const server = {
    async add(name, url) {
      const created = await request('POST', '/servers', { name, type: 'http', authMode: 'none', url });
      assert.equal(created.code, 201, created.text);
      const connected = await request('POST', `/servers/${created.server.id}/connect`);
      assert.equal(connected.code, 200, connected.text);
      return created.server.id;
    },
  };
  const view = async path => (await request('GET', '/workspaces')).workspaces.find(ws => ws.path === path);
  return { request, workspace, server, view, agents, rootRegistry };
}

const empty = { mcpServers: {} };
const local = url => ({ mcpServers: { local: { type: 'http', url, authMode: 'none' } } });

it('masks a hand-written disabled global in that workspace only, and keeps exclude working', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  await h.server.add('global', remote.url);
  const a = h.workspace('a', { mcpServers: {}, disabled: ['global'] });
  const b = h.workspace('b', { mcpServers: {}, exclude: ['global'] });
  const c = h.workspace('c', empty);
  a.attach(); b.attach(); c.attach();
  await until(() => a.registry()?.deny().includes('mcp__global__echo'));
  await until(() => b.registry()?.deny().includes('mcp__global__echo'));
  assert.ok(a.registry().deny().includes('mcp__global__echo'), 'disabled masks the global tool in workspace A');
  assert.ok(b.registry().deny().includes('mcp__global__echo'), 'exclude keeps its existing behaviour');
  assert.deepEqual(c.registry().deny(), [], 'another workspace is untouched');

  // Removing the name from the file hot-reloads the mask without a reconnect.
  const opens = remote.opens();
  a.write({ mcpServers: {}, disabled: [] });
  await until(() => !a.registry().deny().includes('mcp__global__echo'));
  assert.equal(remote.opens(), opens);
});

it('disables a workspace-local server, keeps its row and config, and re-enables it', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('local', { mcpServers: local(remote.url).mcpServers, disabled: ['local'] });
  const row = async () => (await h.view(a.dir)).servers.find(server => server.name === 'local');
  a.attach();
  await until(async () => (await row()) !== undefined);
  assert.equal((await row()).status, 'disabled');
  assert.equal((await row()).disabled, true);
  assert.equal(a.registry().registered.has('mcp__local__echo'), false, 'a disabled server registers no tools');
  assert.equal(remote.opens(), 0, 'a disabled server never connects');
  assert.ok(a.read().mcpServers.local, 'the declaration survives disabling');

  const enabled = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'local', enabled: true });
  assert.equal(enabled.code, 200, JSON.stringify(enabled));
  await until(() => a.registry().registered.has('mcp__local__echo'));
  assert.equal((await row()).status, 'connected');
  assert.equal(remote.opens(), 1);
  assert.equal(a.read().disabled, undefined, 'the empty list is dropped from the file');
  assert.equal((await h.view(a.dir)).disabled.length, 0);

  const disabled = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'local', enabled: false });
  assert.equal(disabled.code, 200, JSON.stringify(disabled));
  await until(() => (a.registry().registered.has('mcp__local__echo')) === false);
  assert.equal((await row()).status, 'disabled');
  assert.deepEqual(a.read().disabled, ['local']);

  // A new agent in the same workspace also starts without the disabled server.
  const fresh = await a.attach();
  await fresh.ready;
  assert.equal(fresh.registry.registered.has('mcp__local__echo'), false);
});

it('toggles a global server per workspace through the endpoint, without touching other workspaces', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  await h.server.add('global', remote.url);
  const a = h.workspace('a2', { mcpServers: {}, exclude: ['global'] });
  const b = h.workspace('b2', empty);
  a.attach(); b.attach();
  await until(() => a.registry()?.deny().includes('mcp__global__echo'));
  assert.deepEqual(b.registry().deny(), [], 'the other workspace starts unmasked');
  const opens = remote.opens();

  const off = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'global', enabled: false });
  assert.equal(off.code, 200, JSON.stringify(off));
  await until(() => a.registry().deny().includes('mcp__global__echo'));
  const aRow = await h.view(a.dir);
  assert.deepEqual(aRow.disabled, ['global']);
  assert.deepEqual(aRow.exclude, [], 'the legacy exclude entry is folded into disabled');
  assert.equal(a.read().exclude, undefined, 'an emptied exclude list is removed from the file');
  assert.match(a.read().disabled[0], /^global$/);
  assert.deepEqual(b.registry().deny(), [], 'workspace B is untouched');

  const on = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'global', enabled: true });
  assert.equal(on.code, 200, JSON.stringify(on));
  await until(() => !a.registry().deny().includes('mcp__global__echo'));
  assert.deepEqual((await h.view(a.dir)).disabled, []);
  assert.equal(remote.opens(), opens, 'masking is per agent and never reconnects the global server');
});

it('keeps a disabled local server off across a rename and cleans the list on delete', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('rename', { mcpServers: local(remote.url).mcpServers, disabled: ['local'] });
  a.attach();
  await until(async () => (await h.view(a.dir)).servers.some(server => server.name === 'local'));
  assert.deepEqual(a.read().disabled, ['local']);

  // Renaming carries the off state to the new name instead of silently
  // re-enabling the server.
  const renamed = await h.request('PUT', '/workspaces/servers', { path: a.dir, oldName: 'local', name: 'renamed', type: 'http', url: remote.url, authMode: 'none' });
  assert.equal(renamed.code, 200, JSON.stringify(renamed));
  await until(async () => (await h.view(a.dir)).servers.some(server => server.name === 'renamed'));
  assert.deepEqual(a.read().disabled, ['renamed']);
  assert.equal((await h.view(a.dir)).servers.find(server => server.name === 'renamed').disabled, true);
  assert.equal(remote.opens(), 0);

  // Deleting a disabled server drops the stale name so re-adding it starts on.
  const removed = await h.request('POST', '/workspaces/servers/delete', { path: a.dir, name: 'renamed' });
  assert.equal(removed.code, 200, JSON.stringify(removed));
  assert.equal(a.read().disabled, undefined);
  const readded = await h.request('POST', '/workspaces/servers', { path: a.dir, name: 'renamed', type: 'http', url: remote.url, authMode: 'none' });
  assert.equal(readded.code, 200, JSON.stringify(readded));
  await until(() => a.registry().registered.has('mcp__renamed__echo'));
  assert.equal((await h.view(a.dir)).servers.find(server => server.name === 'renamed').status, 'connected');
  assert.equal(remote.opens(), 1);
});

it('ignores unknown disabled names and preserves unrelated keys on write', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  await h.server.add('global', remote.url);
  const a = h.workspace('unknown', { mcpServers: {}, disabled: ['ghost'], note: { hand: 'written' } });
  a.attach();
  await until(() => a.registry()?.registered !== undefined);
  const view = await h.view(a.dir);
  assert.equal(view.error, '', 'an unknown disabled name does not invalidate the file');
  assert.deepEqual(view.servers, []);
  const file = a.read();
  assert.deepEqual(file.note, { hand: 'written' });
  assert.deepEqual(file.disabled, ['ghost']);

  const toggled = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'global', enabled: false });
  assert.equal(toggled.code, 200, JSON.stringify(toggled));
  await until(() => a.registry().deny().includes('mcp__global__echo'));
  const afterFile = a.read();
  assert.deepEqual(afterFile.note, { hand: 'written' }, 'unknown keys survive the UI write');
  assert.deepEqual(afterFile.disabled, ['ghost', 'global']);

  const bad = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'not-there', enabled: false });
  assert.equal(bad.code, 404);
  const badName = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'bad name!', enabled: false });
  assert.equal(badName.code, 400);
});

it('reports a disabled local server for a workspace that is not loaded yet', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('projected', { mcpServers: local(remote.url).mcpServers, disabled: ['local'] });
  const ws = await h.view(a.dir); // no agent attached: registry-only projection
  const row = ws.servers.find(server => server.name === 'local');
  assert.equal(row.status, 'disabled');
  assert.equal(row.disabled, true);
  assert.deepEqual(ws.disabled, ['local']);
  assert.equal(remote.opens(), 0);
});

it('normalizes a hand-edited disabled list so its switch still works', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('trimmed', { mcpServers: local(remote.url).mcpServers, disabled: [' local '] });
  const row = async () => (await h.view(a.dir)).servers.find(server => server.name === 'local');
  a.attach();
  await until(async () => (await row()) !== undefined);
  assert.equal((await row()).status, 'disabled', 'the loader trims the name');
  const on = await h.request('POST', '/workspaces/server-state', { path: a.dir, name: 'local', enabled: true });
  assert.equal(on.code, 200, JSON.stringify(on));
  await until(() => a.registry().registered.has('mcp__local__echo'));
  assert.equal(a.read().disabled, undefined, 'the padded entry was removable');
});

it('keeps a shared mask when the shadowed local entry is renamed or deleted', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  await h.server.add('dup', remote.url);
  // A local declaration shares the global name; `disabled: ["dup"]` also masks
  // the global server in this workspace.
  const a = h.workspace('collide', { mcpServers: { dup: { type: 'http', url: remote.url, authMode: 'none' } }, disabled: ['dup'] });
  a.attach();
  await until(() => a.registry()?.deny().includes('mcp__dup__echo'));

  const renamed = await h.request('PUT', '/workspaces/servers', { path: a.dir, oldName: 'dup', name: 'local-dup', type: 'http', url: remote.url, authMode: 'none' });
  assert.equal(renamed.code, 200, JSON.stringify(renamed));
  assert.deepEqual(a.read().disabled, ['dup'], 'the entry may be the global server mask, so a rename keeps it');
  await until(async () => (await h.view(a.dir)).servers.some(server => server.name === 'local-dup'));

  const removed = await h.request('POST', '/workspaces/servers/delete', { path: a.dir, name: 'local-dup' });
  assert.equal(removed.code, 200, JSON.stringify(removed));
  assert.deepEqual(a.read().disabled, ['dup'], 'deleting the local entry must not unmask the global server');
  assert.ok(a.registry().deny().includes('mcp__dup__echo'));
});
