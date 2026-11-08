import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

// STATE_PATH is derived from homedir() at module evaluation: HOME on POSIX,
// USERPROFILE on Windows. Pin both before importing; DSH_HOME alone is not enough.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-fence-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));
mkdirSync(join(scratchHome, '.dsh'), { recursive: true });

const { apply } = await import('../lib/index.js');

// Split into parts so the suite never depends on one exact literal surviving.
const ACCESS_TOKEN = ['example', '-access', '-token'].join('');
const REFRESH_TOKEN = ['example', '-refresh', '-token'].join('');

/**
 * The cookie the connection-fence stub treats as a logged-in session. Requests
 * without it (or with a different one) are what an unauthenticated or
 * cross-site client would send.
 */
const SESSION_COOKIE = 'dsh=browser-session';

/**
 * Fence stub mirroring the composition's connection service contract
 * (in @deepseek-ai/dsh-client-connection): requestRejection returns undefined
 * when the request is admitted, or the status to reject with. The real service
 * adds the Host/Origin fence and DSH login admission; this stub models "logged
 * in" versus everything else as one verdict line.
 */
const denyUnless = (cookie) => (req) => (req.headers.cookie === cookie ? undefined : 401);

/** Minimal ctx: enough for apply() to mount its route without a real harness. */
function makeCtx({ fence } = {}) {
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: (name) => (name === 'connection' && fence ? { requestRejection: fence } : undefined),
    on: () => () => {},
    // The plugin injects 'webServer' lazily (it is optional), so hand the
    // callback a child ctx exposing the stubbed webserver.
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({
          webServer: ctx.webServer,
          get: (name) => (name === 'connection' && fence ? { requestRejection: fence } : undefined),
          effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
        });
      }
      return { dispose: () => {} };
    },
    effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  };
  apply(ctx);
  return { routes, handler: routes[0]?.handler };
}

/** Call the mounted route with a minimal req/res pair; returns the raw body too. */
async function request(handler, method, path, body, headers = {}) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of payload) yield chunk; },
  };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; },
    end(chunk) { this.body = chunk ?? ''; },
  };
  await handler(req, res);
  let json;
  try { json = res.body ? JSON.parse(res.body) : undefined; } catch {}
  return { code: res.code, json, text: String(res.body) };
}

/**
 * One dependency-free server playing the MCP + OAuth issuer roles, same shape
 * as the issuer stub in oauth-discovery.test.js: dynamic registration, PKCE,
 * token endpoint, and an MCP endpoint that answers initialize/tools-list with
 * the issued Bearer token.
 */
