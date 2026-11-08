import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-shadows-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = join(scratch, '.dsh');
mkdirSync(process.env.DSH_HOME, { recursive: true });
const statePath = join(process.env.DSH_HOME, 'mcp-manager.json');
const mod = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));

const FULL_TEXT_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};
const WOODCHUCK_DESCRIPTION =
  'Supervises the woodchuck workload. Accepts a text payload and echoes it back '
  + 'with the current woodchuck census, so agents can describe first and dispatch later.';

/**
 * Minimal streamable-HTTP MCP fixture: two tools, one with a distinctive
 * description the broker content-join can be asserted against.
 */
async function startShadowMcp() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'shadow-fixture', version: '1' } };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          { name: 'echo_a', description: WOODCHUCK_DESCRIPTION, inputSchema: FULL_TEXT_PARAMS },
          { name: 'echo_b', description: 'second echo tool', inputSchema: FULL_TEXT_PARAMS },
        ],
      };
    } else if (message.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'ok' }] };
    }
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Mount the plugin over a stub global registry; each test agent gets a scoped
 * registry of its own, mirroring dsh-tools: scoped registrations shadow
 * same-name globals, and teardown effects recorded on the agent ctx are
 * replayed by tests.
 */
function mount(t, initialState, { llm } = {}) {
  writeFileSync(statePath, JSON.stringify(initialState));
  const tools = new Map();
  const scopedByAgent = new Map();
  const dispatched = [];
  const guards = [];
  const hooks = [];
  const cleanup = [];
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  let handler;
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  const codeAgent = {
    id: 'code-agent',
    scoped: new Map(),
    ctx: {
      tools: { register() { throw new Error('a code presentation must not receive a shadow registration'); } },
      effect: () => {},
    },
  };
  const registry = {
    register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    guard: guard => { guards.push(guard); return () => {}; },
    restrict: () => () => {},
    get: name => name === 'connection' ? { requestRejection: () => undefined } : tools.get(name),
    schemas: agent => {
      const merged = new Map(tools);
      for (const [name, definition] of scopedByAgent.get(agent) ?? []) merged.set(name, definition);
      return [...merged.values()].map(({ name, description, parameters, deferLoading }) => ({
        name, description, parameters, ...deferLoading === true ? { deferLoading } : {},
      }));
    },
    selectExecutor: agent => (agent === codeAgent ? { sections: [{ name: 'tools:sdk' }] } : { describe: () => ({ schemas: [] }) }),
    execute: async input => {
      dispatched.push(input);
      const value = { content: [{ type: 'text', text: 'batch-ok' }], isError: false };
      return { results: [{ callId: input.calls[0].id, result: value }] };
    },
  };
  const agents = { create: () => {}, resume: () => {} };
  mod.apply({
    logger: { info() {}, warn() {}, error() {} },
    tools: registry,
    get: name => {
      if (name === 'connection') return { requestRejection: () => undefined };
      if (name === 'llm') return llm;
      return undefined;
    },
    on: (event, fn, options) => { hooks.push({ event, fn, options }); return () => {}; },
    effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  }, {});
  t.after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

  // Agent shape mirroring the real loop agent: its own scoped ctx whose tools
  // registry accepts per-agent registrations, plus replayable teardown effects.
  const makeScope = id => {
    const scoped = new Map();
    const effects = [];
    const agent = {
      id,
      ctx: {
        tools: {
          register: definition => { scoped.set(definition.name, definition); return () => scoped.delete(definition.name); },
        },
        effect: fn => { effects.push(fn); return () => {}; },
      },
      scoped,
      effects,
    };
    scopedByAgent.set(agent, scoped);
    return agent;
  };
  scopedByAgent.set(codeAgent, codeAgent.scoped);

  const request = async (method, path, body) => {
    let status;
    let value;
    await handler({
      method,
      url: '/mcp-manager/api' + path,
      headers: { host: 'localhost' },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    }, {
      writeHead(code) { status = code; },
      end(data) { value = data ? JSON.parse(data) : undefined; },
    });
    return { status, ...value };
  };

  return { tools, guards, hooks, codeAgent, makeScope, dispatched, registry, request };
}

/** Run one episode of the mounted assemble waterfall for the given agent. */
function assemble(hooks, agent, modelSelection) {
  const assemble = hooks.find(hook => hook.event === 'system-prompt/assemble');
  assert.ok(assemble, 'the system-prompt/assemble hook stays mounted');
  const next = async () => ({ sections: [{ name: 'harness:identity', text: 'identity' }], contexts: [], variables: {} });
  return assemble.fn({}, { agent, modelSelection }, next);
}

/** Connect the fixture server through the HTTP API so the global tier carries its tools. */
async function connectFixture(t, request, fixture, name) {
  const created = await request('POST', '/servers', { name, type: 'http', url: fixture.url, authMode: 'none' });
  assert.equal(created.status, 201);
  const connected = await request('POST', `/servers/${created.server.id}/connect`);
  assert.equal(connected.server.status, 'connected', connected.server.error);
}

