import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// These cases need the SSE session to react to its own stream dying, so they are
// kept apart from the basic transport tests — those must also pass on a tree that
// has the SSE transport but not yet the reconnect layer.
//
// STATE_PATH is derived from homedir() at module-evaluation time, and on Windows
// os.homedir() reads USERPROFILE, so pin all three before the dynamic import.
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-sse-life-'));
process.env.HOME = SCRATCH_HOME;
process.env.USERPROFILE = SCRATCH_HOME;
process.env.DSH_HOME = SCRATCH_HOME;
mkdirSync(join(SCRATCH_HOME, '.dsh'), { recursive: true });

const TOKEN = 'sse-life-token';

/** SSE server whose tools/call is answered unless told to hold it. */
function startSseServer({ holdCalls = false } = {}) {
  const sessions = new Map();
  let sessionOpens = 0;
  const tools = [
    { name: 'proxy_history', description: 'Get proxy history', inputSchema: { type: 'object', properties: {} } },
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if ((req.headers['authorization'] ?? '') !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
    }
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sessionId = randomUUID();
      sessions.set(sessionId, { res });
      sessionOpens += 1;
      res.write(`event: endpoint\ndata: ?sessionId=${sessionId}\n\n`);
      req.on('close', () => sessions.delete(sessionId));
      return;
    }
    if (req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) { res.writeHead(400); return res.end('sessionId query parameter is not provided'); }
      const session = sessions.get(sessionId);
      if (!session) { res.writeHead(404); return res.end('unknown session'); }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.writeHead(202); res.end();
        const message = JSON.parse(body);
        const reply = (result) => session.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        if (message.method === 'initialize') {
          reply({ protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1' } });
        } else if (message.method === 'tools/list') {
          reply({ tools });
        } else if (message.method === 'tools/call' && !holdCalls) {
          reply({ content: [{ type: 'text', text: `called ${message.params?.name}` }] });
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/sse`,
      sessionOpens: () => sessionOpens,
      /** Kill every open stream the way a proxy restart or a server reload would. */
      dropStreams: () => { for (const s of sessions.values()) { try { s.res.destroy(); } catch {} } sessions.clear(); },
      close: () => new Promise((done) => { for (const s of sessions.values()) { try { s.res.destroy(); } catch {} } server.close(done); }),
    }));
  });
}

/** Write a one-server state file and mount the plugin against it. */
async function loadWith(serverConfig) {
  writeFileSync(
    join(SCRATCH_HOME, '.dsh', 'mcp-manager.json'),
    JSON.stringify({ servers: [{ id: 'sse-life', ...serverConfig }] }, null, 2),
  );
  const registered = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
      restrict: () => () => {},
      schemas: () => [],
      get: () => undefined,
      execute: async () => ({}),
    },
    webServer: { register: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    inject: () => ({ dispose: () => {} }),
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
  };
  const mod = await import(`../lib/index.js?life=${randomUUID()}`);
  mod.apply(ctx);
  return { registered, dispose: () => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } } };
}

const waitFor = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe('HTTP-with-SSE session lifetime', () => {
  it('reconnects by itself when the session stream is closed by the server', async (t) => {
    const fake = await startSseServer();
    t.after(() => fake.close());

    const { registered, dispose } = await loadWith({ name: 'dropSrv', type: 'http', url: fake.url, authMode: 'static', staticToken: TOKEN });
    t.after(dispose);

    assert.equal(await waitFor(() => registered.has('mcp__dropSrv__proxy_history')), true, 'must connect first');
    const opensBefore = fake.sessionOpens();
    assert.equal(opensBefore, 1);

    fake.dropStreams();

    assert.equal(await waitFor(() => fake.sessionOpens() > opensBefore, 20000), true,
      `expected an automatic reconnect; sessions opened = ${fake.sessionOpens()}`);
    assert.equal(await waitFor(() => registered.has('mcp__dropSrv__proxy_history'), 10000), true,
      `tools must come back after the reconnect; registered=[${[...registered.keys()].join(', ')}]`);
  });

  it('fails in-flight calls fast when the stream drops, instead of blocking until timeout', async (t) => {
    const fake = await startSseServer({ holdCalls: true });
    t.after(() => fake.close());

    const { registered, dispose } = await loadWith({ name: 'hangSrv', type: 'http', url: fake.url, authMode: 'static', staticToken: TOKEN });
    t.after(dispose);

    assert.equal(await waitFor(() => registered.has('mcp__hangSrv__proxy_history')), true, 'must connect first');
    const definition = registered.get('mcp__hangSrv__proxy_history');

    // Fire a call the server will never answer, then drop the stream under it.
    const call = definition.execute({}).then(() => 'resolved', (error) => `rejected: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fake.dropStreams();

    const settled = await Promise.race([
      call,
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
    assert.match(String(settled), /rejected/, `the call must fail fast; got: ${settled}`);
  });
});
