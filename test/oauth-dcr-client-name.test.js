/**
 * Dynamic client registration details (RFC 7591) that a provider-gated AS
 * forces on us (issue #28, Figma):
 *
 * - the registration `client_name` is configurable per server (`clientName`)
 *   and defaults to `dsh-mcp-manager-<server>`;
 * - the registration's `token_endpoint_auth_method` is one the authorization
 *   server actually advertises (`client_secret_post` when offered, `none`
 *   otherwise);
 * - a `client_secret` issued by the registration is persisted (0600 state
 *   file), sent as `client_secret_post` at the token and refresh endpoints,
 *   and never exposed by a view, an API response or the attempt log;
 * - a changed `client_name` re-registers and drops the tokens/client secret
 *   that belonged to the old client.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, it } from 'node:test';

// STATE_PATH is derived from homedir() at module evaluation: pin both HOME and
// USERPROFILE before importing the plugin.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mm-dcr-name-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = join(scratchHome, '.dsh');
after(() => rmSync(scratchHome, { recursive: true, force: true }));

mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
const statePath = join(scratchHome, '.dsh', 'mcp-manager.json');

const { apply } = await import('../lib/index.js');

const testDisposers = [];
beforeEach(() => writeFileSync(statePath, JSON.stringify({ servers: [] })));
afterEach(() => { for (const dispose of testDisposers.splice(0).reverse()) dispose(); });

/** Minimal ctx: the mounted API route plus effect cleanup for the plugin. */
function makeCtx(config = {}, { registry = null } = {}) {
  const routes = [];
  const cleanup = [];
  const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return () => {}; };
  const webServer = { register: (route) => { routes.push(route); return () => {}; } };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: { guard: () => () => {}, register: () => () => {}, restrict: () => () => {}, execute: async () => ({}) },
    webServer,
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    on: () => () => {},
    inject: (names, callback) => {
      if (typeof callback === 'function' && names.includes('webServer')) {
        callback({ webServer, get: ctx.get, effect });
      }
      return { dispose: () => {} };
    },
    effect,
  };
  apply(ctx, config);
  testDisposers.push(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
  return { handler: routes[0]?.handler };
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
 * Provider-gated OAuth stub: the MCP endpoint 401s, protected-resource metadata
 * names a path-carrying AS, and the AS advertises dynamic registration plus
 * (optionally) its accepted token-endpoint auth methods. Registration can be
 * gated on an exact `client_name` allowlist and can issue a confidential
 * client's `client_secret`, which the token endpoint then requires.
 */
function startStub({
  authMethods = [],
  allowedClientNames = null,
  issueSecret = false,
  expectedRefreshSecret = null,
  echoSecretOnError = false,
  // A provider that issues a client_secret even for a `none` registration, and
  // a secret long enough that a truncated error body would cut off the closing
  // quote the JSON redaction needs.
  secretForPublic = false,
  secretLength = 0,
} = {}) {
  const registrations = [];
  const forms = [];
  const registered = new Map();
  const accepted = new Set();
  let seq = 0;

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

      if (url.pathname === '/mcp') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!accepted.has(token)) {
          return send(401, { error: 'invalid_token' }, {
            'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          });
        }
        let message = {};
        try { message = JSON.parse(raw || '{}'); } catch {}
        if (message.id === undefined) return send(202, '');
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'gated', version: '1' } }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
            : {};
        return send(200, { jsonrpc: '2.0', id: message.id, result });
      }

      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
        return send(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/as`] });
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') return send(404, { error: 'not found' });
      if (url.pathname === '/.well-known/oauth-authorization-server/as') {
        return send(200, {
          issuer: `${base}/as`,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          code_challenge_methods_supported: ['S256'],
          ...(authMethods.length > 0 ? { token_endpoint_auth_methods_supported: authMethods } : {}),
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') return send(404, { error: 'not found' });

      if (url.pathname === '/register' && req.method === 'POST') {
        let payload = {};
        try { payload = JSON.parse(raw || '{}'); } catch {}
        registrations.push(payload);
        if (allowedClientNames && !allowedClientNames.includes(payload.client_name)) {
          return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
        }
        const clientId = `dcr-client-${registrations.length}`;
        const confidential = payload.token_endpoint_auth_method === 'client_secret_post';
        const suffix = secretLength > 0 ? `-${'s'.repeat(secretLength)}` : '';
        const secret = confidential || secretForPublic
          ? `dcr-secret-${registrations.length}${suffix}${confidential ? '' : '-public'}`
          : '';
        registered.set(clientId, secret);
        return send(201, {
          client_id: clientId,
          redirect_uris: payload.redirect_uris,
          ...(secret ? { client_secret: secret, token_endpoint_auth_method: payload.token_endpoint_auth_method } : {}),
        });
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(raw);
        forms.push(form);
        const clientId = form.get('client_id');
        const expected = expectedRefreshSecret ?? registered.get(clientId) ?? '';
        if (echoSecretOnError) {
          // A provider that echoes the credential it rejected in its error body;
          // neither the attempt log nor the callback page may retain it.
          return send(400, { error: 'invalid_client', error_description: 'client authentication failed', client_secret: expected });
        }
        if (issueSecret && (form.get('client_secret') ?? '') !== expected) {
          return send(401, { error: 'invalid_client', error_description: 'client authentication required' });
        }
        const access = `access-${++seq}`;
        accepted.add(access);
        return send(200, {
          access_token: access,
          refresh_token: `refresh-${seq}`,
          token_type: 'Bearer',
          expires_in: 3600,
        });
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
        registrations,
        forms,
        revokeAll() { accepted.clear(); },
        async close() {
          server.closeAllConnections?.();
          await new Promise((done) => server.close(done));
        },
      });
    });
  });
}

const authorizeUrlOf = (auth) => new URL(auth.json.authorizeUrl);
const callbackPath = (id, authorize) => `/mcp-manager/callback/${id}?code=synthetic-code&state=${authorize.searchParams.get('state')}`;

it('requests no confidential-client auth and keeps the default client_name for a public client', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const { handler } = makeCtx();

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'public-dcr', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  assert.equal(created.json.server.clientName, '', 'no configured client name means the plugin default');
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 1);
  assert.equal(stub.registrations[0].client_name, 'dsh-mcp-manager-public-dcr');
  assert.equal(stub.registrations[0].token_endpoint_auth_method, 'none', 'no advertised confidential method means a public client');

  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);
  assert.equal(stub.forms[0].get('client_secret'), null, 'a public client must not send a secret');

  const row = state().servers.find((server) => server.id === id);
  assert.equal(row.oauth.clientId, 'dcr-client-1');
  assert.equal(row.oauth.clientName, 'dsh-mcp-manager-public-dcr');
  assert.equal(row.oauth.tokenEndpointAuthMethod, 'none');
  assert.equal(row.oauth.clientSecret, undefined);

  const view = await request(handler, 'GET', '/mcp-manager/api/servers');
  assert.ok(!/"clientSecret"\s*:/.test(JSON.stringify(view.json)), 'the API view must not carry the registration secret');
  const logs = await request(handler, 'GET', `/mcp-manager/api/servers/${id}/logs`);
  assert.ok(logs.json.logs.some((entry) => entry.phase === 'register' && entry.detail.includes('token_endpoint_auth_method=none')));
  assert.ok(!JSON.stringify(logs.json).includes('clientSecret'));
});

it('registers under a configured client_name and uses the issued secret at exchange and refresh', async (t) => {
  const stub = await startStub({
    authMethods: ['client_secret_post'],
    allowedClientNames: ['acme-dsh-client'],
    issueSecret: true,
  });
  t.after(() => stub.close());
  const { handler } = makeCtx();

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'confidential', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;

  // The provider rejects the plugin's default name, exactly like Figma does.
  const rejected = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(rejected.code, 500);
  assert.match(rejected.json.error, /HTTP 403/);
  assert.equal(stub.registrations.length, 1);

  // The operator names the client the provider registered for this plugin.
  const edited = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'confidential', type: 'http', url: stub.mcpUrl, authMode: 'oauth', clientName: 'acme-dsh-client',
  });
  assert.equal(edited.code, 200, edited.text);
  assert.equal(edited.json.server.clientName, 'acme-dsh-client');

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 2);
  assert.equal(stub.registrations[1].client_name, 'acme-dsh-client');
  assert.equal(stub.registrations[1].token_endpoint_auth_method, 'client_secret_post');

  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);
  assert.equal(stub.forms[0].get('client_secret'), 'dcr-secret-2', 'exchange must send the issued secret');

  const row = state().servers.find((server) => server.id === id);
  assert.equal(row.oauth.clientSecret, 'dcr-secret-2');
  const view = await request(handler, 'GET', '/mcp-manager/api/servers');
  assert.ok(!JSON.stringify(view.json).includes('dcr-secret-2'));
  const logs = await request(handler, 'GET', `/mcp-manager/api/servers/${id}/logs`);
  assert.ok(!JSON.stringify(logs.json).includes('dcr-secret-2'), 'the attempt log must never store the secret');

  // A later 401 refreshes with the registration secret, not without credentials.
  stub.revokeAll();
  const reconnect = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(reconnect.code, 200, reconnect.text);
  const refresh = stub.forms.find((form) => form.get('grant_type') === 'refresh_token');
  assert.ok(refresh, 'an expired/revoked token must trigger a refresh');
  assert.equal(refresh.get('client_id'), 'dcr-client-2');
  assert.equal(refresh.get('client_secret'), 'dcr-secret-2');
  assert.equal(reconnect.json.server.status, 'connected');
});

it('lets a configured client-secret environment variable win over the stored registration secret', async (t) => {
  process.env.MCP_DCR_ENV_SECRET = 'env-secret-value';
  t.after(() => { delete process.env.MCP_DCR_ENV_SECRET; });
  const stub = await startStub({
    authMethods: ['client_secret_post'],
    issueSecret: true,
    expectedRefreshSecret: 'env-secret-value',
  });
  t.after(() => stub.close());
  const id = 'seeded-secret-server';
  writeFileSync(statePath, JSON.stringify({
    servers: [{
      id,
      name: 'seeded-secret',
      type: 'http',
      url: stub.mcpUrl,
      authMode: 'oauth',
      clientSecretEnv: 'MCP_DCR_ENV_SECRET',
      oauth: {
        clientId: 'dcr-client-1',
        clientName: 'dsh-mcp-manager-seeded-secret',
        redirect: `http://127.0.0.1:3080/mcp-manager/callback/${id}`,
        clientSecret: 'stored-registration-secret',
        tokens: { access_token: 'spent-access', refresh_token: 'refresh-spent', expires_at: 0 },
      },
    }],
  }));
  const { handler } = makeCtx();

  const reconnect = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(reconnect.code, 200, reconnect.text);
  const refresh = stub.forms.find((form) => form.get('grant_type') === 'refresh_token');
  assert.ok(refresh);
  assert.equal(refresh.get('client_secret'), 'env-secret-value', 'an explicitly configured secret source takes precedence');
});

