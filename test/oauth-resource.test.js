/**
 * RFC 8707 `resource` on the Kontrcheck topology, plus the browser-facing origin
 * and callback safety around it.
 *
 * The stub plays Kontrcheck: the MCP endpoint 401s with a resource_metadata
 * pointer, the protected-resource document names both the authorization server
 * and the resource, the AS advertises registration, the token endpoint refuses a
 * request without the resource, and refresh tokens are single-use.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, readdirSync, rmSync, utimesSync, unlinkSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-resource-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');
const fixture = fileURLToPath(new URL('../test-fixtures/restart-connect.mjs', import.meta.url));

const { apply } = await import('../lib/index.js');

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
        callback({
          webServer: ctx.webServer,
          get: () => undefined,
          effect,
        });
      }
      return { dispose: () => {} };
    },
    effect,
  };
  apply(ctx, config);
  const dispose = () => { for (const fn of cleanup.splice(0).reverse()) fn(); };
  testDisposers.push(dispose);
  return { routes, handler: routes[0]?.handler, dispose };
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

/**
 * A stub that behaves like the Kontrcheck connector: resource-bound tokens,
 * single-use refresh rotation, and an MCP endpoint that only accepts the live
 * access token.
 */
function startStub({ publishResource = true, refreshMode = 'rotate', refreshDelayMs = 0, beforeRefreshReply = () => {} } = {}) {
  const seen = [];
  const tokenForms = [];
  const registerBodies = [];
  let issued = 0;
  const validAccess = new Set();
  let currentRefresh = '';

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push(`${req.method} ${req.url}`);
      const base = `http://127.0.0.1:${server.address().port}`;
      const resource = `${base}/mcp`;
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };

      if (req.url === '/mcp') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!validAccess.has(token)) {
          return send(401, { error: 'unauthorized' }, {
            'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        const result = payload.method === 'initialize'
          ? { protocolVersion: payload.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } }
          : payload.method === 'tools/list' ? { tools: [] } : {};
        if (payload.id === undefined) { res.writeHead(202); return res.end(); }
        return send(200, { jsonrpc: '2.0', id: payload.id, result });
      }
      if (req.url === '/.well-known/oauth-protected-resource/mcp') {
        const doc = { authorization_servers: [base] };
        if (publishResource) doc.resource = `${base}/mcp`;
        return send(200, doc);
      }
      if (req.url === '/.well-known/oauth-protected-resource') return send(404, { error: 'not found' });
      if (req.url === '/.well-known/oauth-authorization-server') {
        return send(200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (req.url === '/register') {
        try { registerBodies.push(JSON.parse(raw || '{}')); } catch { registerBodies.push({}); }
        return send(201, { client_id: 'dcr-client' });
      }
      if (req.url === '/oauth/token') {
        const form = new URLSearchParams(raw);
        tokenForms.push(form);
        if (form.get('resource') !== resource) return send(400, { error: 'invalid_target' });
        if (form.get('grant_type') === 'authorization_code') {
          issued += 1;
          const access = `access-${issued}`;
          const refresh = `refresh-${issued}`;
          validAccess.add(access);
          currentRefresh = refresh;
          return send(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 28800 });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const reply = () => {
            if (refreshMode === 'invalid_grant') return send(400, { error: 'invalid_grant' });
            if (refreshMode === 'unavailable') return send(500, { error: 'temporarily_unavailable' });
            if (form.get('refresh_token') !== currentRefresh) return send(400, { error: 'invalid_grant' });
            issued += 1;
            const access = `access-${issued}`;
            const refresh = `refresh-${issued}`;
            validAccess.add(access);
            currentRefresh = refresh;
            beforeRefreshReply();
            return send(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 28800 });
          };
          if (refreshDelayMs) return setTimeout(reply, refreshDelayMs);
          return reply();
        }
        return send(400, { error: 'unsupported_grant_type' });
      }
      return send(404, { error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base,
        mcpUrl: `${base}/mcp`,
        resource: `${base}/mcp`,
        seen,
        tokenForms,
        registerBodies,
        invalidate() { validAccess.clear(); },
        currentRefresh: () => currentRefresh,
        mint(access, refresh) { validAccess.add(access); currentRefresh = refresh; },
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

async function authorize(handler, id) {
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  return new URL(auth.json.authorizeUrl);
}

async function complete(handler, id, authorizeUrl) {
  const flowState = new URL(authorizeUrl).searchParams.get('state');
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?code=stub-code&state=${flowState}`);
  assert.match(callback.text, /Authorized/, callback.text);
  return callback;
}

it('sends the RFC 8707 resource from the protected-resource document at every step', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', {
    name: 'kontrcheck', type: 'http', url: stub.mcpUrl, authMode: 'oauth', scope: 'kontrcheck.read offline_access',
  });
  assert.equal(created.code, 201);
  const id = created.json.server.id;

  const authorizeUrl = await authorize(handler, id);
  assert.equal(authorizeUrl.searchParams.get('resource'), stub.resource, 'authorize must carry the discovered resource');
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), `http://127.0.0.1:3080/mcp-manager/callback/${id}`);
  assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.deepEqual(stub.registerBodies[0].redirect_uris, [`http://127.0.0.1:3080/mcp-manager/callback/${id}`]);

  assert.equal(stub.tokenForms.length, 0, 'registration alone issues no token');
  await complete(handler, id, authorizeUrl);
  assert.equal(stub.tokenForms.length, 1);
  assert.equal(stub.tokenForms[0].get('grant_type'), 'authorization_code');
  assert.equal(stub.tokenForms[0].get('resource'), stub.resource, 'token exchange must carry the resource');

  const persisted = state().servers.find((s) => s.name === 'kontrcheck');
  assert.equal(persisted.oauth.resource, stub.resource, 'the resource must survive a restart');
  assert.equal(persisted.oauth.tokens.access_token, 'access-1');
  assert.equal(persisted.oauth.tokens.refresh_token, 'refresh-1');

  await stub.close();
});

it('refreshes with the resource, rotates the refresh token, and reuses the rotated one', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'kc2', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  stub.invalidate();
  const first = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(first.code, 200, first.text);
  const refreshOne = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refreshOne.length, 1);
  assert.equal(refreshOne[0].get('resource'), stub.resource, 'refresh must carry the resource');
  assert.equal(refreshOne[0].get('refresh_token'), 'refresh-1');

  const afterFirst = state().servers.find((s) => s.name === 'kc2');
  assert.equal(afterFirst.oauth.tokens.refresh_token, 'refresh-2', 'the rotated token must replace the old one');
  assert.equal(afterFirst.oauth.tokens.access_token, 'access-2');

  stub.invalidate();
  const second = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(second.code, 200, second.text);
  const refreshTwo = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refreshTwo[1].get('refresh_token'), 'refresh-2', 'only the rotated token may be replayed');
  assert.equal(state().servers.find((s) => s.name === 'kc2').oauth.tokens.refresh_token, 'refresh-3');

  // A stale, no-longer-current refresh token is refused by the stub — rotation really happened.
  const replay = await fetch(`${stub.base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'example-stale-refresh', client_id: 'dcr-client', resource: stub.resource }),
  });
  assert.equal(replay.status, 400);

  await stub.close();
});

it('restores a connection in a fresh process without re-registering or losing the resource', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'kc3', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));
  assert.equal(stub.registerBodies.length, 1);

  stub.invalidate();
  const registrationsBefore = stub.registerBodies.length;
  // The stub lives in this process, so the child must run asynchronously: a
  // spawnSync would block the event loop and deadlock the child's HTTP calls.
  let running = null;
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [fixture, id], {
        env: { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome, DSH_HOME: join(scratchHome, '.dsh') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      running = proc;
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk; });
      proc.stderr.on('data', (chunk) => { stderr += chunk; });
      proc.on('error', reject);
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`restart probe timed out: ${stderr}`)); }, 30_000);
      proc.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    });
  } finally {
    // A failed assertion must not leave the stub listening (it would keep the
    // test process alive) nor the probe running.
    if (running && running.exitCode === null) running.kill('SIGKILL');
    if (child === undefined) await stub.close();
  }
  assert.equal(child.status, 0, child.stderr);
  const verdict = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(verdict.code, 200, verdict.body);
  assert.equal(stub.registerBodies.length, registrationsBefore, 'a restart must reuse the registered client');
  const refresh = stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');
  assert.equal(refresh.at(-1).get('resource'), stub.resource, 'the resource must come back from the state file');
  assert.equal(state().servers.find((s) => s.name === 'kc3').oauth.tokens.refresh_token, 'refresh-2');

  await stub.close();
});

it('leaves the flow unchanged when the resource document publishes none', async (t) => {
  const stub = await startStub({ publishResource: false });
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'nores', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  const authorizeUrl = await authorize(handler, id);
  assert.equal(authorizeUrl.searchParams.get('resource'), null, 'nothing is invented without metadata');
  assert.equal(state().servers.find((s) => s.name === 'nores').oauth.resource, undefined);
  await stub.close();
});

it('honours a forwarded origin only when it is explicitly allowed', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx({ publicOrigins: ['https://harness.example.com'] });
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'proxy', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'harness.example.com',
  });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri'), `https://harness.example.com/mcp-manager/callback/${id}`);

  const malformed = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example.com/path',
  });
  assert.equal(malformed.code, 400, malformed.text);
  assert.match(malformed.json.error, /invalid request host/);

  // A well-formed but unlisted host is a redirect attempt, not a proxy hop.
  const unlisted = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'evil.example.com',
  });
  assert.equal(unlisted.code, 200, unlisted.text);
  assert.equal(new URL(unlisted.json.authorizeUrl).searchParams.get('redirect_uri'),
    `https://harness.example.com/mcp-manager/callback/${id}`,
    'an unlisted forwarded host is ignored, and the configured origin names the callback');
  await stub.close();
});

