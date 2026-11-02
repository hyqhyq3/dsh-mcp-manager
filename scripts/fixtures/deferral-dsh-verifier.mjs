// Copied into a disposable profile by scripts/verify-deferral-dsh.mjs.
// The two placeholders are replaced before Cordis loads this module.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const [, minor, rawPatch] = version.split('.');
  const patch = parseInt(rawPatch, 10);
  // 0.2.2 moved the model-facing tool list out of the waterfall payload: the
  // registry assembles it afterwards, so `deferLoading` has to do the hiding.
  // 0.2.1 and older still pass `tools` through the waterfall and are filtered
  // there. Version gate matches the documented boundary.
  const registryAssembly = Number(minor) > 2 || (Number(minor) === 2 && patch >= 2);
  // DSH 0.2 selects a presentation by mounting an executor in the agent scope.
  // A hoisted npm/npx prefix puts the sibling package next to `dsh`; a nested
  // install keeps it under `dsh/node_modules`. Accept both layouts.
  const presentationFile = [
    join(dshRoot, '..', 'dsh-agent-tool-presentation', 'lib', 'index.js'),
    join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-agent-tool-presentation', 'lib', 'index.js'),
  ].find(candidate => existsSync(candidate));
  assert.ok(presentationFile, `cannot locate @deepseek-ai/dsh-agent-tool-presentation from ${dshRoot}`);
  const presentation = await import(pathToFileURL(presentationFile).href);
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
    // The regression under test: 0.2.2 no longer hands the tool list to this
    // waterfall, so reading it threw on every prompt assembly (0.2.1 still does).
    const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent });
    // Send the same dual shape the plugin sends: 0.2.2 reads the single-call
    // batch (`calls`), 0.2.1 and older read the flat fields.
    const execute = async (agent, name, args) => {
      const callId = `deferral-${++sequence}`;
      const settled = await ctx.tools.execute({
        calls: [{ id: callId, name, arguments: JSON.stringify(args) }],
        callId,
        name,
        arguments: args,
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

    // Enabling the broker hides the direct tools. 0.2.2+ keeps the definitions in
    // the assembly but marks them `deferLoading`; 0.2.1 and older filter the
    // waterfall payload, so they are absent from the model-facing list.
    await api('POST', '/settings/on-demand', { enabled: true });
    assembly = await assemble(native);
    evidence.directToolsInAssemblyWhileEnabled = direct(assembly).length;
    evidence.deferLoadingMarked = direct(assembly).filter(tool => tool.deferLoading === true).length;
    if (registryAssembly) {
      assert.equal(evidence.directToolsInAssemblyWhileEnabled, 2, 'the registry assembly keeps the deferred definitions');
      assert.equal(evidence.deferLoadingMarked, 2, 'the broker must mark direct tools deferLoading');
    } else {
      assert.equal(evidence.directToolsInAssemblyWhileEnabled, 0, 'the waterfall filter removes direct tools');
      assert.equal(evidence.deferLoadingMarked, 0);
    }
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
      contract: registryAssembly
        ? 'registry assembly: direct tools stay registered with deferLoading'
        : 'waterfall filter: direct tools removed from the Assembly payload',
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