it('re-registers when client_name changes and keeps the registration when it does not', async (t) => {
  const stub = await startStub({
    authMethods: ['client_secret_post'],
    allowedClientNames: ['client-one', 'client-two'],
    issueSecret: true,
  });
  t.after(() => stub.close());
  const { handler } = makeCtx();

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', {
    name: 'rename-client', type: 'http', url: stub.mcpUrl, authMode: 'oauth', clientName: 'client-one',
  });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 1);
  assert.equal(stub.registrations[0].client_name, 'client-one');
  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);

  // An unrelated save must keep the registration and its token pair.
  const unchanged = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'rename-client', type: 'http', url: stub.mcpUrl, authMode: 'oauth', clientName: 'client-one',
  });
  assert.equal(unchanged.code, 200, unchanged.text);
  assert.equal(stub.registrations.length, 1, 'an unchanged client_name must not re-register');
  assert.equal(unchanged.json.server.status, 'connected');
  assert.equal(state().servers.find((server) => server.id === id).oauth.clientSecret, 'dcr-secret-1');

  // A new client name is a new client: the old registration, secret and tokens
  // are unusable, so the server returns to needs-auth until it is reauthorized.
  const renamed = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'rename-client', type: 'http', url: stub.mcpUrl, authMode: 'oauth', clientName: 'client-two',
  });
  assert.equal(renamed.code, 200, renamed.text);
  assert.equal(renamed.json.server.status, 'needs-auth');
  const afterRename = state().servers.find((server) => server.id === id);
  assert.equal(afterRename.oauth, undefined, 'the old client registration and tokens must be dropped');
  assert.equal(afterRename.clientName, 'client-two');

  const reauth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(reauth.code, 200, reauth.text);
  assert.equal(stub.registrations.length, 2);
  assert.equal(stub.registrations[1].client_name, 'client-two');
  const second = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(reauth)));
  assert.match(second.text, /Authorized/);
  const exchange = stub.forms.find((form) => form.get('grant_type') === 'authorization_code' && form.get('client_id') === 'dcr-client-2');
  assert.ok(exchange);
  assert.equal(exchange.get('client_secret'), 'dcr-secret-2');

  // A same-origin path change keeps the cached pair (discovery is origin-scoped
  // and the next discovered metadata refreshes the resource pointer); a real
  // origin change drops it, because the redirect and discovery context moved.
  const sameOriginPath = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'rename-client', type: 'http', url: `${stub.base}/mcp-other`, authMode: 'oauth', clientName: 'client-two',
  });
  assert.equal(sameOriginPath.code, 200, sameOriginPath.text);
  assert.ok(state().servers.find((server) => server.id === id).oauth?.tokens, 'a same-origin edit must not log the server out');
  const crossOrigin = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'rename-client', type: 'http', url: `${stub.base.replace('://127.0.0.1:', '://localhost:')}/mcp`, authMode: 'oauth', clientName: 'client-two',
  });
  assert.equal(crossOrigin.code, 200, crossOrigin.text);
  assert.equal(crossOrigin.json.server.status, 'needs-auth');
  assert.equal(state().servers.find((server) => server.id === id).oauth, undefined, 'an endpoint-origin change invalidates the cached registration and tokens');
});