it('ignores forwarded headers entirely when no public origin is configured', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'noproxy', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'harness.roadstash.com',
  });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri'),
    `http://127.0.0.1:3080/mcp-manager/callback/${id}`,
    'without an explicit allowlist the forwarded pair must not be trusted');
  await stub.close();
});

it('keeps the configured https callback when the proxy sends no X-Forwarded-Proto', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx({ publicOrigins: ['https://harness.example.com'] });
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'plain-http', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  // Browsers behind Caddy reach the GUI as plain HTTP on the loopback hop; the
  // forwarded proto may be missing entirely. The configured public origin is the
  // only external address, so it must win instead of the http Host.
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    host: 'harness.example.com',
  });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri'),
    `https://harness.example.com/mcp-manager/callback/${id}`);
  const register = stub.registerBodies.at(-1);
  assert.deepEqual(register.redirect_uris, [`https://harness.example.com/mcp-manager/callback/${id}`],
    'the dynamic registration must declare the https callback');
  await stub.close();
});

it('never turns a foreign Host into the external callback', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx({ publicOrigins: ['https://harness.example.com'] });
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'foreign', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, {
    host: 'evil.example.com',
  });
  assert.equal(auth.code, 200, auth.text);
  const redirect = new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri');
  assert.equal(redirect, `https://harness.example.com/mcp-manager/callback/${id}`);
  assert.ok(!redirect.includes('evil.example.com'), 'a foreign Host must not name the callback');

  // Without a configured public origin there is nothing to fall back to: an
  // external Host is refused rather than adopted.
  const bare = makeCtx();
  const created2 = await request(bare.handler, 'POST', '/mcp-manager/api/servers', { name: 'foreign2', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const refused = await request(bare.handler, 'POST', `/mcp-manager/api/servers/${created2.json.server.id}/auth`, undefined, { host: 'evil.example.com' });
  assert.equal(refused.code, 400, refused.text);
  await stub.close();
});

