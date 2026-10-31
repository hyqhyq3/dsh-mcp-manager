// Copied into a disposable profile by scripts/verify-deferral-dsh.mjs.
// The two placeholders are replaced before Cordis loads this module.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'deferral-verifier';
export const inject = ['agents', 'tools', 'systemPrompt', 'webServer', 'ptcRuntime'];
export function apply(ctx) {
  void verify(ctx);
}

async function verify(ctx) {
  const scratch = __SCRATCH__;
  const version = __VERSION__;
  const dshRoot = __DSH_ROOT__;
  // DSH 0.2 selects a presentation by mounting an executor in the agent scope.
  const presentation = await import(pathToFileURL(join(dshRoot, 'node_modules/@deepseek-ai/dsh-agent-tool-presentation/lib/index.js')).href);
  const handles = [];
  let sequence = 0;
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    const owner = req.url.slice(1);
    let result = {};
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: owner, version: '1' } };
    if (message.method === 'tools/list') result = {
      tools: ['echo_a', 'echo_b'].map(tool => ({
        name: tool,
        description: `${tool} on ${owner}`,
        inputSchema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      })),
    };
    if (message.method === 'tools/call') {
      calls.push({ owner, name: message.params.name, arguments: message.params.arguments });
      result = { content: [{ type: 'text', text: `${owner}:${message.params.name}:${message.params.arguments.text}` }] };
    }
    res.writeHead(message.id === undefined ? 202 : 200, { 'Content-Type': 'application/json' });
    res.end(message.id === undefined ? undefined : JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const until = async predicate => {
    for (let index = 0; index < 200; index += 1) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('condition timed out');
  };
  const evidence = {};
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = () => `http://127.0.0.1:${ctx.webServer.port}`;
    await until(async () => ctx.webServer.port && (await fetch(origin() + '/mcp-manager/api/ping')).ok);
    const api = async (method, path, body) => {
      const response = await fetch(origin() + '/mcp-manager/api' + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };

    const { server: added } = await api('POST', '/servers', { name: 'defer', type: 'http', authMode: 'none', url: `http://127.0.0.1:${server.address().port}/defer` });
    const connected = await api('POST', `/servers/${added.id}/connect`);
    assert.equal(connected.server.status, 'connected', connected.server.error);

    const create = async (mode, label) => {
      const workspace = join(scratch, `ws-${label}`);
      mkdirSync(join(workspace, '.dsh/dshmm'), { recursive: true });
      writeFileSync(join(workspace, '.dsh/dshmm/mcp.json'), JSON.stringify({ mcpServers: {}, exclude: [] }));
      const handle = await ctx.agents.create({
        sessionId: `deferral-${++sequence}`,
        meta: { cwd: workspace },
        setup(agentCtx) { if (mode === 'ptc') agentCtx.plugin(presentation, { mode: 'ptc' }); },
      });
      handles.push(handle);
      return handle.agent;
    };
    // The regression under test: DSH 0.2 never passes `tools` to this waterfall,
    // so reading it threw on every prompt assembly.
    const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent });
    // DSH 0.2 dispatches one batch per step; a single-call batch is the same path.
    const execute = async (agent, name, args) => {
      const settled = await ctx.tools.execute({
        calls: [{ id: `deferral-${++sequence}`, name, arguments: JSON.stringify(args) }],
        agent,
        signal: new AbortController().signal,
      });
      return Array.isArray(settled?.results) ? settled.results[0]?.result : settled;
    };
    const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const direct = assembly => assembly.tools.filter(tool => tool.name.startsWith('mcp__'));

    await api('POST', '/settings/on-demand', { enabled: false });
    const native = await create('native', 'native');
    let assembly = await assemble(native);
    assert.equal(direct(assembly).length, 2, 'both direct tools are visible while the broker is off');
    assert.equal(direct(assembly).every(tool => tool.deferLoading === undefined), true);
    const before = await execute(native, 'mcp__defer__echo_a', { text: 'direct' });
    assert.equal(before.isError, false, JSON.stringify(before));

    // Enabling the broker marks the direct tools deferred; the mark survives the
    // harness's schema projection but the definitions stay executable.
    await api('POST', '/settings/on-demand', { enabled: true });
    assembly = await assemble(native);
    evidence.markedWhileEnabled = direct(assembly).every(tool => tool.deferLoading === true);
    assert.equal(evidence.markedWhileEnabled, true, 'the broker must mark direct tools deferred');
    const brokerTools = assembly.tools.filter(tool => /^mcp_(search_tools|describe_tool|execute_tool)$/.test(tool.name));
    assert.equal(brokerTools.length, 3);
    assert.equal(brokerTools.every(tool => tool.deferLoading === undefined), true);
    const denied = await execute(native, 'mcp__defer__echo_a', { text: 'direct' });
    assert.equal(denied.isError, true, 'a native session may not call a direct MCP tool');
    assert.match(text(denied), /use mcp_execute_tool/);
    const dispatched = await execute(native, 'mcp_execute_tool', { name: 'mcp__defer__echo_a', arguments: { text: 'broker' } });
    assert.equal(dispatched.isError, false, JSON.stringify(dispatched));
    assert.match(JSON.stringify(dispatched.value), /defer:echo_a:broker/);

    // A code presentation keeps calling the catalog from inside its program.
    const ptc = await create('ptc', 'ptc');
    const ptcAssembly = await assemble(ptc);
    assert.deepEqual(ptcAssembly.tools.map(tool => tool.name), ['run_code']);
    const viaCode = await execute(ptc, 'run_code', { code: "return await tools.mcp__defer__echo_b({text: 'ptc'});", description: 'direct call from a program' });
    assert.equal(viaCode.isError, false, JSON.stringify(viaCode));
    assert.match(JSON.stringify(viaCode.value), /defer:echo_b:ptc/);

    // Turning the broker off restores the direct surface without a reconnect.
    await api('POST', '/settings/on-demand', { enabled: false });
    assembly = await assemble(native);
    evidence.unmarkedAfterDisable = direct(assembly).every(tool => tool.deferLoading === undefined);
    assert.equal(evidence.unmarkedAfterDisable, true, 'the toggle must re-register definitions');
    const restored = await execute(native, 'mcp__defer__echo_a', { text: 'again' });
    assert.equal(restored.isError, false, JSON.stringify(restored));

    assert.equal(calls.filter(call => call.arguments.text === 'broker').length, 1);
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({
      ok: true,
      dsh: version,
      node: process.versions.node,
      platform: process.platform,
      assemblyWithoutTools: 'waterfall payload never carried `tools`',
      ...evidence,
      brokerDispatch: 'mcp_execute_tool reached the MCP server',
      ptcDirect: 'run_code reached the MCP server',
      modelRequests: 0,
    }));
  } catch (error) {
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({ ok: false, error: error.stack }));
  } finally {
    for (const handle of handles.reverse()) await handle.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