it('drops the cached registration when a rename changes the derived default client_name', async (t) => {
  const stub = await startStub({ authMethods: ['client_secret_post'], issueSecret: true });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'original-name', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);
  assert.equal(stub.registrations[0].client_name, 'dsh-mcp-manager-original-name');
  assert.equal(state().servers.find((server) => server.id === id).oauth.clientSecret, 'dcr-secret-1');

  const renamed = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'renamed-server', type: 'http', url: stub.mcpUrl, authMode: 'oauth',
  });
  assert.equal(renamed.code, 200, renamed.text);
  assert.equal(renamed.json.server.status, 'needs-auth');
  assert.equal(state().servers.find((server) => server.id === id).oauth, undefined, 'the default client_name derives from the server name, so a rename invalidates the registration');
});

it('never retains a provider error body that echoes the client secret', async (t) => {
  const stub = await startStub({ authMethods: ['client_secret_post'], issueSecret: true, echoSecretOnError: true });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'leaky-provider', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);

  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Token exchange failed/);
  assert.ok(!callback.text.includes('dcr-secret-1'), 'the callback page must not print the secret a provider echoed');
  const logs = await request(handler, 'GET', `/mcp-manager/api/servers/${id}/logs`);
  const logText = JSON.stringify(logs.json);
  assert.ok(!logText.includes('dcr-secret-1'), 'the attempt log must redact a JSON-quoted secret');
  assert.ok(logText.includes('<redacted>'));
  assert.equal(state().servers.find((server) => server.id === id).oauth.clientSecret, 'dcr-secret-1', 'the stored secret itself stays only in the 0600 state file');
});