it('escapes server-supplied text on the callback page', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'xss', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;

  // The authorization server answers with an OAuth error, and that text is what
  // the page prints — it must never be parsed as markup on the GUI origin.
  const callback = await request(handler, 'GET', `/mcp-manager/callback/${id}?error=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E`);
  assert.ok(!callback.text.includes('<img'), 'markup from the query string must not reach the page');
  assert.match(callback.text, /&lt;img/);
  assert.match(callback.text, /Authorization failed/);
  await stub.close();
});

// ---------- refresh safety: one flight, one process at a time ----------

const writeState = (value) => writeFileSync(statePath, JSON.stringify(value, null, 2));
const serverNamed = (name) => state().servers.find((server) => server.name === name);
const refreshForms = (stub) => stub.tokenForms.filter((form) => form.get('grant_type') === 'refresh_token');

function expireSavedPair(name) {
  const st = state();
  const server = st.servers.find((candidate) => candidate.name === name);
  server.oauth.tokens.expires_at = Date.now() - 1000;
  writeState(st);
}

async function runRestartProbe(id) {
  return await new Promise((resolve, reject) => {
    const action = state().servers.find(server => server.id === id)?.enabled === false ? 'enable' : 'connect';
    const proc = spawn(process.execPath, [fixture, id, action], {
      env: { ...process.env, HOME: scratchHome, USERPROFILE: scratchHome, DSH_HOME: join(scratchHome, '.dsh') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', reject);
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`restart probe timed out: ${stderr}`)); }, 30_000);
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

for (const confidential of [false, true]) {
  it(`refreshes manual OAuth clients through 401 and restart (${confidential ? 'confidential' : 'public'})`, async t => {
    const stub = await startStub();
    t.after(() => stub.close());
    const secretEnv = 'DSH_MM_TEST_MANUAL_SECRET';
    const previous = process.env[secretEnv];
    t.after(() => { if (previous === undefined) delete process.env[secretEnv]; else process.env[secretEnv] = previous; });
    if (confidential) process.env[secretEnv] = 'manual-secret-initial';
    const { handler, dispose } = makeCtx();
    const name = `manual-${confidential ? 'confidential' : 'public'}`;
    const created = await request(handler, 'POST', '/mcp-manager/api/servers', {
      name, type: 'http', url: stub.mcpUrl, authMode: 'oauth', clientId: 'manual-client',
      ...(confidential ? { clientSecretEnv: secretEnv } : {}),
    });
    assert.equal(created.code, 201, created.text);
    const id = created.json.server.id;
    const auth = await authorize(handler, id);
    assert.equal(auth.searchParams.get('client_id'), 'manual-client');
    await complete(handler, id, auth);
    assert.equal(stub.registerBodies.length, 0, 'manual clients must skip dynamic registration');
    assert.equal(serverNamed(name).oauth.clientId, undefined, 'manual identity is configured on the server');
    assert.equal(stub.tokenForms[0].get('client_secret'), confidential ? 'manual-secret-initial' : null);

    if (confidential) process.env[secretEnv] = 'manual-secret-current';
    stub.invalidate();
    const connected = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
    assert.equal(refreshForms(stub).length, 1, '401 must refresh a manually registered client');
    assert.equal(connected.json.server.status, 'connected');
    assert.equal(refreshForms(stub)[0].get('client_id'), 'manual-client');
    assert.equal(refreshForms(stub)[0].get('client_secret'), confidential ? 'manual-secret-current' : null);
    assert.equal(refreshForms(stub)[0].get('resource'), stub.resource);
    assert.equal(serverNamed(name).oauth.tokens.refresh_token, 'refresh-2');

    dispose();
    expireSavedPair(name);
    stub.invalidate();
    if (confidential) process.env[secretEnv] = 'manual-secret-after-restart';
    const child = await runRestartProbe(id);
    assert.equal(child.status, 0, child.stderr);
    const verdict = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.equal(JSON.parse(verdict.body).server.status, 'connected');
    assert.equal(refreshForms(stub).length, 2, 'restart must proactively refresh the persisted manual client');
    assert.equal(refreshForms(stub)[1].get('client_id'), 'manual-client');
    assert.equal(refreshForms(stub)[1].get('client_secret'), confidential ? 'manual-secret-after-restart' : null);
    assert.equal(refreshForms(stub)[1].get('refresh_token'), 'refresh-2');
    assert.equal(serverNamed(name).oauth.tokens.refresh_token, 'refresh-3');
    assert.equal(stub.registerBodies.length, 0);
    const persisted = JSON.stringify(state());
    for (const secret of ['manual-secret-initial', 'manual-secret-current', 'manual-secret-after-restart']) {
      assert.ok(!persisted.includes(secret), 'client secret values must never be persisted');
    }
  });
}

it('issues exactly one refresh when two connects race on the same expired pair', async (t) => {
  const stub = await startStub({ refreshDelayMs: 200 });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'race', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  stub.invalidate();
  const [first, second] = await Promise.all([
    request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`),
    request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`),
  ]);
  assert.equal(first.code, 200, first.text);
  assert.equal(second.code, 200, second.text);
  assert.equal(refreshForms(stub).length, 1, 'two concurrent 401s must share one refresh');
  assert.equal(serverNamed('race').oauth.tokens.refresh_token, 'refresh-2');
  assert.equal(serverNamed('race').oauth.needsReauth, false);
});

it('refreshes proactively in a fresh process when the saved access token is expired', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'proactive', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  expireSavedPair('proactive');
  const before = refreshForms(stub).length;
  const child = await runRestartProbe(id);
  assert.equal(child.status, 0, child.stderr);
  const verdict = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(verdict.code, 200, verdict.body);
  assert.equal(refreshForms(stub).length, before + 1, 'the probe refreshes once before its first request');
  assert.equal(serverNamed('proactive').oauth.tokens.refresh_token, 'refresh-2');
});

