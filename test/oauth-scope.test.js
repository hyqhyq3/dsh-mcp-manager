/**
 * OAuth scope selection (MCP authorization spec) and insufficient-scope
 * recovery, on a TryPost / Laravel MCP + Passport topology:
 *
 * - the MCP endpoint 401s with a resource_metadata pointer and no scope;
 * - the RFC 9728 and RFC 8414 documents both publish `scopes_supported`;
 * - the token endpoint grants exactly the scopes requested at /authorize;
 * - a valid token without `mcp:use` is answered with a bare 403.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, it } from 'node:test';

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-scope-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');

const { apply, parseBearerChallenge, cleanScope, scopeList } = await import('../lib/index.js');

const testDisposers = [];
beforeEach(() => writeFileSync(statePath, JSON.stringify({ servers: [] })));
afterEach(() => { for (const dispose of testDisposers.splice(0).reverse()) dispose(); });

function makeCtx(config) {
  const routes = [];
  const cleanup = [];
  const effect = fn => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    get: () => undefined,
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({ webServer: ctx.webServer, get: () => undefined, effect });
      }
      return { dispose: () => {} };
    },
    effect,
  };
  apply(ctx, config);
  const dispose = () => { for (const fn of cleanup.splice(0).reverse()) fn(); };
  testDisposers.push(dispose);
  return { handler: routes[0]?.handler, dispose };
}

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

const state = () => JSON.parse(readFileSync(statePath, 'utf8'));

function startStub({
  resourceScopes = ['mcp:use'],
  asScopes = ['mcp:use'],
  challengeScope = '',
  required = ['mcp:use'],
  insufficientHeader = false,
  // What the 403 `insufficient_scope` challenge names. RFC 6750 leaves this as
  // the scope required for the request, which a server may report as the
  // *missing* scopes only rather than the full required set.
  missingScopes = required,
} = {}) {
  const authorizeScopes = [];
  const tokenForms = [];
  const tokens = new Map(); // access token -> granted scope list
  let issued = 0;
  let lastRequestedScope = '';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const base = `http://127.0.0.1:${server.address().port}`;
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const url = new URL(req.url, base);

      if (url.pathname === '/mcp/trypost') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!tokens.has(token)) {
          const scopePart = challengeScope ? `, scope="${challengeScope}"` : '';
          return send(401, { message: 'Unauthenticated.' }, {
            'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/trypost"${scopePart}`,
          });
        }
        const granted = tokens.get(token);
        if (!required.every((scope) => granted.includes(scope))) {
          const headers = insufficientHeader
            ? { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${missingScopes.join(' ')}", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/trypost"` }
            : {};
          return send(403, { message: 'MCP OAuth authorization required.' }, headers);
        }
        if (payload.id === undefined) { res.writeHead(202); return res.end(); }
        const result = payload.method === 'initialize'
          ? { protocolVersion: payload.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'trypost-stub', version: '0' } }
          : payload.method === 'tools/list' ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] } : {};
        return send(200, { jsonrpc: '2.0', id: payload.id, result });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp/trypost') {
        const doc = { resource: `${base}/mcp/trypost`, authorization_servers: [base] };
        if (resourceScopes) doc.scopes_supported = resourceScopes;
        return send(200, doc);
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        const doc = {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
        };
        if (asScopes) doc.scopes_supported = asScopes;
        return send(200, doc);
      }
      if (url.pathname === '/oauth/register') return send(201, { client_id: 'trypost-client' });
      if (url.pathname === '/oauth/token') {
        const form = new URLSearchParams(raw);
        tokenForms.push(form);
        issued += 1;
        const access = `access-${issued}`;
        const granted = lastRequestedScope.split(' ').filter(Boolean);
        tokens.set(access, granted);
        return send(200, { access_token: access, refresh_token: `refresh-${issued}`, token_type: 'Bearer', expires_in: 3600, scope: granted.join(' ') });
      }
      return send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        mcpUrl: `${base}/mcp/trypost`,
        authorizeScopes,
        tokenForms,
        // The real AS records the scope from /authorize against the code; the
        // test drives /authorize itself, so it reports what was requested.
        requested(scope) { lastRequestedScope = scope ?? ''; authorizeScopes.push(scope); },
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function addServer(handler, stub, extra = {}) {
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', {
    name: 'trypost', type: 'http', url: stub.mcpUrl, authMode: 'oauth', ...extra,
  });
  assert.equal(created.code, 201, created.text);
  return created.json.server.id;
}

async function authorize(handler, id) {
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  return new URL(auth.json.authorizeUrl);
}

async function login(handler, stub, id, { grant } = {}) {
  const url = await authorize(handler, id);
  stub.requested(grant ?? url.searchParams.get('scope'));
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=stub-code&state=${url.searchParams.get('state')}`);
  assert.match(callback.text, /Authorized/, callback.text);
  return url;
}

async function view(handler, id) {
  const list = await request(handler, 'GET', '/mcp-manager/api/servers');
  return list.json.servers.find((server) => server.id === id);
}

it('parses Bearer challenges and normalizes scopes', () => {
  assert.deepEqual(
    parseBearerChallenge('Bearer realm="mcp", error="insufficient_scope", scope="mcp:use files:read", resource_metadata="https://x.test/a"'),
    { realm: 'mcp', error: 'insufficient_scope', scope: 'mcp:use files:read', resource_metadata: 'https://x.test/a' },
  );
  assert.deepEqual(parseBearerChallenge('Basic realm="x", Bearer scope=read'), { scope: 'read' });
  assert.equal(parseBearerChallenge('Basic realm="x"'), null);
  assert.equal(parseBearerChallenge(''), null);
  assert.equal(cleanScope('  a  b a "bad" c\\d '), 'a b');
  assert.equal(cleanScope('x'.repeat(600)), '');
  assert.deepEqual(scopeList(['mcp:use', 7, 'a b', 'mcp:use']), ['mcp:use', 'a', 'b']);
  assert.deepEqual(scopeList('mcp:use'), []);
});

it('sends scopes_supported from the protected-resource metadata, plus resource, and the token works', async (t) => {
  const stub = await startStub({ resourceScopes: ['mcp:use'], asScopes: ['other:scope'] });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);

  const url = await login(handler, stub, id);
  assert.equal(url.searchParams.get('scope'), 'mcp:use', 'RFC 9728 scopes_supported wins over RFC 8414');
  assert.equal(url.searchParams.get('resource'), stub.mcpUrl);
  assert.equal(stub.tokenForms[0].get('resource'), stub.mcpUrl, 'token request carries resource');

  const connect = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(connect.code, 200, connect.text);
  const row = await view(handler, id);
  assert.equal(row.status, 'connected', row.error);
  assert.equal(row.toolCount, 1);
  assert.equal(state().servers[0].oauth.grantedScope, 'mcp:use');
});

it('falls back to authorization-server scopes_supported, then to no scope', async (t) => {
  const stub = await startStub({ resourceScopes: null, asScopes: ['mcp:use', 'profile'] });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);
  assert.equal((await authorize(handler, id)).searchParams.get('scope'), 'mcp:use profile');

  const bare = await startStub({ resourceScopes: null, asScopes: null, required: [] });
  t.after(() => bare.close());
  const other = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'bare', type: 'http', url: bare.mcpUrl, authMode: 'oauth' });
  const bareUrl = await authorize(handler, other.json.server.id);
  assert.equal(bareUrl.searchParams.get('scope'), null, 'nothing advertised, nothing sent');
});

it('prefers the WWW-Authenticate scope, and a configured scope over everything', async (t) => {
  const stub = await startStub({ challengeScope: 'mcp:use mcp:extra' });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);
  // A first connect without a token collects the 401 challenge.
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(state().servers[0].oauth.challengeScope, 'mcp:use mcp:extra');
  assert.equal((await authorize(handler, id)).searchParams.get('scope'), 'mcp:use mcp:extra');

  const edited = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'trypost', type: 'http', url: stub.mcpUrl, authMode: 'oauth', scope: 'manual:one',
  });
  assert.equal(edited.code, 200, edited.text);
  assert.equal((await authorize(handler, id)).searchParams.get('scope'), 'manual:one');
});

it('reports a bare 403 after login as insufficient scope and recovers on re-authentication', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);

  // Simulate the pre-fix plugin (or a server that silently drops scopes).
  await login(handler, stub, id, { grant: '' });
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  let row = await view(handler, id);
  assert.equal(row.status, 'needs-auth');
  assert.match(row.error, /^insufficient scope \(requires: mcp:use\)/);
  assert.doesNotMatch(row.error, /initialize HTTP 403/);
  assert.deepEqual(row.oauth.insufficientScope, { scope: 'mcp:use' });

  const url = await login(handler, stub, id);
  assert.equal(url.searchParams.get('scope'), 'mcp:use');
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  row = await view(handler, id);
  assert.equal(row.status, 'connected', row.error);
  assert.equal(row.oauth.insufficientScope, null, 'a new grant clears the flag');
});

it('steps up with the scope named by an insufficient_scope challenge', async (t) => {
  const stub = await startStub({ resourceScopes: ['mcp:use'], required: ['mcp:use', 'posts:write'], insufficientHeader: true });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);
  await login(handler, stub, id);
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  const row = await view(handler, id);
  assert.equal(row.status, 'needs-auth');
  assert.match(row.error, /insufficient scope \(requires: mcp:use posts:write\)/);
  const url = await login(handler, stub, id);
  assert.equal(url.searchParams.get('scope'), 'mcp:use posts:write');
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal((await view(handler, id)).status, 'connected');
});

it('adds a challenge that names only the missing scopes to the advertised base', async (t) => {
  // The 403 challenge names only the delta; the RFC 9728 scopes_supported set
  // must survive, or the re-authorization still cannot initialize and the user
  // is trapped in a re-auth loop.
  const stub = await startStub({
    resourceScopes: ['mcp:use'],
    required: ['mcp:use', 'posts:write'],
    insufficientHeader: true,
    missingScopes: ['posts:write'],
  });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);
  await login(handler, stub, id);
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  const row = await view(handler, id);
  assert.equal(row.status, 'needs-auth');
  assert.match(row.error, /insufficient scope \(requires: posts:write\)/);
  const url = await login(handler, stub, id);
  assert.equal(url.searchParams.get('scope'), 'mcp:use posts:write', 'delta challenge extends the base selection');
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal((await view(handler, id)).status, 'connected');
});

it('keeps external edits to the state file and honours a hand-edited oauth.scope', async (t) => {
  const stub = await startStub({ resourceScopes: null, asScopes: null });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const id = await addServer(handler, stub);
  await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'other', type: 'http', url: 'http://127.0.0.1:9/mcp', authMode: 'none' });

  // Edit the file behind the plugin's back.
  const disk = state();
  const row = disk.servers.find((server) => server.id === id);
  row.oauth = { ...(row.oauth ?? {}), scope: 'mcp:use' };
  row.note = 'hand-written';
  disk.customTopLevel = { keep: true };
  writeFileSync(statePath, JSON.stringify(disk, null, 2));

  // Unrelated in-plugin writes must not discard those edits.
  const other = state().servers.find((server) => server.name === 'other');
  const toggled = await request(handler, 'POST', `/mcp-manager/api/servers/${other.id}/enabled`, { enabled: false });
  assert.equal(toggled.code, 200, toggled.text);
  const url = await authorize(handler, id);
  assert.equal(url.searchParams.get('scope'), 'mcp:use', 'oauth.scope from the file is used');

  const after = state();
  const kept = after.servers.find((server) => server.id === id);
  assert.equal(kept.oauth.scope, 'mcp:use');
  assert.equal(kept.note, 'hand-written');
  assert.deepEqual(after.customTopLevel, { keep: true });
  assert.equal(after.servers.find((server) => server.name === 'other').enabled, false);
});