it('does not present a secret issued by a public-client registration', async (t) => {
  // An AS can return a client_secret even though the client registered with
  // token_endpoint_auth_method "none". Presenting it would contradict the
  // registered method (a strict AS answers invalid_client), so it is stored but
  // never sent.
  const stub = await startStub({ secretForPublic: true });
  t.after(() => stub.close());
  const { handler } = makeCtx();

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'public-issued', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations[0].token_endpoint_auth_method, 'none');
  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);
  assert.equal(stub.forms[0].get('client_secret'), null, 'a public-client registration must not present a secret');

  const row = state().servers.find((server) => server.id === id);
  assert.equal(row.oauth.clientSecret, 'dcr-secret-1-public', 'the issued secret is still kept in the 0600 state file');
  assert.equal(row.oauth.tokenEndpointAuthMethod, 'none');

  stub.revokeAll();
  const reconnect = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(reconnect.code, 200, reconnect.text);
  const refresh = stub.forms.find((form) => form.get('grant_type') === 'refresh_token');
  assert.ok(refresh, 'a revoked token must trigger a refresh');
  assert.equal(refresh.get('client_secret'), null, 'refresh must not present a public client secret either');
});

it('does not replay a stored registration secret with a manual Client ID', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const id = 'manual-override';
  // A hand edit replaced the dynamic client with a manual one but left the old
  // registration's secret behind: it belongs to a different client.
  writeFileSync(statePath, JSON.stringify({
    servers: [{
      id,
      name: 'manual-override',
      type: 'http',
      url: stub.mcpUrl,
      authMode: 'oauth',
      clientId: 'manual-client-id',
      oauth: {
        clientId: 'dcr-client-1',
        clientSecret: 'dcr-secret-1',
        tokenEndpointAuthMethod: 'client_secret_post',
        tokens: { access_token: 'spent-access', refresh_token: 'stale-refresh', expires_at: 0 },
      },
    }],
  }));
  const { handler } = makeCtx();

  const reconnect = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/connect`);
  assert.equal(reconnect.code, 200, reconnect.text);
  const refresh = stub.forms.find((form) => form.get('grant_type') === 'refresh_token');
  assert.ok(refresh);
  assert.equal(refresh.get('client_id'), 'manual-client-id');
  assert.equal(refresh.get('client_secret'), null, 'a manual client must never send the old registration secret');
});

it('redacts a long provider error body before truncating it', async (t) => {
  // The body echoes the secret past the 200-character log cutoff, so the
  // redaction must run on the whole body: truncating first would store the
  // unquoted prefix of the secret.
  const stub = await startStub({ authMethods: ['client_secret_post'], issueSecret: true, echoSecretOnError: true, secretLength: 300 });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'long-echo', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Token exchange failed/);

  const secret = state().servers.find((server) => server.id === id).oauth.clientSecret;
  assert.ok(secret.length > 200, 'the echoed secret crosses the truncation point');
  const prefix = secret.slice(0, 40);
  assert.ok(!callback.text.includes(prefix), 'the callback page must not carry a secret prefix');
  const logs = await request(handler, 'GET', `/mcp-manager/api/servers/${id}/logs`);
  assert.ok(!JSON.stringify(logs.json).includes(prefix), 'the attempt log must not carry a secret prefix');
});

it('ignores clientName for a manually registered client', async () => {
  const id = 'manual-client-server';
  writeFileSync(statePath, JSON.stringify({
    servers: [{
      id,
      name: 'manual-client',
      type: 'http',
      url: 'http://127.0.0.1:1/mcp',
      authMode: 'oauth',
      clientId: 'manual-client-id',
      clientName: 'name-one',
      oauth: {
        clientId: 'manual-client-id',
        tokens: { access_token: 'manual-access', refresh_token: 'manual-refresh', expires_at: Date.now() + 3600000 },
      },
    }],
  }));
  const { handler } = makeCtx();

  const edited = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'manual-client', type: 'http', url: 'http://127.0.0.1:1/mcp', authMode: 'oauth', clientId: 'manual-client-id', clientName: 'name-two',
  });
  assert.equal(edited.code, 200, edited.text);
  assert.equal(edited.json.server.clientName, 'name-two');
  const row = state().servers.find((server) => server.id === id);
  assert.ok(row.oauth?.tokens, 'a manual Client ID never registers, so editing clientName must not log it out');
  assert.equal(row.oauth.tokens.access_token, 'manual-access');
});

it('reuses a registration made before oauth.clientName was recorded', async (t) => {
  const stub = await startStub();
  t.after(() => stub.close());
  const id = 'legacy-registration';
  writeFileSync(statePath, JSON.stringify({
    servers: [{
      id,
      name: 'legacy',
      type: 'http',
      url: stub.mcpUrl,
      authMode: 'oauth',
      oauth: {
        clientId: 'dcr-client-legacy',
        redirect: `http://127.0.0.1:3080/mcp-manager/callback/${id}`,
        tokens: { access_token: 'legacy-access', refresh_token: 'legacy-refresh', expires_at: Date.now() + 3600000 },
      },
    }],
  }));
  const { handler } = makeCtx();

  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  assert.equal(auth.code, 200, auth.text);
  assert.equal(stub.registrations.length, 0, 'an upgrade must not force a re-registration');
  assert.equal(authorizeUrlOf(auth).searchParams.get('client_id'), 'dcr-client-legacy');
});