it('stops on invalid_grant and asks for re-authorization instead of replaying the token', async (t) => {
  const stub = await startStub({ refreshMode: 'invalid_grant' });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'dead', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  stub.invalidate();
  const first = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(first.code, 200, first.text);
  assert.equal(serverNamed('dead').oauth.needsReauth, true);
  assert.equal(serverNamed('dead').oauth.lastRefreshError, 'invalid_grant');
  const view = (await request(handler, 'GET', '/mcp-manager/api/servers')).json.servers.find((server) => server.name === 'dead');
  assert.equal(view.status, 'needs-auth');
  assert.match(view.error, /re-authorization required/);

  const before = refreshForms(stub).length;
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(refreshForms(stub).length, before, 'a spent refresh token must not be replayed');
});

it('adopts a pair another process refreshed instead of sending the spent token', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'adopt', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  // The in-memory copy is expired, while the file already carries a pair that
  // a second DSH process refreshed. The lock/re-read must adopt it, not spend
  // the expired refresh token again.
  expireSavedPair('adopt');
  const { handler: staleHandler } = makeCtx();
  stub.mint('example-access-other', 'example-refresh-other');
  const st = state();
  st.servers.find((server) => server.name === 'adopt').oauth.tokens = {
    access_token: 'example-access-other', refresh_token: 'example-refresh-other', expires_at: Date.now() + 3600_000,
  };
  writeState(st);

  const before = refreshForms(stub).length;
  const connected = await request(staleHandler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(connected.code, 200, connected.text);
  assert.equal(refreshForms(stub).length, before, 'the fresh pair must be adopted without another refresh');
  assert.equal(serverNamed('adopt').oauth.tokens.refresh_token, 'example-refresh-other');
});