it('shadows direct MCP tools with per-agent stubs on routes without toolUpdate support', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }) };
  const { tools, hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');

  const full = tools.get('mcp__bbox__echo_a');
  assert.ok(full, 'the global tier keeps the full registration');
  assert.equal(full.deferLoading, true, 'the global tier stays deferLoading-marked while the broker owns discovery');
  assert.deepEqual(full.parameters, FULL_TEXT_PARAMS, 'the global tier keeps the full schema');

  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'custom', model: 'v1' });
  const stub = native.scoped.get('mcp__bbox__echo_a');
  assert.ok(stub, 'a native agent on a toolUpdate-less route sees a shadow stub');
  assert.equal(stub.name, 'mcp__bbox__echo_a');
  assert.equal(stub.deferLoading, true);
  assert.deepEqual(stub.parameters, { type: 'object', properties: {} });
  assert.ok(stub.description.length <= 160, 'the stub description stays within the budget');
  assert.match(stub.description, /mcp_execute_tool\(name="mcp__bbox__echo_a"\)/);
  assert.match(stub.description, /"bbox"/);
  // Globality preserved: the broker still owns the full def there.
  assert.deepEqual(tools.get('mcp__bbox__echo_a').parameters, FULL_TEXT_PARAMS);
});

it('registers no per-agent stubs when the route declares toolUpdate (honoring)', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => ({ name: 'm', toolUpdate: 'addition-only' }) };
  const { tools, hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'deepseek-official', model: 'chat' });
  assert.equal(native.scoped.size, 0, 'an honoring route keeps the registry deferral as its surface');
  assert.equal(tools.get('mcp__bbox__echo_a').deferLoading, true, 'the global full def plus deferLoading stays the surface');
});

it('fails safe without shadows when model-info resolution throws', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => { throw new Error('registry exploded'); } };
  const { hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'custom', model: 'v1' });
  assert.equal(native.scoped.size, 0, 'a failed resolution must not shadow anything');
});

it('never shadows code/PTC presentation agents', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => ({ name: 'm' }) };
  const { tools, hooks, codeAgent, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  await assemble(hooks, codeAgent, { provider: 'custom', model: 'v1' });
  assert.equal(codeAgent.scoped.size, 0, 'the full catalog stays materialized for code presentations');
  assert.equal(tools.get('mcp__bbox__echo_a').deferLoading, true, 'the code agent keeps the marked full catalog');
  assert.deepEqual(tools.get('mcp__bbox__echo_a').parameters, FULL_TEXT_PARAMS, 'no materialization change for code presentations');
});

it('serves full description and input schema through the broker content join', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => ({ name: 'm' }) };
  const { tools, hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'custom', model: 'v1' });
  assert.ok(native.scoped.get('mcp__bbox__echo_a'), 'precondition: the agent-visible def is a stub');

  const full = tools.get('mcp__bbox__echo_a');
  const exec = { agent: native, token: Symbol('broker'), callId: 'outer', rootCallId: 'root', signal: new AbortController().signal };
  const described = await tools.get('mcp_describe_tool').execute({ name: 'mcp__bbox__echo_a' }, exec);
  assert.deepEqual(described.inputSchema, FULL_TEXT_PARAMS, 'describe serves the full schema from the owned store');
  assert.equal(described.description, full.description);
  assert.equal(
    tools.get('mcp_describe_tool').output.schema.properties.inputSchema.description,
    "The tool's full normalized input schema.",
  );

  const searched = await tools.get('mcp_search_tools').execute({ query: 'woodchuck' }, exec);
  assert.equal(searched.total, 1, JSON.stringify(searched));
  assert.equal(searched.matches[0].name, 'mcp__bbox__echo_a');
  assert.equal(searched.matches[0].description, full.description, 'search ranks and displays the full description');
});

it('disposes per-agent stubs when the toggle flips off and re-projects full unmarked defs', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => ({ name: 'm' }) };
  const { tools, hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'custom', model: 'v1' });
  assert.ok(native.scoped.get('mcp__bbox__echo_a'));

  const disabled = await request('POST', '/settings/on-demand', { enabled: false });
  assert.equal(disabled.onDemandToolInjection, false);
  assert.equal(native.scoped.size, 0, 'the toggle clears every per-agent stub');
  assert.equal(tools.get('mcp__bbox__echo_a').deferLoading, undefined);
  assert.deepEqual(tools.get('mcp__bbox__echo_a').parameters, FULL_TEXT_PARAMS);
});

it('replays the agent teardown effect and leaves no stale shadow rows', async t => {
  const fixture = await startShadowMcp();
  t.after(() => fixture.close());
  const llm = { resolveModelInfo: async () => ({ name: 'm' }) };
  const { tools, hooks, makeScope, request } = mount(t, { servers: [], onDemandToolInjection: true }, { llm });
  await connectFixture(t, request, fixture, 'bbox');
  const native = makeScope('native');
  await assemble(hooks, native, { provider: 'custom', model: 'v1' });
  assert.ok(native.scoped.get('mcp__bbox__echo_a'));
  assert.equal(native.effects.length, 1, 'the plugin registers one teardown effect on the agent ctx');

  for (const fn of native.effects) fn()?.();
  assert.equal(native.scoped.size, 0, 'the agent teardown effect removes the shadow registrations');
  assert.deepEqual(tools.get('mcp__bbox__echo_a').parameters, FULL_TEXT_PARAMS, 'the global tier is untouched by teardown');
});