function startStub() {
  const forms = [];
  const registrations = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const base = `http://127.0.0.1:${server.address().port}`;

      if (req.url === '/mcp') {
        if (req.headers.authorization === `Bearer ${ACCESS_TOKEN}`) {
          const message = JSON.parse(raw || '{}');
          if (message.id === undefined) return send(202, '');
          const result = message.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fence-oauth', version: '1' } }
            : message.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : {};
          return send(200, { jsonrpc: '2.0', id: message.id, result });
        }
        return send(401, { error: 'unauthorized' }, {
          'WWW-Authenticate': `Bearer error="invalid_request", error_description="No access token was provided in this request", resource_metadata=` +
            `"${base}/.well-known/oauth-protected-resource/mcp"`,
        });
      }
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        return send(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/login/oauth`] });
      }
      if (req.url === '/.well-known/oauth-protected-resource') return send(404, { error: 'not found' });
      if (req.url === '/.well-known/oauth-authorization-server/login/oauth') {
        return send(200, {
          issuer: `${base}/login/oauth`,
          authorization_endpoint: `${base}/login/oauth/authorize`,
          token_endpoint: `${base}/login/oauth/access_token`,
          code_challenge_methods_supported: ['S256'],
          registration_endpoint: `${base}/register`,
        });
      }
      if (req.url === '/.well-known/oauth-authorization-server') return send(404, { error: 'not found' });
      if (req.url === '/register') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        registrations.push(payload);
        if (!Array.isArray(payload.redirect_uris) || payload.redirect_uris.length === 0) return send(400, { error: 'invalid_client_metadata' });
        return send(201, { client_id: 'dcr-client', redirect_uris: payload.redirect_uris });
      }
      if (req.url === '/login/oauth/access_token') {
        forms.push(new URLSearchParams(raw));
        return send(200, { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, token_type: 'bearer', expires_in: 3600 });
      }
      return send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, mcpUrl: `${base}/mcp`, forms, registrations, async close() {
        server.closeAllConnections?.();
        await new Promise((done) => server.close(done));
      } });
    });
  });
}

it('issue #31: without a connection service the admin API fails closed with 503', async () => {
  const { handler } = makeCtx();
  for (const [method, path, body] of [
    ['GET', '/mcp-manager/api/ping'],
    ['GET', '/mcp-manager/api/servers'],
    ['POST', '/mcp-manager/api/settings/on-demand', { enabled: true }],
  ]) {
    const out = await request(handler, method, path, body);
    assert.equal(out.code, 503, `${method} ${path}: ${out.text}`);
    assert.equal(out.json?.error, 'DSH authentication required', out.text);
    assert.equal(out.json?.ok, undefined, out.text);
    assert.equal(out.json?.servers, undefined, out.text);
  }
});

it('issue #31: unauthenticated admin requests are rejected with 401 and leak no config', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx({ fence: denyUnless(SESSION_COOKIE) });

  const ping = await request(handler, 'GET', '/mcp-manager/api/ping');
  assert.equal(ping.code, 401, ping.text);
  assert.ok(!('ok' in (ping.json ?? {})), ping.text);

  const servers = await request(handler, 'GET', '/mcp-manager/api/servers');
  assert.equal(servers.code, 401, servers.text);
  assert.equal(servers.json?.servers, undefined, 'server configs must not leak');

  const del = await request(handler, 'DELETE', '/mcp-manager/api/servers/whatever');
  assert.equal(del.code, 401, del.text);

  const onDemand = await request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true });
  assert.equal(onDemand.code, 401, onDemand.text);
});

it('issue #31: untrusted-host rejections propagate their status (403)', async () => {
  const { handler } = makeCtx({ fence: () => 403 });
  const out = await request(handler, 'GET', '/mcp-manager/api/servers');
  assert.equal(out.code, 403, out.text);
  assert.equal(out.json?.servers, undefined, out.text);
});

it('issue #31: a logged-in session passes the fence', async () => {
  const { handler } = makeCtx({ fence: denyUnless(SESSION_COOKIE) });
  const ping = await request(handler, 'GET', '/mcp-manager/api/ping', undefined, { cookie: SESSION_COOKIE });
  assert.equal(ping.code, 200, ping.text);
  assert.equal(ping.json?.ok, true, ping.text);
  const servers = await request(handler, 'GET', '/mcp-manager/api/servers', undefined, { cookie: SESSION_COOKIE });
  assert.equal(servers.code, 200, servers.text);
  assert.deepEqual(servers.json?.servers, [], servers.text);
});

it('issue #31: OAuth callback with a valid pending state completes without a session', async (t) => {
  const stub = await startStub();
  const { handler } = makeCtx({ fence: denyUnless(SESSION_COOKIE) });

  // Set the flow up as a logged-in browser would.
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'fence-oauth', type: 'http', url: stub.mcpUrl }, { cookie: SESSION_COOKIE });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  t.after(async () => {
    await request(handler, 'DELETE', `/mcp-manager/api/servers/${id}`, undefined, { cookie: SESSION_COOKIE });
    await stub.close();
  });
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, { cookie: SESSION_COOKIE });
  assert.equal(auth.code, 200, auth.text);
  const state = new URL(auth.json.authorizeUrl).searchParams.get('state');
  assert.ok(state, auth.text);

  // The IdP redirect lands without any DSH session: possession of the exact
  // pending state is the only credential, and the exchange must still run.
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=synthetic-code&state=${state}`);
  assert.match(callback.text, /Authorized/, callback.text);
  assert.equal(stub.forms.length, 1, 'a valid-state callback must exchange its code');
});

it('issue #31: callback forgery (wrong state, unknown server, non-GET) is rejected without a session', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx({ fence: denyUnless(SESSION_COOKIE) });

  const post = await request(handler, 'POST', '/mcp-manager/callback/x?code=synthetic-code&state=forged');
  assert.equal(post.code, 401, post.text);

  const unknown = await request(handler, 'GET', '/mcp-manager/callback/nonexistent?code=synthetic-code&state=whatever');
  assert.equal(unknown.code, 401, unknown.text);

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'fence-forged', type: 'http', url: stub.mcpUrl }, { cookie: SESSION_COOKIE });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  t.after(async () => {
    await request(handler, 'DELETE', `/mcp-manager/api/servers/${id}`, undefined, { cookie: SESSION_COOKIE });
    await stub.close();
  });
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, { cookie: SESSION_COOKIE });
  assert.equal(auth.code, 200, auth.text);

  const wrongState = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=synthetic-code&state=forged`);
  assert.equal(wrongState.code, 401, wrongState.text);
  assert.equal(stub.forms.length, 0, 'a forged callback must never exchange a code');

  const missingState = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=synthetic-code`);
  assert.equal(missingState.code, 401, missingState.text);
});