it('keeps the pair and retries after a transient token-endpoint failure', async (t) => {
  const stub = await startStub({ refreshMode: 'unavailable' });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'transient', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  stub.invalidate();
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(serverNamed('transient').oauth.needsReauth, false, 'a 5xx is not a reason to demand re-authorization');
  assert.equal(serverNamed('transient').oauth.lastRefreshError, 'temporarily_unavailable');

  const before = refreshForms(stub).length;
  await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(refreshForms(stub).length, before + 1, 'the next attempt is allowed to retry');
});

it('writes the token file atomically with mode 0600 and leaves no temp files', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'atomic', type: 'http', url: stub.mcpUrl, authMode: 'oauth' });
  const id = created.json.server.id;
  await complete(handler, id, await authorize(handler, id));

  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the token file must stay private');
  const leftovers = readdirSync(join(scratchHome, '.dsh')).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no half-written temp file may survive a save');
  assert.equal(serverNamed('atomic').oauth.tokens.access_token, 'access-1');
});

// Review regressions: independent process views share only the persisted state.
function seedServer(stub, name, { enabled = false, expires = Date.now() + 3600_000 } = {}) {
  return { id: name, name, type: 'http', url: stub.mcpUrl, authMode: 'oauth', enabled,
    oauth: { clientId: 'dcr-client', resourceMetadataUrl: `${stub.base}/.well-known/oauth-protected-resource/mcp`,
      authorizationServer: stub.base, resource: stub.resource,
      tokens: { access_token: 'example-access-old', refresh_token: 'example-refresh-old', expires_at: expires } } };
}

it('review: IPv6 loopback with port remains a valid OAuth callback origin', async t => {
  const stub = await startStub(); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'ipv6')] });
  const { handler } = makeCtx();
  const auth = await request(handler, 'POST', '/mcp-manager/api/servers/ipv6/auth', undefined, { host: '[::1]:3080' });
  assert.equal(auth.code, 200, auth.text);
  assert.equal(new URL(auth.json.authorizeUrl).searchParams.get('redirect_uri'), 'http://[::1]:3080/mcp-manager/callback/ipv6');
});