it('rejects a malformed client_name and drops it when the auth mode changes', async () => {
  const { handler } = makeCtx();
  const base = { type: 'http', url: 'https://mcp.invalid.test/mcp', authMode: 'oauth' };

  const newline = await request(handler, 'POST', '/mcp-manager/api/servers', { ...base, name: 'bad-newline', clientName: 'bad\nname' });
  assert.equal(newline.code, 400);
  assert.match(newline.json.error, /printable ASCII/);

  const tooLong = await request(handler, 'POST', '/mcp-manager/api/servers', { ...base, name: 'bad-long', clientName: 'x'.repeat(129) });
  assert.equal(tooLong.code, 400);
  assert.match(tooLong.json.error, /at most 128/);

  const maxLength = await request(handler, 'POST', '/mcp-manager/api/servers', { ...base, name: 'max-length', clientName: 'y'.repeat(128) });
  assert.equal(maxLength.code, 201, maxLength.text);
  assert.equal(maxLength.json.server.clientName.length, 128, 'exactly 128 characters are accepted');

  const nonAscii = await request(handler, 'POST', '/mcp-manager/api/servers', { ...base, name: 'non-ascii', clientName: '客户端名称' });
  assert.equal(nonAscii.code, 400);
  assert.match(nonAscii.json.error, /printable ASCII/);

  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { ...base, name: 'mode-switch', clientName: 'client-one' });
  assert.equal(created.code, 201, created.text);
  assert.equal(created.json.server.clientName, 'client-one');
  const id = created.json.server.id;

  const staticMode = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'mode-switch', type: 'http', url: base.url, authMode: 'static', tokenEnv: 'MCP_TOKEN',
  });
  assert.equal(staticMode.code, 200, staticMode.text);
  assert.equal(staticMode.json.server.clientName, '');
  assert.equal(state().servers.find((server) => server.id === id).clientName, undefined);

  const noneMode = await request(handler, 'PUT', `/mcp-manager/api/servers/${id}`, {
    name: 'mode-switch', type: 'http', url: base.url, authMode: 'none',
  });
  assert.equal(noneMode.code, 200, noneMode.text);
  assert.equal(noneMode.json.server.clientName, '');
});

