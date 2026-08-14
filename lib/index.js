import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

/**
 * dsh-mcp-manager — host half.
 *
 * A profile-level MCP server manager for DeepSeek Harness (DSH):
 *   - Settings → MCP page (client half) to add/remove servers
 *   - Two transports per server:
 *       • Streamable HTTP with OAuth (browser redirect, RFC 6749 + PKCE,
 *         RFC 7591 dynamic client registration) or a static Bearer token
 *       • Local stdio process (JSON-RPC over stdin/stdout, newline-delimited),
 *         e.g. `npx`, `uvx`, `python`
 *   - Connects and registers each server's tools into `ctx.tools` as
 *     `mcp__<serverName>__<rawName>` (same convention as the built-in
 *     @deepseek-ai/dsh-mcp-client)
 *   - Persists server configs and OAuth tokens at ~/.dsh/mcp-manager.json;
 *     auto-reconnects and refreshes tokens across restarts
 *
 * HTTP surface (mounted on the DSH GUI webserver):
 *   GET  /mcp-manager/api/ping            liveness + version probe
 *   GET  /mcp-manager/api/servers         list servers with live status
 *   POST /mcp-manager/api/servers         add a server (http or stdio)
 *   POST /mcp-manager/api/servers/:id/auth     start OAuth (returns authorizeUrl)
 *   POST /mcp-manager/api/servers/:id/connect  (re)connect; static token may be supplied
 *   POST /mcp-manager/api/servers/:id/enabled  enable/disable globally ({enabled: bool});
 *                                              disabling unregisters all tools and drops
 *                                              the connection, config + tokens persist
 *   DEL  /mcp-manager/api/servers/:id          remove the server
 *   GET  /mcp-manager/callback/:id             OAuth redirect receiver
 *
 * The browser-facing origin (host/port of the GUI webserver) is derived from
 * each request's headers — nothing is hardcoded, so any listen address works.
 */

const STATE_PATH = join(homedir(), '.dsh', 'mcp-manager.json');
const API_PREFIX = '/mcp-manager/api';
const CALLBACK_PATH = '/mcp-manager/callback';

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { servers: [] };
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export const inject = ['tools', 'webServer'];

