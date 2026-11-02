import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { startTimeoutMcp } from './fixtures/timeout-mcp.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-deferral-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = join(scratch, '.dsh');
mkdirSync(process.env.DSH_HOME, { recursive: true });
const statePath = join(process.env.DSH_HOME, 'mcp-manager.json');
const mod = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * Mount the plugin over a stub registry that records definitions, guards and
 * hooks. `selectExecutor` reports a code/PTC presentation only for `codeAgent`,
 * mirroring the executor interface the real harness exposes.
 */
function mount(t, initialState, seed = []) {
  writeFileSync(statePath, JSON.stringify(initialState));
  const tools = new Map(seed.map(definition => [definition.name, definition]));
  const dispatched = [];
  const guards = [];
  const hooks = [];
  const cleanup = [];
  const codeAgent = { id: 'code-agent' };
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  let handler;
  const webServer = { register: route => { handler = route.handler; return () => {}; } };
  const registry = {
    register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
    guard: guard => { guards.push(guard); return () => {}; },
    restrict: () => () => {},
    get: name => tools.get(name),
    schemas: () => [...tools.values()].map(({ name, description, parameters, deferLoading }) => ({
      name,
      description,
      parameters,
      ...deferLoading === true ? { deferLoading } : {},
    })),
    selectExecutor: agent => (agent === codeAgent ? { sections: [{ name: 'tools:sdk' }] } : { describe: () => ({ schemas: [] }) }),
    // DSH 0.2 answers one settled batch; the flat fields are the older contract.
    execute: async input => {
      dispatched.push(input);
      return { results: [{ callId: input.calls[0].id, result: { content: [{ type: 'text', text: 'batch-ok' }], isError: false } }] };
    },
  };
  const agents = { create: () => {}, resume: () => {} };
  mod.apply({
    logger: { info() {}, warn() {}, error() {} },
    tools: registry,
    get: () => undefined,
    on: (event, fn, options) => { hooks.push({ event, fn, options }); return () => {}; },
    effect,
    inject: (names, callback) => { callback({ agents, webServer, effect }); return { dispose() {} }; },
  }, {});
  t.after(() => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

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

  return { tools, guards, hooks, codeAgent, dispatched, request };
}

it('keeps the assemble waterfall tolerant of the DSH 0.2 payload', async t => {
  const { hooks } = mount(t, { servers: [], onDemandToolInjection: true });
  const assemble = hooks.find(hook => hook.event === 'system-prompt/assemble');
  assert.ok(assemble, 'the waterfall hook is still mounted for older harnesses');
  // DSH >= 0.2 assembles the tool list from the registry after the waterfall and
  // never passes `tools` in; reading it used to throw on every prompt assembly.
  const next = async () => ({ sections: [{ name: 'harness:identity', text: 'identity' }], contexts: [], variables: {} });
  const assembled = await assemble.fn({}, { agent: {} }, next);
  assert.deepEqual(Object.keys(assembled).sort(), ['contexts', 'sections', 'variables']);
  assert.equal(assembled.tools, undefined);
});

it('marks direct MCP tools deferred while the broker owns discovery', async t => {
  const fixture = await startTimeoutMcp();
  t.after(() => fixture.close());
  const { tools, request } = mount(t, { servers: [], onDemandToolInjection: true });
  assert.ok(tools.has('mcp_search_tools'), 'the broker registers its discovery tools');

  const created = await request('POST', '/servers', { name: 'deferral', type: 'http', url: fixture.url, authMode: 'none' });
  assert.equal(created.status, 201);
  const connected = await request('POST', `/servers/${created.server.id}/connect`);
  assert.equal(connected.server.status, 'connected', connected.server.error);

  assert.equal(tools.get('mcp__deferral__wait')?.deferLoading, true);

  // Turning the broker off hands the direct tools back to the model surface and
  // drops the discovery tools, without a reconnect.
  const disabled = await request('POST', '/settings/on-demand', { enabled: false });
  assert.equal(disabled.onDemandToolInjection, false);
  assert.equal(tools.has('mcp_search_tools'), false);
  assert.equal(tools.get('mcp__deferral__wait')?.deferLoading, undefined);
});

it('denies direct MCP calls except for a code presentation', async t => {
  const { guards, codeAgent } = mount(t, { servers: [], onDemandToolInjection: true });
  assert.equal(guards.length, 1);
  const guard = guards[0];
  assert.match(guard({ name: 'mcp__deferral__wait', agent: {} }), /hidden while on-demand MCP tools are enabled/);
  assert.equal(guard({ name: 'mcp__deferral__wait', agent: codeAgent }), undefined);
  assert.equal(guard({ name: 'read_file', agent: {} }), undefined);
});

it('dispatches a nested call through either registry shape', async t => {
  const echo = {
    name: 'mcp__fixture__echo',
    description: 'Echo [fixture MCP]',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    output: { schema: { type: 'object' }, render: () => [] },
    execute: async () => ({ text: 'echo', content: [], isError: false }),
  };
  const { tools, dispatched } = mount(t, { servers: [], onDemandToolInjection: true }, [echo]);
  const definition = tools.get('mcp_execute_tool');
  const agent = { id: 'native' };
  const exec = { agent, token: Symbol('broker'), callId: 'outer', rootCallId: 'root', signal: new AbortController().signal };
  const value = await definition.execute({ name: 'mcp__fixture__echo', arguments: { text: 'hi' } }, exec);
  assert.deepEqual(value.content, [{ type: 'text', text: 'batch-ok' }]);

  const [input] = dispatched;
  assert.equal(input.calls[0].name, 'mcp__fixture__echo');
  assert.equal(input.calls[0].arguments, JSON.stringify({ text: 'hi' }));
  // DSH <= 0.2.1 reads the flat shape and never looks at `calls`.
  assert.equal(input.name, 'mcp__fixture__echo');
  assert.deepEqual(input.arguments, { text: 'hi' });
  assert.equal(input.parent, exec.token);
});
