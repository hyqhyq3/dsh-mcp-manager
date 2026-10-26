import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTimeoutMcp } from __MCP_FIXTURE__;

export const name = 'timeout-verifier';
export const inject = ['agents', 'tools', 'systemPrompt', 'webServer'];
export function apply(ctx) { void verify(ctx); }

async function verify(ctx) {
  const scratch = __SCRATCH__;
  const remotes = [];
  let owned;
  let sequence = 0;
  const contract = [];
  const metrics = [];
  const until = async fn => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await fn()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('timeout verification did not become ready');
  };
  try {
    await until(async () => ctx.webServer.port && (await fetch(ctx.webServer.getOrigin() + '/mcp-manager/api/ping')).ok);
    const api = async (method, path, body) => {
      const response = await fetch(ctx.webServer.getOrigin() + '/mcp-manager/api' + path, {
        method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json();
      assert.ok(response.ok, JSON.stringify(value));
      return value;
    };
    const servers = [];
    for (const type of ['http', 'sse', 'stdio']) {
      let body = { name: 'long_' + type, timeout: 65000 };
      if (type === 'stdio') body = { ...body, type: 'stdio', command: process.execPath, args: [fileURLToPath(__MCP_FIXTURE__), '--stdio'] };
      else {
        const remote = await startTimeoutMcp({ sse: type === 'sse' }); remotes.push(remote);
        body = { ...body, type: 'http', url: remote.url, authMode: 'none' };
      }
      const added = (await api('POST', '/servers', body)).server;
      const connected = (await api('POST', `/servers/${added.id}/connect`)).server;
      assert.equal(connected.status, 'connected', connected.error);
      servers.push({ type, body, server: connected });
    }
    const workspace = join(scratch, 'workspace');
    mkdirSync(join(workspace, '.dsh/dshmm'), { recursive: true });
    writeFileSync(join(workspace, '.dsh/dshmm/mcp.json'), JSON.stringify({ mcpServers: { local: { url: servers[0].body.url, authMode: 'none', timeout: 2000 } } }));
    owned = await ctx.agents.create({ sessionId: 'timeout-isolated', meta: { cwd: workspace } });
    const agent = owned.agent;
    const execute = (name, args) => ctx.tools.execute({ agent, name, arguments: args, callId: 'timeout-' + ++sequence, signal: new AbortController().signal });
    await until(() => agent.ctx.tools.schemas(agent).some(tool => tool.name === 'mcp__local__wait'));
    assert.equal((await execute('mcp__local__wait', { delayMs: 1300 })).isError, false);
    const wsView = (await api('GET', '/workspaces')).workspaces.find(ws => ws.path === workspace).servers[0];
    await api('PUT', '/workspaces/servers', { path: workspace, oldName: 'local', name: 'local', url: servers[0].body.url, authMode: 'none', timeout: 1000 });
    const short = await execute('mcp__local__wait', { delayMs: 1300 });
    assert.equal(short.isError, true);
    assert.match(short.error.message, /timeout after 1000ms/);
    assert.equal((await api('GET', '/workspaces')).workspaces.find(ws => ws.path === workspace).servers[0].timeout, 1000);
    assert.ok(wsView.id);
    contract.push({ case: 'workspace-edit', timeout: 1000, error: short.error.message });

    const runs = servers.map(({ type, body, server }) => (async () => {
      const name = `mcp__${body.name}__wait`;
      const started = Date.now();
      const reply = await execute(name, { delayMs: 61000 });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      assert.equal(reply.value.text, 'finished');
      assert.ok(Date.now() - started >= 60000);
      metrics.push({ case: type, elapsedMs: Date.now() - started });
      contract.push({ case: type, timeout: server.timeout, text: reply.value.text });
    })());
    // The parent broker must also survive the old 60s transport budget.
    await api('POST', '/settings/on-demand', { enabled: true });
    await ctx.systemPrompt.assemble({ agent, scope: agent });
    runs.push((async () => {
      const started = Date.now();
      const reply = await execute('mcp_execute_tool', { name: 'mcp__long_http__wait', arguments: { delayMs: 61000 } });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      assert.match(JSON.stringify(reply.content), /finished/);
      metrics.push({ case: 'broker', elapsedMs: Date.now() - started });
      contract.push({ case: 'broker', text: 'finished' });
    })());
    await Promise.all(runs);
    await api('POST', '/settings/on-demand', { enabled: false });
    for (const { type, body, server } of servers) {
      await api('PUT', `/servers/${server.id}`, { ...body, timeout: '' });
      const started = Date.now();
      const reply = await execute(`mcp__${body.name}__wait`, { delayMs: 1300 });
      assert.equal(reply.isError, true);
      assert.match(reply.error.message, /timeout.*1000ms/);
      assert.ok(Date.now() - started < 2500);
      contract.push({ case: type + '-profile-default', error: reply.error.message });
      assert.equal('timeout' in JSON.parse(readFileSync(join(scratch, '.dsh/mcp-manager.json'))).servers.find(s => s.id === server.id), false);
    }
    contract.sort((a, b) => a.case.localeCompare(b.case));
    assert.deepEqual(contract, __EXPECTED__);
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({ ok: true, dsh: __VERSION__, node: process.version, contract, metrics }));
  } catch (error) {
    writeFileSync(join(scratch, 'result.json'), JSON.stringify({ ok: false, error: error.stack }));
  } finally {
    await owned?.dispose();
    for (const remote of remotes) await remote.close();
  }
}