it('review: expired disk access token still supplies the newest single-use refresh token', async t => {
  const stub = await startStub(); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'expired-disk')] });
  const { handler } = makeCtx();
  stub.mint('example-access-new', 'example-refresh-new');
  const fresh = state();
  fresh.servers[0].oauth.tokens = { access_token: 'example-access-new', refresh_token: 'example-refresh-new', expires_at: Date.now() - 1000 };
  writeState(fresh);
  await request(handler, 'POST', '/mcp-manager/api/servers/expired-disk/enabled', { enabled: true });
  assert.deepEqual(refreshForms(stub).map(form => form.get('refresh_token')), ['example-refresh-new']);
  assert.equal(serverNamed('expired-disk').oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(serverNamed('expired-disk').oauth.needsReauth, false);
});

it('review: refreshing B preserves another process refreshed A and unknown settings', async t => {
  const a = await startStub(); const b = await startStub();
  t.after(() => a.close()); t.after(() => b.close());
  writeState({ servers: [seedServer(a, 'a'), seedServer(b, 'b')], futureSetting: { preserved: true } });
  const { handler } = makeCtx();
  const fresh = state();
  fresh.servers[0].oauth.tokens.refresh_token = 'example-rotated';
  fresh.futureSetting.remote = 'new';
  writeState(fresh); b.mint('example-access-old', 'example-refresh-old'); b.invalidate();
  await request(handler, 'POST', '/mcp-manager/api/servers/b/enabled', { enabled: true });
  assert.equal(serverNamed('b').oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(serverNamed('a').oauth.tokens.refresh_token, 'example-rotated');
  assert.equal(state().futureSetting.remote, 'new');
});

it('review: a settings save cannot restore a stale token pair', async t => {
  const stub = await startStub(); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'config')] });
  const { handler } = makeCtx();
  const fresh = state(); fresh.servers[0].oauth.tokens.refresh_token = 'rotated'; writeState(fresh);
  const result = await request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true });
  assert.equal(result.code, 200, result.text);
  assert.equal(serverNamed('config').oauth.tokens.refresh_token, 'rotated');
});

it('review: a persisted permanent error prevents another process replaying its token', async t => {
  const stub = await startStub({ refreshMode: 'invalid_grant' }); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'reauth')] });
  const { handler } = makeCtx();
  const fresh = state(); fresh.servers[0].oauth.needsReauth = true; fresh.servers[0].oauth.lastRefreshError = 'invalid_grant'; writeState(fresh);
  await request(handler, 'POST', '/mcp-manager/api/servers/reauth/enabled', { enabled: true });
  assert.equal(refreshForms(stub).length, 0);
  const view = (await request(handler, 'GET', '/mcp-manager/api/servers')).json.servers[0];
  assert.equal(view.status, 'needs-auth');
});

async function untilReview(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(predicate(), 'review condition timed out');
}

it('review: two fresh processes consume a shared refresh token only once', async t => {
  const stub = await startStub({ refreshDelayMs: 200 }); t.after(() => stub.close());
  const server = seedServer(stub, 'two-processes', { expires: Date.now() - 1000 });
  writeState({ servers: [server] }); stub.mint('example-access-old', 'example-refresh-old'); stub.invalidate();
  const results = await Promise.all([runRestartProbe(server.id), runRestartProbe(server.id)]);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    const verdict = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(verdict.code, 200, verdict.body);
    assert.equal(JSON.parse(verdict.body).server.oauth.needsReauth, false);
  }
  assert.equal(refreshForms(stub).length, 1);
  assert.equal(serverNamed(server.name).oauth.tokens.refresh_token, 'refresh-1');
});

