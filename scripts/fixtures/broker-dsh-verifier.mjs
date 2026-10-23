// Copied into a disposable profile by scripts/verify-broker-dsh.mjs.
// The two placeholders are replaced before this module is loaded by Cordis.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'broker-verifier';
export const inject = ['agents', 'tools', 'systemPrompt', 'webServer', 'ptcRuntime'];
export function apply(ctx) {
  void verify(ctx);
}

async function verify(ctx) {
  const scratch = __SCRATCH__;
  const version = __VERSION__;
  const handles = [];
  const calls = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    const owner = req.url.slice(1);
    let result = {};
    if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: owner, version: '1' } };
    if (msg.method === 'tools/list') result = {
      tools: Array.from({ length: owner === 'one' ? 35 : 34 }, (_, index) => ({
        name: `echo_${String(index).padStart(2, '0')}`,
        description: `Echo tool ${index} on ${owner}. ` + 'Deterministic mock MCP capability for presentation cost measurement. '.repeat(8),
        inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      })),
    };
    if (msg.method === 'tools/call') {
      calls.push({ owner, name: msg.params.name, arguments: msg.params.arguments });
      result = typeof msg.params.arguments.text === 'string'
        ? { content: [{ type: 'text', text: `${owner}:${msg.params.name}:${msg.params.arguments.text}` }] }
        : { isError: true, content: [{ type: 'text', text: 'mock MCP schema validation: text must be a string' }] };
    }
    res.writeHead(msg.id === undefined ? 202 : 200, { 'Content-Type': 'application/json' });
    res.end(msg.id === undefined ? undefined : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  const until = async fn => {
    for (let index = 0; index < 200; index++) {
      if (await fn()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('condition timed out');
  };
  const metrics = [];
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = () => `http://127.0.0.1:${ctx.webServer.port}`;
    await until(async () => ctx.webServer.port && (await fetch(origin() + '/mcp-manager/api/ping')).ok);
    const api = async (method, path, body) => {
      const response = await fetch(origin() + '/mcp-manager/api' + path, {
        method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };
    for (const name of ['one', 'two']) {
      const { server: added } = await api('POST', '/servers', { name, type: 'http', authMode: 'none', url: `http://127.0.0.1:${server.address().port}/${name}` });
      await api('POST', `/servers/${added.id}/connect`);
    }
    const create = async (mode, isolated = false, customSdk = false) => {
      const workspace = join(scratch, `ws-${mode}-${isolated}-${customSdk}`);
      mkdirSync(join(workspace, '.dsh/dshmm'), { recursive: true });
      writeFileSync(join(workspace, '.dsh/dshmm/mcp.json'), JSON.stringify({ mcpServers: {}, exclude: isolated ? ['two'] : [] }));
      const handle = await ctx.agents.create({
        sessionId: `broker-${++sequence}`, meta: { cwd: workspace },
        setup(agentCtx) {
          agentCtx.tools.presentAs(mode);
          if (customSdk) agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
            const assembled = await next();
            return { ...assembled, sections: assembled.sections.map(section => section.name === 'tools:sdk' ? { ...section, text: '' } : section) };
          });
        },
      });
      handles.push(handle);
      return handle.agent;
    };
    const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent });
    const call = (agent, name, args) => ctx.tools.execute({ agent, name, arguments: args, callId: `test-${++sequence}`, signal: new AbortController().signal });
    const run = (agent, code) => call(agent, 'run_code', { code, description: 'Verify mock MCP broker' });
    const ok = result => { assert.equal(result.isError, false, JSON.stringify(result)); return result; };
    const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const value = (mode, result) => mode === 'native' || mode === 'both' ? ok(result).value : ok(result).value.result;
    const brokerCall = async (agent, mode, name, args) => value(mode, mode === 'ptc'
      ? await run(agent, `return await tools.${name}(${JSON.stringify(args)});`)
      : await call(agent, name, args));
    for (const mode of version === '0.2.0-rc.2' ? ['native', 'ptc', 'both'] : ['native', 'ptc']) {
      for (const enabled of [false, true]) {
        await api('POST', '/settings/on-demand', { enabled });
        const agent = await create(mode);
        const isolated = await create(mode, true);
        const assembly = await assemble(agent);
        await assemble(isolated);
        const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? '';
        const mcpNames = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name);
        assert.equal(mcpNames.length, 69);
        const isolatedNames = ctx.tools.schemas(isolated).filter(tool => tool.name.startsWith('mcp__')).map(tool => tool.name);
        assert.equal(isolatedNames.length, 35);
        const names = assembly.tools.map(tool => tool.name);
        const rawWireCount = names.filter(name => name.startsWith('mcp__')).length;
        assert.equal(rawWireCount, mode === 'ptc' || (enabled && mode === 'native') ? 0 : 69);
        for (const name of mcpNames) assert.equal(sdk.includes(name + '(') || sdk.includes(name + ':'), mode !== 'native', name);
        if (enabled) {
          const found = await brokerCall(agent, mode, 'mcp_search_tools', { server: 'two', limit: 1 });
          assert.equal(found.total, 34);
          const name = found.matches[0].name;
          const detail = await brokerCall(agent, mode, 'mcp_describe_tool', { name });
          assert.deepEqual(detail.inputSchema.required, ['text']);
          const result = await brokerCall(agent, mode, 'mcp_execute_tool', { name, arguments: { text: 'broker' } });
          assert.match(result.content[0].text, /^two:echo_\d+:broker$/);
          const hidden = await brokerCall(isolated, mode, 'mcp_search_tools', { server: 'two' });
          assert.equal(hidden.total, 0);
          const denied = mode === 'ptc'
            ? await run(isolated, `return await tools.mcp_execute_tool({name:${JSON.stringify(name)},arguments:{text:'leak'}});`)
            : await call(isolated, 'mcp_execute_tool', { name, arguments: { text: 'leak' } });
          assert.equal(denied.isError, true);
          assert.match(text(denied), /not visible/);
          const before = calls.length;
          const invalid = mode === 'ptc'
            ? await run(agent, `return await tools.mcp_execute_tool({name:${JSON.stringify(name)},arguments:{text:123}});`)
            : await call(agent, 'mcp_execute_tool', { name, arguments: { text: 123 } });
          assert.equal(invalid.isError, true, JSON.stringify(invalid));
          assert.match(text(invalid), /mock MCP schema validation/);
          assert.equal(calls.length, before + 1, 'raw registered tools delegate input validation to MCP');
          const disposeGuard = ctx.tools.guard(exec => exec.name === name ? 'fixture policy denial' : undefined);
          try {
            const deniedByPolicy = mode === 'ptc'
              ? await run(agent, `return await tools.mcp_execute_tool({name:${JSON.stringify(name)},arguments:{text:'policy'}});`)
              : await call(agent, 'mcp_execute_tool', { name, arguments: { text: 'policy' } });
            assert.equal(deniedByPolicy.isError, true);
            assert.match(text(deniedByPolicy), /fixture policy denial/);
            assert.equal(calls.length, before + 1, 'broker must not bypass host policy');
          } finally { disposeGuard(); }
        }
        const direct = mode === 'ptc'
          ? await run(agent, "return await tools.mcp__one__echo_00({text:'direct'});")
          : await call(agent, 'mcp__one__echo_00', { text: 'direct' });
        if (enabled && mode === 'native') {
          assert.equal(direct.isError, true);
          assert.match(text(direct), /use mcp_execute_tool/);
        } else assert.match(text(ok(direct)), /one:echo_00:direct/);
        const sdkBytes = Buffer.byteLength(sdk);
        metrics.push({ mode, enabled, catalog: 69, isolatedCatalog: 35, wireMcpSchemas: rawWireCount, brokerWireSchemas: names.filter(name => /^mcp_(search|describe|execute)/.test(name)).length, sdkMcpTools: mcpNames.filter(name => sdk.includes(name + '(') || sdk.includes(name + ':')).length, sdkBytes, mcpWireSchemaBytes: Buffer.byteLength(JSON.stringify(assembly.tools.filter(tool => tool.name.startsWith('mcp')))) });
      }
    }
    // Other waterfall participants can replace the SDK with a custom prompt.
    await api('POST', '/settings/on-demand', { enabled: true });
    const custom = await create('ptc', false, true);
    const customAssembly = await assemble(custom);
    assert.equal(customAssembly.sections.find(section => section.name === 'tools:sdk').text, '');
    assert.deepEqual(customAssembly.tools.map(tool => tool.name), ['run_code']);
    assert.match(text(ok(await run(custom, "return await tools.mcp__one__echo_00({text:'custom'});"))), /one:echo_00:custom/);
    assert.equal(calls.some(call => ['leak', 'policy'].includes(call.arguments.text)), false);
    const expected = __EXPECTED__;
    assert.deepEqual(metrics.map(({ mode, enabled, wireMcpSchemas, brokerWireSchemas, sdkMcpTools }) => ({ mode, enabled, wireMcpSchemas, brokerWireSchemas, sdkMcpTools })), expected[version]);
    for (const row of metrics.filter(row => row.enabled && row.mode !== 'native')) {
      assert.ok(row.sdkBytes > metrics.find(other => other.mode === row.mode && !other.enabled).sdkBytes, 'the broker adds SDK declarations; it does not compress the catalog');
    }
    const state = JSON.parse(readFileSync(join(scratch, '.dsh/mcp-manager.json')));
    assert.equal(state.servers.length, 2);
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({ ok: true, dsh: version, node: process.versions.node, platform: process.platform, runtime: { language: ctx.ptcRuntime.language, programFormat: ctx.ptcRuntime.programFormat }, metrics, customSdk: 'callable', validation: 'MCP schema error propagated (raw register does not validate input)', policy: 'blocked before MCP', isolation: 'server two excluded in second workspace', modelRequests: 0 }));
  } catch (error) {
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({ ok: false, error: error.stack }));
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