export function apply(ctx) {
  const state = loadState();

  // serverId -> live connection { sessionId, tools: Map<raw, disposer>, status, error, toolCount }
  const live = new Map();
  // serverId -> pending OAuth flow { state, verifier }
  const pending = new Map();

  function publicName(serverName, raw) {
    const joined = `mcp__${serverName}__${raw}`;
    const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
    if (normalized.length <= 64) return normalized;
    const hash = createHash('sha256').update(`${serverName}\0${raw}`).digest('hex').slice(0, 12);
    return `${normalized.slice(0, 64 - 13)}_${hash}`;
  }

  async function httpPostJson(url, headers, body, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        redirect: 'manual',
      });
      const text = await resp.text();
      return { status: resp.status, headers: resp.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  // OAuth token endpoints speak application/x-www-form-urlencoded (RFC 6749).
  async function httpPostForm(url, headers, form, timeoutMs = 60000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
        body: new URLSearchParams(form).toString(),
        signal: ctrl.signal,
        redirect: 'manual',
      });
      const text = await resp.text();
      return { status: resp.status, headers: resp.headers, text };
    } finally {
      clearTimeout(timer);
    }
  }

  function parseBody(resp) {
    try { return JSON.parse(resp.text); } catch { return null; }
  }

  function issuerOf(server) {
    if (server.oauth?.issuer) return server.oauth.issuer.replace(/\/$/, '');
    return new URL(server.url).origin;
  }

  async function discoverOauthMetadata(server) {
    const issuer = issuerOf(server);
    try {
      const resp = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const md = await resp.json().catch(() => null);
        if (md && md.authorization_endpoint && md.token_endpoint) return md;
      }
    } catch {}
    return {
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/register`,
    };
  }

  function callbackFor(origin, serverId) {
    return `${origin}${CALLBACK_PATH}/${serverId}`;
  }

  // Register a dynamic OAuth client for this server (RFC 7591), bound to the
  // origin the browser actually uses. Re-registers if the origin changed
  // (e.g. the GUI moved to another port), since redirect_uri must match
  // exactly at exchange time.
  async function ensureClientId(server, md, origin) {
    const redirect = callbackFor(origin, server.id);
    if (server.oauth?.clientId && server.oauth.redirect === redirect) return server.oauth.clientId;
    const regEndpoint = md.registration_endpoint ?? `${issuerOf(server)}/register`;
    const resp = await httpPostJson(regEndpoint, {}, {
      client_name: `dsh-mcp-manager-${server.name}`,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      redirect_uris: [redirect],
    });
    const reg = parseBody(resp);
    if (!reg?.client_id) throw new Error(`client registration failed: HTTP ${resp.status} ${String(resp.text).slice(0, 200)}`);
    server.oauth = server.oauth ?? {};
    server.oauth.clientId = reg.client_id;
    server.oauth.redirect = redirect;
    saveState(state);
    return reg.client_id;
  }

  async function startAuth(server, origin) {
    const md = await discoverOauthMetadata(server);
    const clientId = await ensureClientId(server, md, origin);
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const csrf = b64url(randomBytes(16));
    pending.set(server.id, { state: csrf, verifier });
    const url = new URL(md.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackFor(origin, server.id));
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', csrf);
    setLive(server.id, { status: 'authorizing', error: '' });
    return url.toString();
  }

  async function exchangeCode(server, code, origin) {
    const flow = pending.get(server.id);
    if (!flow) throw new Error('no pending authorization for this server');
    pending.delete(server.id);
    const md = await discoverOauthMetadata(server);
    const clientId = await ensureClientId(server, md, origin);
    const resp = await httpPostForm(md.token_endpoint, {}, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackFor(origin, server.id),
      client_id: clientId,
      code_verifier: flow.verifier,
    });
    const tok = parseBody(resp);
    if (!tok?.access_token) throw new Error(`token exchange failed: HTTP ${resp.status} ${String(resp.text).slice(0, 200)}`);
    server.oauth = server.oauth ?? {};
    server.oauth.tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? server.oauth.tokens?.refresh_token ?? '',
      expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000,
    };
    saveState(state);
  }

  async function refreshTokens(server) {
    const tokens = server.oauth?.tokens;
    if (!tokens?.refresh_token) return false;
    const md = await discoverOauthMetadata(server);
    const clientId = server.oauth?.clientId;
    if (!clientId) return false;
    const resp = await httpPostForm(md.token_endpoint, {}, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    const tok = parseBody(resp);
    if (!tok?.access_token) return false;
    server.oauth.tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000,
    };
    saveState(state);
    return true;
  }

  function accessToken(server) {
    if (server.authMode === 'static') {
      const envName = server.tokenEnv;
      return envName ? (process.env[envName] ?? '') : '';
    }
    return server.oauth?.tokens?.access_token ?? '';
  }

  // Merge user-defined HTTP headers: direct values plus values read from
  // environment variables (Codex-style, so secrets never persist in the config).
  function resolveHeaders(server) {
    const headers = {};
    for (const [k, v] of Object.entries(server.headers ?? {})) headers[k] = String(v);
    for (const [k, envName] of Object.entries(server.headerEnv ?? {})) {
      const val = envName ? process.env[envName] : undefined;
      if (val !== undefined) headers[k] = String(val);
    }
    return headers;
  }

  // Authorization + custom headers + session id, applied to every HTTP request.
  function authHeaders(server, conn) {
    const headers = resolveHeaders(server);
    const token = accessToken(server);
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (conn?.sessionId) headers['Mcp-Session-Id'] = conn.sessionId;
    return headers;
  }

  // Whether this server currently has usable credentials to attempt a connection.
  function hasToken(server) {
    if (server.authMode === 'static') return accessToken(server) !== '';
    return !!server.oauth?.tokens;
  }

  let rpcSeq = 1;

  function parseRpc(resp) {
    let parsed = parseBody(resp);
    if (!parsed && typeof resp.text === 'string') {
      // SSE body fallback: join data: lines
      const data = resp.text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      try { parsed = JSON.parse(data); } catch {}
    }
    return parsed;
  }

  async function mcpRpc(server, method, params, conn, { isNotification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    if (!isNotification) payload.id = rpcSeq++;
    let resp = await httpPostJson(server.url, authHeaders(server, conn), payload);
    if (resp.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
      resp = await httpPostJson(server.url, authHeaders(server, conn), payload);
    }
    if (resp.status >= 400) throw new Error(`MCP ${method} HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`);
    if (isNotification) return null;
    const parsed = parseRpc(resp);
    if (!parsed) throw new Error(`MCP ${method}: non-JSON response`);
    if (parsed.error) throw new Error(`MCP ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    return parsed.result;
  }

  function setLive(serverId, patch) {
    const cur = live.get(serverId) ?? { sessionId: null, tools: new Map(), status: 'disconnected', error: '', toolCount: 0 };
    Object.assign(cur, patch);
    live.set(serverId, cur);
    return cur;
  }

  // Sanitize a server JSON Schema into the raw object form the registry's
  // assertSupportedJsonSchema boundary accepts (same pass-through shape the
  // official dsh-mcp-client uses). Unsupported vocabulary degrades to the
  // annotation-only unconstrained form, which the raw boundary allows.
  const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);
  const isScalar = (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
  const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function sanitizeValue(node) {
    if (!isPlainObj(node)) return { description: 'unconstrained JSON value' };
    if (Array.isArray(node.oneOf) && node.oneOf.length >= 2) return { oneOf: node.oneOf.map(sanitizeValue) };
    const t = typeof node.type === 'string' ? node.type : null;
    const out = {};
    if (typeof node.description === 'string') out.description = node.description;
    if (t === 'object') {
      out.type = 'object';
      if (typeof node.additionalProperties === 'boolean') out.additionalProperties = node.additionalProperties;
      if (isPlainObj(node.properties)) {
        out.properties = {};
        for (const k of Object.keys(node.properties)) out.properties[k] = sanitizeValue(node.properties[k]);
        if (Array.isArray(node.required)) {
          const req = node.required.filter((k) => typeof k === 'string' && k in out.properties);
          if (req.length > 0) out.required = req;
        }
      }
    } else if (t === 'array') {
      out.type = 'array';
      if (node.items != null) out.items = sanitizeValue(node.items);
    } else if (t && SCALAR_TYPES.has(t)) {
      out.type = t;
      if (Array.isArray(node.enum)) {
        const vals = node.enum.filter(isScalar);
        if (vals.length > 0) out.enum = vals;
      }
      if (isScalar(node.const)) out.const = node.const;
    } else {
      // Unsupported vocabulary (anyOf/allOf/$ref/pattern/format/bounds/...):
      // degrade to annotation-only — the raw boundary's unconstrained form.
      out.description = out.description ?? 'unconstrained JSON value';
    }
    return out;
  }

  function convParams(schema) {
    const root = sanitizeValue(schema);
    if (root.type !== 'object') {
      return { type: 'object', properties: {} };
    }
    return root;
  }

  const textRender = (args, v) => [{ type: 'text', text: (v && v.text) || '' }];
  const MCP_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      isError: { type: 'boolean' },
    },
  };

  // ---------- stdio transport (JSON-RPC over stdin/stdout, newline-delimited) ----------
  function spawnStdio(server) {
    // On Windows, `npx`/`uvx` are `.cmd` shims that spawn() cannot launch
    // directly (ENOENT for the bare name, EINVAL for the `.cmd` path). Letting
    // the shell resolve them fixes both cases. On POSIX this is a no-op.
    const isWin = process.platform === 'win32';
    const child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd || process.cwd(),
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
    });
    const pending = new Map(); // id -> { resolve, reject, timer }
    let buffer = '';
    let stderrTail = '';
    let closed = false;
    let seq = 1;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
        // server→client notifications (no id) are ignored
      }
    });
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString('utf8')).slice(-2000); });
    const fail = (error) => {
      if (closed) return;
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
      pending.clear();
    };
    child.on('error', fail);
    child.on('close', () => fail(new Error(stderrTail ? `stdio process exited: ${stderrTail.slice(-300)}` : 'stdio process exited')));

    function send(payload) {
      if (closed) throw new Error('stdio process closed');
      child.stdin.write(JSON.stringify(payload) + '\n');
    }
    function request(method, params, timeoutMs = 60000) {
      if (closed) return Promise.reject(new Error('stdio process closed'));
      return new Promise((resolve, reject) => {
        const id = seq++;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`stdio ${method} timeout`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { send({ jsonrpc: '2.0', id, method, params }); }
        catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    }
    function notify(method, params) {
      if (closed) return;
      try { send({ jsonrpc: '2.0', method, params }); } catch {}
    }
    function close() {
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('stdio process closed')); }
      pending.clear();
      try { child.kill(); } catch {}
    }
    return { request, notify, close };
  }

  // Shared tool registration from a tools/list result. callFn(toolName, args) resolves to the raw tools/call result.
  function registerTools(server, conn, tools, callFn) {
    for (const dispose of conn.tools.values()) { try { dispose(); } catch {} }
    conn.tools = new Map();
    for (const tool of tools) {
      const name = publicName(server.name, tool.name);
      const definition = {
        name,
        description: `${tool.description ?? ''} [${server.name} MCP]`.slice(0, 2000),
        parameters: convParams(tool.inputSchema),
        output: { schema: MCP_RESULT_SCHEMA, render: textRender },
        isConcurrencySafe: () => true,
        async execute(args) {
          const r = await callFn(tool.name, args ?? {});
          const content = r?.content ?? [];
          const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
          return { text, isError: r?.isError === true };
        },
      };
      conn.tools.set(tool.name, ctx.tools.register(definition));
    }
    conn.toolCount = tools.length;
    conn.status = 'connected';
    conn.error = '';
    ctx.logger.info(`mcp-manager: ${server.name} connected, ${tools.length} tools`);
  }

  async function connectHttp(server, conn) {
    const initPayload = { jsonrpc: '2.0', id: rpcSeq++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.1.0' } } };
    let resp = await httpPostJson(server.url, authHeaders(server, conn), initPayload);
    if (resp.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
      resp = await httpPostJson(server.url, authHeaders(server, conn), initPayload);
    }
    if (resp.status === 401) throw new Error('authentication required');
    if (resp.status >= 400) throw new Error(`initialize HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`);
    const init = parseRpc(resp);
    if (!init || init.error) throw new Error(`initialize failed: ${String(resp.text).slice(0, 200)}`);
    const sid = resp.headers?.get?.('mcp-session-id');
    conn.sessionId = sid ?? null;
    await mcpRpc(server, 'notifications/initialized', undefined, conn, { isNotification: true }).catch(() => {});
    const listed = await mcpRpc(server, 'tools/list', {}, conn);
    registerTools(server, conn, listed?.tools ?? [], (name, args) =>
      mcpRpc(server, 'tools/call', { name, arguments: args }, conn));
  }

  async function connectStdio(server, conn) {
    // Kill any previous child for this server before respawning.
    try { conn.transport?.close?.(); } catch {}
    const transport = spawnStdio(server);
    conn.transport = transport;
    await transport.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.1.0' } });
    transport.notify('notifications/initialized');
    const listed = await transport.request('tools/list', {});
    registerTools(server, conn, listed?.tools ?? [], (name, args) =>
      transport.request('tools/call', { name, arguments: args }));
  }

  async function connect(server) {
    const conn = setLive(server.id, { status: 'connecting', error: '' });
    try {
      if ((server.type ?? 'http') === 'stdio') await connectStdio(server, conn);
      else await connectHttp(server, conn);
    } catch (error) {
      for (const dispose of conn.tools.values()) { try { dispose(); } catch {} }
      conn.tools = new Map();
      conn.toolCount = 0;
      try { conn.transport?.close?.(); } catch {}
      conn.transport = null;
      conn.status = (server.type ?? 'http') !== 'stdio' && server.authMode === 'oauth' && !server.oauth?.tokens ? 'needs-auth' : 'error';
      conn.error = String(error?.message ?? error).slice(0, 300);
      ctx.logger.warn(`mcp-manager: ${server.name} ${conn.status}: ${conn.error}`);
    }
    return conn;
  }

  function disconnect(serverId) {
    const conn = live.get(serverId);
    if (!conn) return;
    for (const dispose of conn.tools.values()) { try { dispose(); } catch {} }
    try { conn.transport?.close?.(); } catch {}
    live.delete(serverId);
  }

  function serverView(server) {
    const conn = live.get(server.id);
    const type = server.type ?? 'http';
    const enabled = server.enabled !== false;
    const view = {
      id: server.id,
      name: server.name,
      type,
      enabled,
      status: !enabled
        ? 'disabled'
        : (conn?.status ?? ((type !== 'stdio' && server.authMode === 'oauth' && !server.oauth?.tokens) ? 'needs-auth' : 'disconnected')),
      toolCount: conn?.toolCount ?? 0,
      error: conn?.error ?? '',
    };
    if (type === 'stdio') {
      view.command = server.command;
      view.args = server.args ?? [];
      view.env = server.env ?? {};
      view.cwd = server.cwd ?? '';
    } else {
      view.url = server.url;
      view.authMode = server.authMode;
      view.headers = server.headers ?? {};
      view.headerEnv = server.headerEnv ?? {};
      if (server.authMode === 'static') view.tokenEnv = server.tokenEnv ?? '';
    }
    return view;
  }

  // ---------- HTTP API on the GUI webserver ----------
  function json(res, code, value) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
  }

  // Tokenize a command-line args string (respecting double/single quotes) into an argv array.
  function parseArgs(args) {
    if (Array.isArray(args)) return args.filter((a) => typeof a === 'string');
    if (typeof args === 'string') {
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(args))) out.push(m[1] ?? m[2] ?? m[3]);
      return out;
    }
    return [];
  }

  // Normalize an env payload (object or JSON string) into a flat string->string map.
  function parseEnv(env) {
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const out = {};
      for (const k of Object.keys(env)) out[k] = String(env[k] ?? '');
      return out;
    }
    if (typeof env === 'string' && env.trim()) {
      try {
        const o = JSON.parse(env);
        if (o && typeof o === 'object' && !Array.isArray(o)) return parseEnv(o);
      } catch {}
    }
    return {};
  }

  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/mcp-manager',
    async handler(req, res) {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      // The browser-facing origin: prefer the request's own Host header (the
      // browser always sends it for same-origin fetches and OAuth redirects).
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
      try {
        // OAuth redirect: /mcp-manager/callback/:id
        const cbMatch = path.match(/^\/mcp-manager\/callback\/([A-Za-z0-9_-]+)$/);
        if (cbMatch && req.method === 'GET') {
          const server = state.servers.find((s) => s.id === cbMatch[1]);
          const code = url.searchParams.get('code');
          const flowState = url.searchParams.get('state');
          const oauthError = url.searchParams.get('error');
          const done = (ok, message) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>${ok ? '✅ Authorized' : '❌ Authorization failed'}</h2><p>${message}</p><p><a href="/">Back to DSH</a></p></body>`);
          };
          if (!server) return done(false, 'No MCP server config matches this callback');
          if (oauthError) { setLive(server.id, { status: 'needs-auth', error: oauthError }); return done(false, `Server returned: ${oauthError}`); }
          if (!code || pending.get(server.id)?.state !== flowState) { setLive(server.id, { status: 'needs-auth', error: 'session expired' }); return done(false, 'Authorization session expired or invalid — start again from Settings → MCP'); }
          try {
            await exchangeCode(server, code, origin);
            const conn = await connect(server);
            return done(true, `Connected to ${server.name}; ${conn.toolCount} tools registered. You can close this page.`);
          } catch (error) {
            setLive(server.id, { status: 'error', error: String(error?.message ?? error).slice(0, 300) });
            return done(false, `Token exchange failed: ${error?.message ?? error}`);
          }
        }

        // JSON API: /mcp-manager/api/...
        if (!path.startsWith(API_PREFIX)) { res.writeHead(404); res.end(); return; }
        const rest = path.slice(API_PREFIX.length);
        const idMatch = rest.match(/^\/servers\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);

        if (req.method === 'GET' && rest === '/ping') {
          return json(res, 200, { ok: true, version: 2, stdio: true });
        }
        if (req.method === 'GET' && rest === '/servers') {
          return json(res, 200, { servers: state.servers.map(serverView) });
        }
        if (req.method === 'POST' && rest === '/servers') {
          const body = await readBody(req);
          const name = String(body.name ?? '').trim();
          const type = body.type === 'stdio' ? 'stdio' : 'http';
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json(res, 400, { error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)' });
          if (state.servers.some((s) => s.name === name)) return json(res, 409, { error: `a server named ${name} already exists` });

          let server;
          if (type === 'stdio') {
            const command = String(body.command ?? '').trim();
            if (!command) return json(res, 400, { error: 'stdio server requires a command (executable, e.g. npx / uvx / python)' });
            server = {
              id: b64url(randomBytes(8)),
              name, type: 'stdio', command,
              args: parseArgs(body.args),
              env: parseEnv(body.env),
            };
            const cwd = String(body.cwd ?? '').trim();
            if (cwd) server.cwd = cwd;
          } else {
            const serverUrl = String(body.url ?? '').trim();
            const authMode = body.authMode === 'static' ? 'static' : 'oauth';
            if (!/^https?:\/\//.test(serverUrl)) return json(res, 400, { error: 'url must be an http(s) URL' });
            server = {
              id: b64url(randomBytes(8)),
              name, type: 'http', url: serverUrl, authMode,
              headers: parseEnv(body.headers),
              headerEnv: parseEnv(body.headerEnv),
              ...(authMode === 'static' ? { tokenEnv: String(body.tokenEnv ?? '').trim() } : {}),
            };
          }

          state.servers.push(server);
          saveState(state);
          if (type === 'stdio') connect(server);
          else if (hasToken(server)) connect(server);
          else setLive(server.id, { status: 'needs-auth', error: server.authMode === 'static' ? 'missing token (set the env var)' : '' });
          return json(res, 201, { server: serverView(server) });
        }
        if (idMatch) {
          const server = state.servers.find((s) => s.id === idMatch[1]);
          if (!server) return json(res, 404, { error: 'server not found' });
          const action = idMatch[2];
          if (req.method === 'POST' && action === '/auth') {
            const authorizeUrl = await startAuth(server, origin);
            return json(res, 200, { authorizeUrl });
          }
          if (req.method === 'POST' && action === '/connect') {
            const conn = await connect(server);
            return json(res, 200, { server: serverView(server) });
          }
          if (req.method === 'POST' && action === '/enabled') {
            const body = await readBody(req);
            const enabled = body.enabled !== false;
            if (enabled === (server.enabled !== false)) {
              return json(res, 200, { server: serverView(server) });
            }
            server.enabled = enabled;
            saveState(state);
            if (!enabled) {
              // Unregister every tool and tear down the transport; config and
              // OAuth tokens stay persisted for the next enable.
              disconnect(server.id);
            } else if ((server.type ?? 'http') === 'stdio') {
              await connect(server);
            } else if (hasToken(server)) {
              await connect(server);
            } else {
              setLive(server.id, { status: 'needs-auth', error: server.authMode === 'static' ? 'missing token (set the env var)' : '' });
            }
            return json(res, 200, { server: serverView(server) });
          }
          if (req.method === 'PUT' && !action) {
            const body = await readBody(req);
            const type = body.type === 'stdio' ? 'stdio' : 'http';

            // 1. 校验(先不改动 server,全部通过后再写)
            const newName = String(body.name ?? server.name).trim();
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(newName)) return json(res, 400, { error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)' });
            if (newName !== server.name && state.servers.some((s) => s.name === newName && s.id !== server.id)) return json(res, 409, { error: `a server named ${newName} already exists` });

            let next;
            if (type === 'stdio') {
              const command = String(body.command ?? '').trim();
              if (!command) return json(res, 400, { error: 'stdio server requires a command (executable, e.g. npx / uvx / python)' });
              next = { command, args: parseArgs(body.args), env: parseEnv(body.env) };
              const cwd = String(body.cwd ?? '').trim();
              if (cwd) next.cwd = cwd;
            } else {
              const serverUrl = String(body.url ?? '').trim();
              if (!/^https?:\/\//.test(serverUrl)) return json(res, 400, { error: 'url must be an http(s) URL' });
              next = {
                url: serverUrl,
                authMode: body.authMode === 'static' ? 'static' : 'oauth',
                headers: parseEnv(body.headers),
                headerEnv: parseEnv(body.headerEnv),
              };
              if (next.authMode === 'static') {
                // 留空表示保留原有环境变量名(编辑表单只回填变量名,不回填实际值)
                next.tokenEnv = String(body.tokenEnv ?? '').trim() || server.tokenEnv || '';
              }
            }

            // 2. 断开旧连接,再更新配置
            disconnect(server.id);
            server.name = newName;
            server.type = type;
            if (type === 'stdio') {
              server.command = next.command;
              server.args = next.args;
              server.env = next.env;
              if (next.cwd) server.cwd = next.cwd; else delete server.cwd;
              delete server.url; delete server.authMode; delete server.tokenEnv; delete server.headers; delete server.headerEnv; delete server.oauth;
            } else {
              server.url = next.url;
              server.authMode = next.authMode;
              server.headers = next.headers;
              server.headerEnv = next.headerEnv;
              if (next.authMode === 'static') server.tokenEnv = next.tokenEnv; else delete server.tokenEnv;
              if (next.authMode !== 'static') delete server.oauth;
              delete server.command; delete server.args; delete server.env; delete server.cwd;
            }
            saveState(state);

            // 3. 按新配置重连
            if (type === 'stdio') await connect(server);
            else if (hasToken(server)) await connect(server);
            else setLive(server.id, { status: 'needs-auth', error: server.authMode === 'static' ? 'missing token (set the env var)' : '' });
            return json(res, 200, { server: serverView(server) });
          }
          if (req.method === 'DELETE' && !action) {
            disconnect(server.id);
            state.servers = state.servers.filter((s) => s.id !== server.id);
            saveState(state);
            return json(res, 200, { ok: true });
          }
        }
        res.writeHead(404); res.end();
      } catch (error) {
        ctx.logger.error(`mcp-manager api: ${error?.stack ?? error}`);
        json(res, 500, { error: String(error?.message ?? error).slice(0, 300) });
      }
    },
  });
  ctx.effect(() => route);
  // On plugin unload/reload, kill every live stdio child process.
  ctx.effect(() => () => {
    for (const conn of live.values()) { try { conn.transport?.close?.(); } catch {} }
  });

  // ---------- startup: auto-connect stdio servers and HTTP servers that have credentials ----------
  for (const server of state.servers) {
    if (server.enabled === false) continue; // disabled servers stay dormant until re-enabled
    if ((server.type ?? 'http') === 'stdio') connect(server);
    else if (hasToken(server)) connect(server);
    else setLive(server.id, { status: 'needs-auth', error: '' });
  }
}
