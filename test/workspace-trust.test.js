/**
 * Workspace trust gate.
 *
 * `<workspace>/.dsh/dshmm/mcp.json` is attacker-controlled until the user
 * approves it: merely opening a repository must never run the commands it
 * declares (GHSA-xqx7-7wq8-mr28). Approval is per entry and bound to the
 * entry's fingerprint, so editing a command/args/env asks again while the
 * `disabled` switch does not; an entry written through the Settings API is
 * approved by the same action.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-workspace-trust-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = scratch;
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(20); }
  assert.ok(await fn(), 'condition did not become true');
}
const envProbe = fileURLToPath(new URL('./fixtures/env-probe-mcp.mjs', import.meta.url));
const statePath = join(scratch, '.dsh', 'mcp-manager.json');

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
  return {
    registered,
    register(def) { registered.set(def.name, def); return () => registered.delete(def.name); },
    guard: () => () => {},
    restrict: () => () => {},
    get: name => registered.get(name),
    schemas: () => [],
    execute: async () => ({ content: [] }),
  };
}

function mount(t) {
  const stateDir = join(scratch, '.dsh');
  mkdirSync(stateDir, { recursive: true });
  const rootRegistry = toolRegistry();
  const agentRegistries = new Map();
  const workspacePaths = new Map();
  const cleanup = [];
  let handler;
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  const agents = {
    create(options) {
      const registry = toolRegistry();
      agentRegistries.set(options.cwd, registry);
      const agent = { id: `agent-${options.cwd}`, session: { header: { cwd: options.cwd } }, ctx: { tools: registry } };
      const ready = Promise.resolve(options.setup({ effect: fn => { cleanup.push(fn()); } }, agent));
      return { agent, registry, ready, dispose() {} };
    },
    resume(options) { return this.create(options); },
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: rootRegistry,
    get: name => name === 'connection' ? { requestRejection: () => undefined } : name === 'workspaceRegistry' ? { list: () => [...workspacePaths.keys()].map(path => ({ path })) } : undefined,
    on: () => () => {},
    effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  };
  writeFileSync(statePath, JSON.stringify({ servers: [] }));
  apply(ctx);
  t.after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

  const workspace = (path, config) => {
    const dir = join(scratch, `ws-${path}`);
    mkdirSync(join(dir, '.dsh/dshmm'), { recursive: true });
    const file = join(dir, '.dsh/dshmm/mcp.json');
    const write = value => writeFileSync(file, JSON.stringify(value, null, 2));
    write(config);
    workspacePaths.set(dir, file);
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
  const view = async path => (await request('GET', '/workspaces')).workspaces.find(ws => ws.path === path);
  return { request, workspace, view, agents };
}

const local = url => ({ mcpServers: { local: { type: 'http', url, authMode: 'none' } } });

it('never connects or registers an unapproved workspace server', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('untrusted', local(remote.url));
  await a.attach();
  await until(async () => (await h.view(a.dir))?.servers.length === 1);
  const ws = await h.view(a.dir);
  assert.equal(ws.servers[0].status, 'untrusted');
  assert.equal(ws.trusted, false);
  assert.deepEqual(ws.trustPending, ['local']);
  assert.equal(a.registry().registered.size, 0, 'an unapproved server registers no tools');
  assert.equal(remote.opens(), 0, 'an unapproved server never connects');
  assert.equal((await h.request('POST', `/servers/${ws.servers[0].id}/connect`)).code, 409, 'a manual connect is refused too');
});

it('connects after the workspace is approved and records the approval', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('approve', local(remote.url));
  await a.attach();
  await until(async () => (await h.view(a.dir))?.servers[0]?.status === 'untrusted');

  const approved = await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: true });
  assert.equal(approved.code, 200, JSON.stringify(approved));
  await until(() => a.registry().registered.has('mcp__local__echo'));
  assert.equal((await h.view(a.dir)).servers[0].status, 'connected');
  assert.equal((await h.view(a.dir)).trustPending.length, 0);
  assert.equal(remote.opens(), 1);

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(state.workspaceTrust[realpathSync(a.dir)]?.local?.fingerprint, 'the approval is persisted in the state file');
  assert.equal(JSON.parse(readFileSync(join(a.dir, '.dsh/dshmm/mcp.json'), 'utf8')).trusted, undefined, 'nothing is written into the workspace');
});

it('asks again when the declared command changes and withdraws the old tools', async t => {
  const first = await endpoint(); t.after(first.stop);
  const second = await endpoint(); t.after(second.stop);
  const h = mount(t);
  const a = h.workspace('edit', local(first.url));
  await a.attach();
  await until(async () => (await h.view(a.dir))?.servers[0]?.status === 'untrusted');
  await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: true });
  await until(() => a.registry().registered.has('mcp__local__echo'));

  // A repository update rewrites the endpoint: the approval no longer covers it.
  a.write(local(second.url));
  await until(async () => (await h.view(a.dir)).servers[0].status === 'untrusted');
  assert.equal(a.registry().registered.has('mcp__local__echo'), false, 'the old tools are withdrawn');
  assert.equal(second.opens(), 0, 'the new endpoint is not contacted before approval');

  await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: true });
  await until(() => a.registry().registered.has('mcp__local__echo'));
  assert.equal(second.opens(), 1);
});

it('keeps the approval across a disabled-list edit and drops it on revoke', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('toggle', local(remote.url));
  await a.attach();
  await until(async () => (await h.view(a.dir))?.servers[0]?.status === 'untrusted');
  await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: true });
  await until(() => a.registry().registered.has('mcp__local__echo'));

  // `disabled` is a switch, not part of what runs: flipping it must not force
  // the user through the approval prompt again.
  a.write({ ...local(remote.url), disabled: ['local'] });
  await until(async () => (await h.view(a.dir)).servers[0].status === 'disabled');
  a.write(local(remote.url));
  await until(() => a.registry().registered.has('mcp__local__echo'));

  const revoked = await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: false });
  assert.equal(revoked.code, 200, JSON.stringify(revoked));
  await until(async () => (await h.view(a.dir)).servers[0].status === 'untrusted');
  assert.equal(a.registry().registered.has('mcp__local__echo'), false);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).workspaceTrust[realpathSync(a.dir)], undefined);
});

it('approves only the entry the Settings API writes', async t => {
  const remote = await endpoint(); t.after(remote.stop);
  const h = mount(t);
  const a = h.workspace('api', { mcpServers: {} });
  await a.attach();

  const added = await h.request('POST', '/workspaces/servers', { path: a.dir, name: 'local', type: 'http', url: remote.url, authMode: 'none' });
  assert.equal(added.code, 200, JSON.stringify(added));
  await until(() => a.registry().registered.has('mcp__local__echo'));
  assert.equal((await h.view(a.dir)).trusted, true);

  // A hand-injected entry in the same file is still unapproved.
  a.write({ mcpServers: { ...a.read().mcpServers, other: { type: 'http', url: remote.url, authMode: 'none' } } });
  await until(async () => (await h.view(a.dir)).servers.some(server => server.name === 'other'));
  const other = (await h.view(a.dir)).servers.find(server => server.name === 'other');
  assert.equal(other.status, 'untrusted');
  assert.equal(a.registry().registered.has('mcp__other__echo'), false);
});

it('strips interpreter/loader hooks from a stdio server environment', async t => {
  const h = mount(t);
  const probe = join(scratch, 'probe-env.json');
  const a = h.workspace('env', {
    mcpServers: {
      probe: {
        type: 'stdio',
        command: process.execPath,
        args: [envProbe, '--stdio'],
        env: { MCP_ENV_PROBE: probe, NODE_OPTIONS: '--require /definitely/missing.js' },
      },
    },
  });
  await a.attach();
  await until(async () => (await h.view(a.dir))?.servers[0]?.status === 'untrusted');
  await h.request('POST', '/workspaces/trust', { path: a.dir, trusted: true });
  await until(() => a.registry().registered.has('mcp__probe__probe'));
  const env = JSON.parse(readFileSync(probe, 'utf8'));
  assert.equal(env.MCP_ENV_PROBE, probe, 'ordinary config env still reaches the child');
  assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS never reaches the child');
});