it('review: two fresh processes refreshing different servers keep both rotated pairs', async t => {
  const a = await startStub({ refreshDelayMs: 200 }); const b = await startStub({ refreshDelayMs: 200 });
  t.after(() => a.close()); t.after(() => b.close());
  writeState({ servers: [seedServer(a, 'process-a'), seedServer(b, 'process-b')] });
  a.mint('example-access-old', 'example-refresh-old'); a.invalidate(); b.mint('example-access-old', 'example-refresh-old'); b.invalidate();
  const results = await Promise.all([runRestartProbe('process-a'), runRestartProbe('process-b')]);
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(serverNamed('process-a').oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(serverNamed('process-b').oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(refreshForms(a).length, 1); assert.equal(refreshForms(b).length, 1);
});

it('review: a concurrent settings writer waits for refresh and preserves workspace tokens', async t => {
  const stub = await startStub({ refreshDelayMs: 250 }); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'locked')], workspaceTokens: { '/scratch\nws': { oauth: { tokens: { refresh_token: 'ws-old' } } } } });
  const refreshing = makeCtx(); const settings = makeCtx();
  stub.mint('example-access-old', 'example-refresh-old'); stub.invalidate();
  const pending = request(refreshing.handler, 'POST', '/mcp-manager/api/servers/locked/enabled', { enabled: true });
  await untilReview(() => refreshForms(stub).length === 1);
  let settled = false;
  const saving = request(settings.handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(settled, false, 'config save must share the refresh lock');
  await pending; assert.equal((await saving).code, 200);
  assert.equal(serverNamed('locked').oauth.tokens.refresh_token, 'refresh-1');
  assert.equal(state().workspaceTokens['/scratch\nws'].oauth.tokens.refresh_token, 'ws-old');
  assert.equal(state().onDemandToolInjection, true);
});

for (const action of ['disable', 'delete', 'unload']) {
  it(`review: startup restore does not resurrect a server after ${action}`, async t => {
    const stub = await startStub(); t.after(() => stub.close());
    const server = seedServer(stub, 'startup', { enabled: true });
    writeState({ servers: [server] }); stub.mint('example-access-old', 'example-refresh-old');
    const h = makeCtx();
    await untilReview(() => stub.seen.some(path => path === 'POST /mcp'));
    // Await the initial connect here; dedicated in-flight tests cover
    // invalidation while a handshake is still pending.
    await untilReview(() => stub.seen.filter(path => path === 'POST /mcp').length >= 3);
    if (action === 'disable') await request(h.handler, 'POST', '/mcp-manager/api/servers/startup/enabled', { enabled: false });
    if (action === 'delete') await request(h.handler, 'DELETE', '/mcp-manager/api/servers/startup');
    if (action === 'unload') h.dispose();
    const count = stub.seen.filter(path => path === 'POST /mcp').length;
    await new Promise(resolve => setTimeout(resolve, 1700));
    assert.equal(stub.seen.filter(path => path === 'POST /mcp').length, count);
  });
}

it('review: adopting a remote pair rebases later settings writes', async t => {
  const stub = await startStub(); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'rebase')] });
  const h = makeCtx();
  stub.mint('example-access-n', 'example-refresh-n');
  const fresh = state(); fresh.servers[0].oauth.tokens = { access_token: 'example-access-n', refresh_token: 'example-refresh-n', expires_at: Date.now() + 3600_000 }; writeState(fresh);
  await request(h.handler, 'POST', '/mcp-manager/api/servers/rebase/enabled', { enabled: true });
  const later = state(); later.servers[0].oauth.tokens = { access_token: 'example-access-m', refresh_token: 'example-refresh-m', expires_at: Date.now() + 3600_000 }; writeState(later);
  assert.equal((await request(h.handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true })).code, 200);
  assert.equal(serverNamed('rebase').oauth.tokens.refresh_token, 'example-refresh-m');
});


it('review: an empty stale lock is reclaimable after interrupted creation', async () => {
  const lock = `${statePath}.refresh.lock`;
  writeFileSync(lock, ''); utimesSync(lock, new Date(0), new Date(0));
  const { handler } = makeCtx();
  const result = await request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true });
  assert.equal(result.code, 200, result.text);
  assert.equal(state().onDemandToolInjection, true);
  assert.ok(!readdirSync(join(scratchHome, '.dsh')).includes('mcp-manager.json.refresh.lock'));
});