it('carries clientName through a workspace mcp.json declaration and its row projection', async () => {
  const workspace = join(scratchHome, 'workspace');
  mkdirSync(join(workspace, '.dsh', 'dshmm'), { recursive: true });
  const configPath = join(workspace, '.dsh', 'dshmm', 'mcp.json');
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      'ws-gated': { type: 'http', url: 'https://mcp.ws.invalid.test/mcp', authMode: 'oauth', clientName: 'ws-client' },
    },
  }));
  const { handler } = makeCtx({}, { registry: { list: () => [{ path: workspace }] } });

  const listed = await request(handler, 'GET', '/mcp-manager/api/workspaces');
  assert.equal(listed.code, 200, listed.text);
  const row = listed.json.workspaces.find((entry) => entry.path === workspace)?.servers.find((server) => server.name === 'ws-gated');
  assert.ok(row, 'the declarative workspace entry must be listed');
  assert.equal(row.clientName, 'ws-client');

  const added = await request(handler, 'POST', '/mcp-manager/api/workspaces/servers', {
    path: workspace, name: 'ws-added', type: 'http', url: 'https://mcp.ws.invalid.test/other', authMode: 'oauth', clientName: 'added-client',
  });
  assert.equal(added.code, 200, added.text);
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(raw.mcpServers['ws-added'].clientName, 'added-client');
  assert.equal(raw.mcpServers['ws-added'].clientSecretEnv, undefined, 'no secret material in a declarative config');
});

