import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// STATE_PATH is derived from homedir() when the module is evaluated, so point the
// home environment at a scratch directory *before* the dynamic import below.
// On Windows `os.homedir()` reads USERPROFILE, not HOME 鈥?set both, plus DSH_HOME,
// so a run can never touch the real ~/.dsh (see AGENTS.md).
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-sse-home-'));
process.env.HOME = SCRATCH_HOME;
process.env.USERPROFILE = SCRATCH_HOME;
process.env.DSH_HOME = SCRATCH_HOME;
mkdirSync(join(SCRATCH_HOME, '.dsh'), { recursive: true });

const TOKEN = 'sse-transport-token';

/** Minimal HTTP-with-SSE server, mirroring BurpMCP-Ultra's observable behavior. */
function startSseServer({ holdCalls = false, protocolVersion = '2025-03-26' } = {}) {
  const sessions = new Map();   // sessionId -> { res }
  let posted = 0;
  const tools = [
    { name: 'proxy_history', description: 'Get proxy history', inputSchema: { type: 'object', properties: { count: { type: 'integer' } } } },
    { name: 'burp_shutdown', description: 'Shut Burp down', inputSchema: { type: 'object', properties: {} } },
  ];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const authorized = (req.headers['authorization'] ?? '') === `Bearer ${TOKEN}`;
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unauthorized: missing or invalid token' }));
    }
    // A bare POST must fail with the sessionId complaint, exactly like BurpMCP-Ultra.
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const sessionId = randomUUID();
      sessions.set(sessionId, { res });
      res.write(`event: endpoint\ndata: ?sessionId=${sessionId}\n\n`);
      req.on('close', () => sessions.delete(sessionId));
      return;
    }
    if (req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' });
        return res.end('sessionId query parameter is not provided');
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
        return res.end('unknown session');
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        posted += 1;
        // 202 with an empty body: the reply travels the stream, not this response.
        res.writeHead(202, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end();
        const message = JSON.parse(body);
        const reply = (result) => session.res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
        if (message.method === 'initialize') {
          reply({ protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake-burpmcp', version: '1' } });
        } else if (message.method === 'tools/list') {
          reply({ tools });
        } else if (message.method === 'tools/call') {
          // holdCalls models a request the server accepts but never answers, so a
          // dropped stream can be observed failing it fast.
          if (!holdCalls) reply({ content: [{ type: 'text', text: `called ${message.params?.name}` }] });
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/sse`,
      posts: () => posted,
      close: () => new Promise((done) => { for (const s of sessions.values()) { try { s.res.destroy(); } catch {} } server.close(done); }),
    }));
  });
}

/** Mount the plugin over a stub ctx (same shape as agent-setup-compat.test.js). */
function mount(registered) {
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
  return { ctx, dispose: () => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } } };
}

/** Write a one-server state file and load the plugin against it. */
async function loadWith(serverConfig) {
  writeFileSync(
    join(SCRATCH_HOME, '.dsh', 'mcp-manager.json'),
    JSON.stringify({ servers: [{ id: 'sse-test', ...serverConfig }] }, null, 2),
  );
  const registered = new Map();
  const { ctx, dispose } = mount(registered);
  const mod = await import(`../lib/index.js?case=${randomUUID()}`);
  mod.apply(ctx);
  // apply() connects asynchronously; give it room, then read the outcome.
  return { registered, dispose, statePath: join(SCRATCH_HOME, '.dsh', 'mcp-manager.json') };
}

const waitFor = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
};

describe('HTTP-with-SSE transport', () => {
  it('connects to a server that answers a bare POST with a sessionId complaint', async (t) => {
    const fake = await startSseServer();
    t.after(() => fake.close());

    const { registered, dispose } = await loadWith({ name: 'sseSrv', type: 'http', url: fake.url, authMode: 'static', staticToken: TOKEN });
    t.after(dispose);

    const connected = await waitFor(() => registered.size >= 2);
    assert.equal(connected, true, `expected the SSE session to register tools; got [${[...registered.keys()].join(', ')}]`);
    assert.equal(registered.has('mcp__sseSrv__proxy_history'), true);
    assert.equal(registered.has('mcp__sseSrv__burp_shutdown'), true);
    // The session must have been driven over POST-with-sessionId, not a bare POST.
    assert.ok(fake.posts() >= 2, `expected initialize + tools/list over the session; saw ${fake.posts()} posts`);
  });

  it('runs tools/call over the session and returns the streamed reply', async (t) => {
    const fake = await startSseServer();
    t.after(() => fake.close());

    const { registered, dispose } = await loadWith({ name: 'sseCall', type: 'http', url: fake.url, authMode: 'static', staticToken: TOKEN });
    t.after(dispose);

    assert.equal(await waitFor(() => registered.has('mcp__sseCall__proxy_history')), true, 'tool must register first');
    const definition = registered.get('mcp__sseCall__proxy_history');
    const result = await definition.execute({ count: 1 });
    assert.match(result.text, /called proxy_history/);
    assert.equal(result.isError, false);
  });

  it('still uses Streamable HTTP when the server answers a POST with JSON', async (t) => {
    // Same shape as before, but the POST replies inline 鈥?no SSE session needed.
    let sessionSeq = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const message = JSON.parse(body);
        const headers = { 'Content-Type': 'application/json' };
        if (message.method === 'initialize') headers['Mcp-Session-Id'] = `hs-${++sessionSeq}`;
        res.writeHead(200, headers);
        if (message.method === 'initialize') {
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'http-srv', version: '1' } } }));
        }
        if (message.method === 'tools/list') {
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'http_tool', description: 'x', inputSchema: { type: 'object', properties: {} } }] } }));
        }
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const { registered, dispose } = await loadWith({ name: 'httpSrv', type: 'http', url: `http://127.0.0.1:${server.address().port}/`, authMode: 'static', staticToken: 'anything' });
    t.after(dispose);

    assert.equal(await waitFor(() => registered.has('mcp__httpSrv__http_tool')), true, 'the Streamable HTTP path must stay intact');
  });

  it('surfaces the server鈥檚 own 401 wording instead of a bare generic message', async (t) => {
    const fake = await startSseServer();
    t.after(() => fake.close());

    // Wrong token: the SSE GET is rejected, so nothing registers 鈥?but the reason
    // must survive into the log rather than being flattened to "authentication required".
    const logged = [];
    writeFileSync(
      join(SCRATCH_HOME, '.dsh', 'mcp-manager.json'),
      JSON.stringify({ servers: [{ id: 'bad-token', name: 'badSrv', type: 'http', url: fake.url, authMode: 'static', staticToken: 'WRONG' }] }, null, 2),
    );
    const registered = new Map();
    const disposers = [];
    const ctx = {
      logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
      tools: { register: () => () => {}, restrict: () => () => {}, schemas: () => [], get: () => undefined, execute: async () => ({}) },
      webServer: { register: () => () => {} },
      get: () => undefined,
      on: () => () => {},
      inject: () => ({ dispose: () => {} }),
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
    };
    const mod = await import(`../lib/index.js?case=${randomUUID()}`);
    mod.apply(ctx);
    t.after(() => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } });

    assert.equal(await waitFor(() => logged.some((line) => /missing or invalid token/.test(line))), true,
      `expected the server wording in the log; got: ${logged.join(' | ')}`);
    assert.equal(registered.size, 0);
  });

  it('warns when the server selects a different protocol revision', async (t) => {
    const fake = await startSseServer({ protocolVersion: '2099-01-01' });
    t.after(() => fake.close());

    const logged = [];
    writeFileSync(
      join(SCRATCH_HOME, '.dsh', 'mcp-manager.json'),
      JSON.stringify({ servers: [{ id: 'proto', name: 'protoSrv', type: 'http', url: fake.url, authMode: 'static', staticToken: TOKEN }] }, null, 2),
    );
    const disposers = [];
    const ctx = {
      logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
      tools: { register: () => () => {}, restrict: () => () => {}, schemas: () => [], get: () => undefined, execute: async () => ({}) },
      webServer: { register: () => () => {} },
      get: () => undefined,
      on: () => () => {},
      inject: () => ({ dispose: () => {} }),
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
    };
    const mod = await import(`../lib/index.js?case=${randomUUID()}`);
    mod.apply(ctx);
    t.after(() => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } });

    assert.equal(
      await waitFor(() => logged.some((line) => /requested protocol .*but the server selected 2099-01-01/.test(line))),
      true,
      `expected a protocol-mismatch warning; got: ${logged.join(' | ')}`,
    );
  });
});