it('review: an aged lock held by a live owner is never stolen', async () => {
  const lock = `${statePath}.refresh.lock`;
  writeFileSync(lock, `${process.pid}\nowned`); utimesSync(lock, new Date(0), new Date(0));
  const { handler } = makeCtx();
  let settled = false;
  const pending = request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false);
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\nowned`);
  unlinkSync(lock);
  assert.equal((await pending).code, 200);
});

it('review: a failed rotation save never restores and replays the spent disk pair', async t => {
  const backup = `${statePath}.backup`;
  let failOnce = true;
  const stub = await startStub({ beforeRefreshReply() {
    if (!failOnce) return;
    failOnce = false;
    renameSync(statePath, backup); mkdirSync(statePath);
  } }); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'unsaved')] });
  const h = makeCtx(); stub.mint('example-access-old', 'example-refresh-old'); stub.invalidate();
  await request(h.handler, 'POST', '/mcp-manager/api/servers/unsaved/enabled', { enabled: true });
  rmSync(statePath, { recursive: true }); renameSync(backup, statePath);
  stub.invalidate();
  await request(h.handler, 'POST', '/mcp-manager/api/servers/unsaved/connect');
  await request(h.handler, 'POST', '/mcp-manager/api/servers/unsaved/connect');
  assert.deepEqual(refreshForms(stub).map(form => form.get('refresh_token')), ['example-refresh-old']);
});


it('review: simultaneous stale-lock reclaimers retain one refresh transaction', async t => {
  const stub = await startStub({ refreshDelayMs: 150 }); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'reclaim-race', { expires: Date.now() - 1000 })] });
  stub.mint('example-access-old', 'example-refresh-old'); stub.invalidate();
  const lock = `${statePath}.refresh.lock`;
  writeFileSync(lock, ''); utimesSync(lock, new Date(0), new Date(0));
  const results = await Promise.all(Array.from({ length: 4 }, () => runRestartProbe('reclaim-race')));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  assert.equal(refreshForms(stub).length, 1);
  assert.equal(serverNamed('reclaim-race').oauth.tokens.refresh_token, 'refresh-1');
  assert.ok(!readdirSync(join(scratchHome, '.dsh')).some(name => name.endsWith('.lock') || name.endsWith('.reclaim')));
});

it('review: an orphaned reclaimer guard fails closed until operator recovery', async () => {
  const lock = `${statePath}.refresh.lock`;
  const guard = `${lock}.reclaim`;
  writeFileSync(lock, ''); utimesSync(lock, new Date(0), new Date(0));
  writeFileSync(guard, ''); utimesSync(guard, new Date(0), new Date(0));
  const { handler } = makeCtx();
  let settled = false;
  const pending = request(handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(settled, false);
  assert.equal(readFileSync(lock, 'utf8'), '');
  unlinkSync(guard);
  assert.equal((await pending).code, 200);
});

it('premerge: queued state writes preserve same-process invocation order', async () => {
  const lock = `${statePath}.refresh.lock`;
  writeFileSync(lock, `${process.pid}\nexternal-owner`);
  const h = makeCtx();
  const first = request(h.handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: true });
  await new Promise(resolve => setImmediate(resolve));
  const view = await request(h.handler, 'GET', '/mcp-manager/api/settings');
  assert.equal(view.json.onDemandToolInjection, true, 'first write reached its lock wait');
  unlinkSync(lock);
  const second = request(h.handler, 'POST', '/mcp-manager/api/settings/on-demand', { enabled: false });
  assert.equal((await second).code, 200);
  assert.equal((await first).code, 200);
  assert.equal(state().onDemandToolInjection, false, 'earlier queued save must not overwrite the later save');
});

it('premerge: retrying disable after lock timeout persists the requested state', async t => {
  const stub = await startStub(); t.after(() => stub.close());
  writeState({ servers: [seedServer(stub, 'disable-timeout', { enabled: true })] });
  stub.mint('example-access-old', 'example-refresh-old');
  const h = makeCtx();
  await untilReview(() => stub.seen.filter(path => path === 'POST /mcp').length >= 3);
  const lock = `${statePath}.refresh.lock`;
  writeFileSync(lock, `${process.pid}\nexternal-owner`);
  const realNow = Date.now;
  const now = realNow();
  let tick = 0;
  let failed;
  try {
    Date.now = () => now + tick++ * 30000;
    failed = await request(h.handler, 'POST', '/mcp-manager/api/servers/disable-timeout/enabled', { enabled: false });
  } finally { Date.now = realNow; unlinkSync(lock); }
  assert.equal(failed.code, 500, 'the first save must encounter the lock timeout');
  const retried = await request(h.handler, 'POST', '/mcp-manager/api/servers/disable-timeout/enabled', { enabled: false });
  assert.equal(retried.code, 200, retried.text);
  assert.equal(serverNamed('disable-timeout').enabled, false, 'retry must save rather than take the equality shortcut');
});