it('keeps a workspace token slot for an unchanged client identity and drops it when the client changes', async () => {
  const workspace = join(scratchHome, 'workspace-manual');
  mkdirSync(join(workspace, '.dsh', 'dshmm'), { recursive: true });
  const configPath = join(workspace, '.dsh', 'dshmm', 'mcp.json');
  const entry = { type: 'http', url: 'https://mcp.ws.invalid.test/mcp', authMode: 'oauth', clientId: 'manual-ws-client' };
  writeFileSync(configPath, JSON.stringify({ mcpServers: { 'ws-manual': entry } }));
  // Production keys the slot by the canonical (realpath) workspace path, so a
  // fixture keyed by the unresolved tmpdir path would make this test vacuous.
  const canonical = realpathSync(workspace);
  const key = `${canonical}\nws-manual`;
  writeFileSync(statePath, JSON.stringify({
    servers: [],
    workspaceTokens: { [key]: { oauth: { clientId: 'manual-ws-client', tokens: { access_token: 'ws-access', refresh_token: 'ws-refresh', expires_at: Date.now() + 3600000 } } } },
  }));
  const { handler } = makeCtx({}, { registry: { list: () => [{ path: workspace }] } });

  // A partial PUT (no clientName) must not erase it, and a manual Client ID
  // never registers, so editing the name must not drop its tokens.
  const edited = await request(handler, 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-manual', name: 'ws-manual', ...entry, clientName: 'ignored-for-manual',
  });
  assert.equal(edited.code, 200, edited.text);
  const stored = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(stored.workspaceTokens?.[key], 'a manual Client ID never registers, so editing clientName must not drop its tokens');
  assert.equal(stored.workspaceTokens[key].oauth.tokens.access_token, 'ws-access');
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['ws-manual'].clientName, 'ignored-for-manual');

  const partial = await request(handler, 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-manual', name: 'ws-manual', type: 'http', url: entry.url, authMode: 'oauth',
  });
  assert.equal(partial.code, 200, partial.text);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers['ws-manual'].clientName, 'ignored-for-manual', 'an omitted field keeps its stored value, like the global editor');
  assert.ok(JSON.parse(readFileSync(statePath, 'utf8')).workspaceTokens?.[key]);

  // The token was issued to one client; a different manual Client ID needs a
  // fresh authorization, exactly like the global editor.
  const changedClient = await request(handler, 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-manual', name: 'ws-manual', ...entry, clientId: 'manual-ws-client-2',
  });
  assert.equal(changedClient.code, 200, changedClient.text);
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).workspaceTokens?.[key], undefined, 'a different client id must not inherit the old tokens');
});

