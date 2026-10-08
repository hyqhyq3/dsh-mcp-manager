import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// STATE_PATH is derived from homedir() when the module is evaluated, so point
// HOME at a scratch directory *before* the dynamic import below.
process.env.HOME = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-home-'));
process.env.USERPROFILE = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-home-'));

const { apply, resolveSetupAgent } = await import('../lib/index.js');

/** A fake Agent with just enough surface for the workspace-scoping path. */
function makeAgent() {
  return {
    id: 'session-test',
    session: { header: { cwd: mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-ws-')) } },
    ctx: {
      tools: {
        register: () => () => {},
        restrict: () => () => {},
        schemas: () => [],
        get: () => undefined,
        execute: async () => ({}),
      },
    },
  };
}

/**
 * Mount the plugin over a stub ctx whose agents registry invokes the composed
 * setup the way one harness generation does. `invoke(setup, agent, calls)`
 * stands in for that generation's calling convention. The returned `dispose`
 * runs the plugin's own teardown (workspace watchers keep the loop alive).
 */
function mount(invoke) {
  const calls = { scopeEffect: 0 };
  const disposers = [];
  const agent = makeAgent();
  const agents = {
    create(options) { return invoke(options.setup, agent, calls); },
    resume(options) { return invoke(options.setup, agent, calls); },
  };
  const childCtx = { agents, effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; } };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('agents')) callback(childCtx);
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
  };
  apply(ctx);
  const dispose = () => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } };
  return { agents, agent, calls, dispose };
}

/** The 0.1.5-rc.* shape: no `agent` accessor, the Agent arrives as arg 2. */
function newStyle(setup, agent, calls) {
  return setup({ effect: () => { calls.scopeEffect += 1; } }, agent);
}

/** The pre-0.1.5 shape: one argument, the Agent behind the `agent` accessor. */
function legacyStyle(setup, agent, calls) {
  return setup({ agent, effect: () => { calls.scopeEffect += 1; } });
}

/** No Agent anywhere: scoping must be skipped, never fatal. */
function noAgent(setup, _agent, calls) {
  return setup({ effect: () => { calls.scopeEffect += 1; } });
}

describe('resolveSetupAgent', () => {
  it('prefers the explicit Agent argument', () => {
    const agent = makeAgent();
    assert.equal(resolveSetupAgent({}, agent), agent);
  });

  it('reads the legacy accessor when no argument is passed', () => {
    const agent = makeAgent();
    assert.equal(resolveSetupAgent({ agent }, undefined), agent);
  });

  it('returns undefined instead of throwing when the accessor is gone (0.1.5-rc.*)', () => {
    assert.equal(resolveSetupAgent({ effect() {} }, undefined), undefined);
  });

  it('never surfaces a throwing accessor', () => {
    const hostile = { get agent() { throw new Error('cannot get property "agent" without inject'); } };
    assert.equal(resolveSetupAgent(hostile, undefined), undefined);
  });

  it('tolerates a missing context', () => {
    assert.equal(resolveSetupAgent(undefined, undefined), undefined);
  });
});

describe('agent setup composition across harness generations (issue #10)', () => {
  it('resolves the Agent from the setup second argument (0.1.5-rc.*) and still scopes the workspace', async (t) => {
    const { agents, agent, calls, dispose } = mount(newStyle);
    t.after(dispose);
    const seen = [];
    await agents.create({ setup: async (_agentCtx, resolved) => { seen.push(resolved); } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], agent);
    assert.equal(calls.scopeEffect, 1, 'the Agent cwd must drive workspace scoping');
  });

  it('resolves the Agent from the legacy accessor when only one argument arrives', async (t) => {
    const { agents, agent, calls, dispose } = mount(legacyStyle);
    t.after(dispose);
    const seen = [];
    await agents.create({ setup: async (_agentCtx, resolved) => { seen.push(resolved); } });
    assert.equal(seen[0], agent);
    assert.equal(calls.scopeEffect, 1);
  });

  it('still scopes a resumed session', async (t) => {
    const { agents, calls, dispose } = mount(newStyle);
    t.after(dispose);
    await agents.resume({ setup: async () => {} });
    assert.equal(calls.scopeEffect, 1);
  });

  it('never rejects session setup when no Agent is resolvable', async (t) => {
    const { agents, calls, dispose } = mount(noAgent);
    t.after(dispose);
    let ran = false;
    await agents.create({ setup: async () => { ran = true; } });
    assert.equal(ran, true, 'the caller setup must still run');
    assert.equal(calls.scopeEffect, 0, 'scoping is skipped without an Agent');
  });

  it('does not swallow a caller setup failure', async (t) => {
    const { agents, dispose } = mount(newStyle);
    t.after(dispose);
    await assert.rejects(
      agents.create({ setup: async () => { throw new Error('caller setup failed'); } }),
      /caller setup failed/,
    );
  });
});
