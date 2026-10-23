import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-presentation-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.DSH_HOME = scratch;
const { apply } = await import('../lib/index.js');
after(() => rmSync(scratch, { recursive: true, force: true }));

function mount(t) {
  mkdirSync(join(scratch, '.dsh'), { recursive: true });
  writeFileSync(join(scratch, '.dsh/mcp-manager.json'), JSON.stringify({ servers: [], onDemandToolInjection: true }));
  const definitions = new Map();
  const cleanup = [];
  const warnings = [];
  let assemble, guard;
  const schema = { name: 'mcp__one__echo', description: 'Echo', parameters: { type: 'object' } };
  const ctx = {
    logger: { info() {}, warn(message) { warnings.push(message); }, error() {} },
    tools: {
      register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name); },
      schemas: () => [schema], get: () => undefined,
      guard(fn) { guard = fn; return () => { guard = undefined; }; },
      async execute(exec) {
        assert.equal(guard(exec), undefined, 'broker sub-dispatch must pass its own guard');
        return { isError: false, content: [{ type: 'text', text: 'echo' }] };
      },
    },
    on(event, fn) {
      assert.equal(event, 'system-prompt/assemble');
      assemble = fn;
      return () => { assemble = undefined; };
    },
    get: () => undefined, inject: () => ({ dispose() {} }),
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; },
  };
  apply(ctx);
  t.after(() => {
    for (const dispose of cleanup.reverse()) dispose();
    assert.equal(definitions.size, 0, 'unload must unregister all broker tools');
    assert.equal(assemble, undefined, 'unload must remove the assembly listener');
    assert.equal(guard, undefined, 'unload must remove the native guard');
  });
  const native = { sections: [], tools: [schema, { name: 'mcp_search_tools' }], contexts: [], variables: {} };
  return {
    ctx, native, definitions, warnings,
    assemble: (agent, assembly = native) => assemble({}, { scope: agent }, async () => assembly),
    guard: exec => guard(exec),
  };
}

it('filters native presentation without mutating the registry or assembly', async t => {
  const h = mount(t), agent = {};
  const result = await h.assemble(agent);
  assert.deepEqual(result.tools.map(tool => tool.name), ['mcp_search_tools']);
  assert.equal(h.native.tools.length, 2);
  assert.equal(h.ctx.tools.schemas(agent).length, 1);
  assert.match(h.guard({ name: 'mcp__one__echo', agent }), /use mcp_execute_tool/);
  assert.equal(h.guard({ name: 'unrelated', agent }), undefined);
  assert.equal(h.guard({ name: 'mcp__one__echo' }), undefined);
});

it('retains SDK text and code calls per agent, and restores native guarding on a mode change', async t => {
  const h = mount(t), code = {}, native = {};
  const assembly = { ...h.native, sections: [{ name: 'tools:sdk', text: 'declare const tools: { mcp__one__echo: Function }' }] };
  assert.equal(await h.assemble(code, assembly), assembly);
  assert.equal(await h.assemble(code, assembly), assembly);
  assert.equal(h.warnings.length, 1);
  assert.equal(h.guard({ name: 'mcp__one__echo', agent: code, parent: Symbol() }), undefined);
  await h.assemble(native);
  assert.match(h.guard({ name: 'mcp__one__echo', agent: native }), /hidden/);
  await h.assemble(code);
  assert.match(h.guard({ name: 'mcp__one__echo', agent: code }), /hidden/);
  await h.assemble(code, assembly);
  assert.equal(h.warnings.length, 1);
});

it('keeps run_code calls available even when a custom prompt omits the SDK section', async t => {
  const h = mount(t), agent = {};
  const assembly = { ...h.native, sections: [{ name: 'tools:sdk', text: '  ' }], tools: [...h.native.tools, { name: 'run_code' }] };
  assert.equal(await h.assemble(agent, assembly), assembly);
  assert.equal(h.guard({ name: 'mcp__one__echo', agent, parent: Symbol() }), undefined);
});

it('does not let a native session reuse a settled broker parent token', async t => {
  const h = mount(t), agent = {}, token = Symbol('broker');
  await h.assemble(agent);
  const execute = h.definitions.get('mcp_execute_tool');
  const exec = { agent, token, callId: 'outer', rootCallId: 'root', signal: new AbortController().signal };
  const value = await execute.execute({ name: 'mcp__one__echo', arguments: {} }, exec);
  assert.deepEqual(value.content, [{ type: 'text', text: 'echo' }]);
  assert.match(h.guard({ name: 'mcp__one__echo', agent, parent: token }), /hidden/);
  h.ctx.tools.execute = async () => { throw new Error('remote failure'); };
  await assert.rejects(execute.execute({ name: 'mcp__one__echo', arguments: {} }, exec), /remote failure/);
  assert.match(h.guard({ name: 'mcp__one__echo', agent, parent: token }), /hidden/);
});