it('drops a workspace token slot for a changed dynamic client identity', async () => {
  const workspace = join(scratchHome, 'workspace-dynamic');
  mkdirSync(join(workspace, '.dsh', 'dshmm'), { recursive: true });
  const configPath = join(workspace, '.dsh', 'dshmm', 'mcp.json');
  // The slot is keyed by the canonical workspace path (see the manual test).
  const key = `${realpathSync(workspace)}\nws-dcr`;
  const entry = { type: 'http', url: 'https://mcp.ws.invalid.test/dcr', authMode: 'oauth', clientName: 'ws-one' };
  // A fresh plugin instance must be mounted after each fixture write: the
  // in-memory state does not re-read workspace tokens from disk.
  const mountWith = (configured) => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: { 'ws-dcr': configured } }));
    writeFileSync(statePath, JSON.stringify({
      servers: [],
      workspaceTokens: { [key]: { oauth: { clientId: 'ws-dcr-client', clientName: 'ws-one', clientSecret: 'ws-secret', tokens: { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3600000 } } } },
    }));
    return makeCtx({}, { registry: { list: () => [{ path: workspace }] } }).handler;
  };
  const slot = () => JSON.parse(readFileSync(statePath, 'utf8')).workspaceTokens?.[key];

  const unchanged = await request(mountWith(entry), 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-dcr', name: 'ws-dcr', ...entry,
  });
  assert.equal(unchanged.code, 200, unchanged.text);
  assert.ok(slot(), 'an unchanged dynamic client keeps its workspace token slot');

  const renamed = await request(mountWith(entry), 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-dcr', name: 'ws-dcr', ...entry, clientName: 'ws-two',
  });
  assert.equal(renamed.code, 200, renamed.text);
  assert.equal(slot(), undefined, 'a changed DCR client_name invalidates the stored registration and tokens');

  const differentSecretSource = await request(mountWith(entry), 'PUT', '/mcp-manager/api/workspaces/servers', {
    path: workspace, oldName: 'ws-dcr', name: 'ws-dcr', ...entry, clientSecretEnv: 'WS_DCR_SECRET',
  });
  assert.equal(differentSecretSource.code, 200, differentSecretSource.text);
  assert.equal(slot(), undefined, 'a changed client-secret source is a different client identity');
});

it('re-registers on a new GUI origin and drops the token pair that belonged to the old client', async (t) => {
  const stub = await startStub({ authMethods: ['client_secret_post'], issueSecret: true });
  t.after(() => stub.close());
  const { handler } = makeCtx();
  const created = await request(handler, 'POST', '/mcp-manager/api/servers', { name: 'origin-switch', type: 'http', url: stub.mcpUrl });
  assert.equal(created.code, 201, created.text);
  const id = created.json.server.id;
  const auth = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`);
  const callback = await request(handler, 'GET', callbackPath(id, authorizeUrlOf(auth)));
  assert.match(callback.text, /Authorized/);
  assert.ok(state().servers.find((server) => server.id === id).oauth.tokens);

  // A new GUI origin needs a registration bound to the new redirect; the pair
  // issued to the old client cannot be refreshed through the new registration.
  const moved = await request(handler, 'POST', `/mcp-manager/api/servers/${id}/auth`, undefined, { host: 'localhost:3081' });
  assert.equal(moved.code, 200, moved.text);
  assert.equal(stub.registrations.length, 2);
  const row = state().servers.find((server) => server.id === id);
  assert.equal(row.oauth.tokens, undefined, 'the replaced registration must not inherit the old token pair');
  assert.equal(row.oauth.clientId, 'dcr-client-2');
});
