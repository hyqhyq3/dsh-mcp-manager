import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, realpathSync, watchFile, unwatchFile } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

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
 *     auto-reconnects and refreshes tokens across restarts. Static bearer
 *     tokens are never stored: only the name of the environment variable that
 *     holds them (`tokenEnv`) is persisted, plus `headers`/`headerEnv` for
 *     Codex-style custom HTTP headers.
 *
 * HTTP surface (mounted on the DSH GUI webserver):
 *   GET  /mcp-manager/api/ping            liveness + version probe
 *   GET  /mcp-manager/api/settings        profile-level feature settings
 *   POST /mcp-manager/api/settings/on-demand  toggle broker-mode MCP tools
 *   GET  /mcp-manager/api/servers         list servers with live status
 *   POST /mcp-manager/api/servers         add a server (http or stdio)
 *   PUT  /mcp-manager/api/servers/:id     edit a server (name/type/transport/auth)
 *   POST /mcp-manager/api/servers/:id/auth     start OAuth (returns authorizeUrl)
 *   POST /mcp-manager/api/servers/:id/connect  (re)connect
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
// Per-workspace declarative config, Claude/Codex-style (same shape as the
// global servers, plus an optional `exclude` list of global server names to
// mask inside that workspace).
const WORKSPACE_CONFIG_REL = join('.dsh', 'dshmm', 'mcp.json');

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

// Raster formats supported by the DSH durable attachment vocabulary (same
// allow-list as @deepseek-ai/dsh-mcp-client).
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsImage(content) {
  return Array.isArray(content) && content.some((value) => isRecord(value) && value.type === 'image');
}

function imageDiagnostic(block, reason) {
  const mediaType = block?.mimeType ?? 'unknown media type';
  return `[image unavailable: ${mediaType}; ${reason}; raw image data remains available to programmatic callers]`;
}

function isDshImageAttachment(attachment) {
  return isRecord(attachment)
    && attachment.attachmentId != null
    && attachment.mediaType != null
    && attachment.bytes != null;
}

/**
 * Project untrusted MCP content blocks into DSH ContentBlocks.
 * Text blocks are preserved; image blocks are handed to `image` (default: a
 * text placeholder so DSH never sees `{type:'image', data}` without attachment).
 */
export function projectMcpContent(mcpContent, image = (block) => ({
  type: 'text',
  text: imageDiagnostic(block, 'this result was not admitted to durable model context'),
})) {
  const projected = [];
  for (const [index, value] of (Array.isArray(mcpContent) ? mcpContent : []).entries()) {
    if (!isRecord(value)) {
      projected.push({ type: 'text', text: '[unsupported MCP content block: expected an object]' });
      continue;
    }
    switch (value.type) {
      case 'text':
        if (value.text !== undefined) projected.push({ type: 'text', text: value.text });
        break;
      case 'image':
        projected.push(image(value, index));
        break;
      case 'resource_link':
        if (value.name === undefined || value.uri === undefined) {
          projected.push({ type: 'text', text: '[resource link unavailable: the MCP block is missing its name or URI]' });
        } else {
          projected.push({ type: 'text', text: `Resource link: ${value.name} (${value.uri})` });
        }
        break;
      case 'audio':
        projected.push({ type: 'text', text: `[audio result unsupported: ${value.mimeType ?? 'unknown media type'}; raw audio data remains available to programmatic callers]` });
        break;
      case 'resource':
        projected.push({ type: 'text', text: '[embedded resource unsupported; raw resource data remains available to programmatic callers]' });
        break;
      default:
        projected.push({ type: 'text', text: `[unsupported MCP content type: ${value.type}]` });
    }
  }
  return projected.length > 0 ? projected : [{ type: 'text', text: '' }];
}

/** Native `output.render` for MCP tools: text-first, never a bare MCP image. */
export function renderMcpResult(_args, value) {
  if (Array.isArray(value?.content) && value.content.length > 0) return projectMcpContent(value.content);
  return [{ type: 'text', text: value?.text || '' }];
}

/**
 * Native `output.render` for `mcp_execute_tool`. Inner tools should already
 * have projected images; still refuse a bare MCP image so a nested buggy
 * result cannot poison session history.
 */
export function renderBrokerExecuteResult(_args, value) {
  const content = Array.isArray(value?.content) ? value.content : [];
  if (content.length === 0) return [{ type: 'text', text: 'MCP tool completed with no output.' }];
  return content.map((block) => {
    if (isRecord(block) && block.type === 'image' && !isDshImageAttachment(block.attachment)) {
      return { type: 'text', text: imageDiagnostic(block, 'raw MCP image data was not projected to a DSH attachment') };
    }
    return block;
  });
}

function decodeImage(block) {
  if (block.mimeType === undefined || !IMAGE_MEDIA_TYPES.has(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF');
  }
  if (block.data === undefined || !CANONICAL_BASE64.test(block.data)) {
    throw new Error('the image data is not canonical base64');
  }
  const data = Buffer.from(block.data, 'base64');
  if (data.toString('base64') !== block.data) {
    throw new Error('the image data is not canonical base64');
  }
  return { data, mediaType: block.mimeType };
}

function ctxGet(ctx, name) {
  if (ctx == null) return undefined;
  if (typeof ctx.get === 'function') return ctx.get(name);
  return ctx[name];
}

async function resolveImageAdmission(ctx, exec) {
  const attachments = ctxGet(ctx, 'attachments');
  if (attachments === undefined) throw new Error('no attachment store is mounted');
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  const llm = ctxGet(ctx, 'llm');
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved');
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    throw new Error('the current model route could not be verified');
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`);
  }
  if (exec.signal?.aborted) throw new Error('the tool call was canceled before image storage');
  return attachments;
}

async function saveDecodedImages(attachments, decoded) {
  if (typeof attachments.saveImages === 'function') return attachments.saveImages(decoded);
  const refs = [];
  for (const item of decoded) refs.push(await attachments.saveImage(item));
  return refs;
}

async function prepareImageProjection(ctx, exec, content) {
  const decoded = [];
  const validationErrors = new Map();
  const imageIndexes = [];
  for (const [index, value] of content.entries()) {
    if (!isRecord(value) || value.type !== 'image') continue;
    imageIndexes.push(index);
    try {
      decoded.push(decodeImage(value));
    } catch (error) {
      validationErrors.set(index, error?.message ?? String(error));
    }
  }
  if (validationErrors.size > 0) {
    return projectMcpContent(content, (block, index) => ({
      type: 'text',
      text: imageDiagnostic(block, validationErrors.get(index) ?? 'another image in the same result was invalid'),
    }));
  }

  let attachments;
  try {
    attachments = await resolveImageAdmission(ctx, exec);
  } catch (error) {
    const reason = error?.message ?? String(error);
    return projectMcpContent(content, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }));
  }

  try {
    const refs = await saveDecodedImages(attachments, decoded);
    const byIndex = new Map(imageIndexes.map((index, offset) => [index, refs[offset]]));
    return projectMcpContent(content, (block, index) => {
      const attachment = byIndex.get(index);
      if (!isDshImageAttachment(attachment)) {
        return { type: 'text', text: imageDiagnostic(block, 'durable image storage rejected the result') };
      }
      return { type: 'image', attachment };
    });
  } catch (error) {
    const admission = error && typeof error === 'object' && (error.name === 'AttachmentError' || typeof error.code === 'string');
    const reason = admission
      ? `image admission rejected the result: ${error.message}`
      : 'durable image storage rejected the result';
    return projectMcpContent(content, (block) => ({ type: 'text', text: imageDiagnostic(block, reason) }));
  }
}

/**
 * Generation-local image projection for one MCP tool, matching the official
 * dsh-mcp-client contract: execute stages a projection; finalizeContent
 * installs it only when the registry's post-execute result is unchanged.
 */
export function mcpImageProjectionHandlers(ctx, toolName) {
  const projections = new WeakMap();
  return {
    async prepare(value, exec, args) {
      const content = Array.isArray(value?.content) ? value.content : [];
      if (!exec || !containsImage(content)) return;
      const fallback = renderMcpResult(args, value);
      const projected = await prepareImageProjection(ctx, exec, content);
      projections.set(exec, { value, fallback, content: projected });
    },
    finalizeContent(exec, result) {
      const projection = projections.get(exec);
      if (projection === undefined) return undefined;
      projections.delete(exec);
      if (result.isError) return undefined;
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined;
      if (!isDeepStrictEqual(result.content, projection.fallback)) return undefined;
      return projection.content;
    },
  };
}

export const inject = ['tools', 'webServer'];

export function apply(ctx) {
  const state = loadState();
  // Per-workspace OAuth client registrations + tokens (keyed by canonical
  // workspace path + server name); secrets live in the same sensitive state
  // file as the global servers, never in the declarative mcp.json.
  if (!state.workspaceTokens) state.workspaceTokens = {};
  if (state.onDemandToolInjection !== true) state.onDemandToolInjection = false;

  // One-time migration (≤0.3.0 → 0.4.0): static-token servers used to store
  // the plaintext bearer token at `staticToken`. The new model reads the token
  // from the environment variable named by `tokenEnv`. `accessToken` keeps the
  // legacy `staticToken` as a fallback so existing configs keep working with no
  // user action; the value is dropped once the server is re-saved with an env
  // var name (see the PUT handler). Warn so the user knows to migrate.
  for (const server of state.servers ?? []) {
    if (server.authMode === 'static' && !server.tokenEnv && typeof server.staticToken === 'string' && server.staticToken) {
      ctx.logger.warn(`mcp-manager: ${server.name} uses a legacy plaintext static token; re-save it with an env var name in Settings → MCP (it keeps working until then)`);
    }
  }

  // serverId -> live connection { sessionId, tools: Map<raw, disposer>, status, error, toolCount }
  const live = new Map();
  // serverId -> pending OAuth flow { state, verifier }
  const pending = new Map();

  // ---- workspace isolation state ----
  // globalServerName -> Set<currently-registered global tool names>. Only these
  // names may be denied via tools.restrict() (restrict rejects unknown names).
  const globalToolsByServer = new Map();
  // canonicalWorkspacePath -> workspace record { path, rawPath, servers: Map<name, wsConn>, agents: Set<agent>, exclude, watcher, error }
  const workspaces = new Map();
  // agent -> { wsPath, disposers: Map<serverName, Array<disposer>>, restrictDisposer }
  const agentScopeState = new Map();
  // canonicalWorkspacePath -> Promise, serializing rescan passes per workspace.
  const workspaceRescans = new Map();

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
    persistServer(server);
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
    setServerAuthStatus(server, 'authorizing');
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
    persistServer(server);
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
    persistServer(server);
    return true;
  }

  function accessToken(server) {
    if (server.authMode === 'static') {
      const envName = server.tokenEnv;
      if (envName) return process.env[envName] ?? '';
      // Legacy fallback: ≤0.3.0 configs stored the plaintext token at
      // `staticToken`. Honor it so existing servers keep working until they are
      // re-saved with an env var name (one-time migration; the PUT handler
      // drops this field once `tokenEnv` is set). Never log this value.
      return server.staticToken ?? '';
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

  function parseSseMessages(text) {
    const messages = [];
    let data = [];
    const flush = () => {
      if (data.length === 0) return;
      const value = data.join('\n');
      data = [];
      if (value === '[DONE]') return;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) messages.push(...parsed);
        else messages.push(parsed);
      } catch {}
    };
    for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
      if (line === '') flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    flush();
    return messages;
  }

  function parseRpc(resp, expectedId, conn) {
    const body = parseBody(resp);
    const messages = body == null
      ? parseSseMessages(resp.text)
      : (Array.isArray(body) ? body : [body]);
    for (const message of messages) {
      if (message && message.id == null && typeof message.method === 'string') conn?.onNotification?.(message);
    }
    if (expectedId !== undefined) return messages.find((message) => message?.id === expectedId) ?? null;
    return messages.find((message) => message?.id != null || message?.result !== undefined || message?.error !== undefined) ?? null;
  }

  async function mcpRpc(server, method, params, conn, { isNotification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (params !== undefined) payload.params = params;
    const requestId = isNotification ? undefined : rpcSeq++;
    if (!isNotification) payload.id = requestId;
    let resp = await httpPostJson(server.url, authHeaders(server, conn), payload);
    if (resp.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
      resp = await httpPostJson(server.url, authHeaders(server, conn), payload);
    }
    if (resp.status >= 400) throw new Error(`MCP ${method} HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`);
    const parsed = parseRpc(resp, requestId, conn);
    if (isNotification) return null;
    if (!parsed) throw new Error(`MCP ${method}: non-JSON response`);
    if (parsed.error) throw new Error(`MCP ${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    return parsed.result;
  }

  function bindToolsChanged(server, handle, refresh) {
    let running = false;
    let queued = false;
    const run = async () => {
      if (running || handle.closed) return;
      running = true;
      try {
        do {
          queued = false;
          await refresh();
        } while (queued && !handle.closed);
      } catch (error) {
        ctx.logger.warn(`mcp-manager: refreshing tools for ${server.name} failed: ${error?.message ?? error}`);
      } finally {
        running = false;
        if (queued && !handle.closed) void run();
      }
    };
    handle.onNotification = (message) => {
      if (message?.method !== 'notifications/tools/list_changed' || handle.closed) return;
      queued = true;
      void run();
    };
    handle.startNotifications?.();
  }

  function startHttpNotificationStream(server, handle) {
    if (handle.notificationStarted || handle.closed) return;
    handle.notificationStarted = true;
    const controller = new AbortController();
    handle.notificationController = controller;
    void (async () => {
      while (!controller.signal.aborted && !handle.closed) {
        try {
          const request = () => fetch(server.url, {
            method: 'GET',
            headers: { Accept: 'text/event-stream', ...authHeaders(server, handle) },
            signal: controller.signal,
            redirect: 'manual',
          });
          let response = await request();
          if (response.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
            await response.body?.cancel().catch(() => {});
            response = await request();
          }
          if (response.status === 404 || response.status === 405) return;
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            buffer = buffer.replace(/\r\n/g, '\n');
            let split;
            while ((split = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, split);
              buffer = buffer.slice(split + 2);
              for (const message of parseSseMessages(`${block}\n\n`)) handle.onNotification?.(message);
            }
          }
          buffer += decoder.decode();
          for (const message of parseSseMessages(buffer)) handle.onNotification?.(message);
        } catch (error) {
          if (controller.signal.aborted || handle.closed) return;
          ctx.logger.warn(`mcp-manager: notification stream for ${server.name} stopped: ${error?.message ?? error}`);
        }
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    })();
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

  const textRender = renderMcpResult;
  const MCP_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      content: { type: 'array', items: { description: 'MCP content block.' } },
      isError: { type: 'boolean' },
    },
    required: ['text', 'content', 'isError'],
  };

  const BROKER_SEARCH_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string' },
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            server: { type: 'string' },
            tool: { type: 'string' },
            description: { type: 'string' },
            score: { type: 'integer' },
          },
          required: ['name', 'server', 'tool', 'description', 'score'],
        },
      },
    },
    required: ['query', 'matches'],
  };

  const BROKER_DESCRIBE_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      server: { type: 'string' },
      tool: { type: 'string' },
      description: { type: 'string' },
      inputSchema: { description: 'Exact registered JSON Schema for this tool input.' },
    },
    required: ['name', 'server', 'tool', 'description', 'inputSchema'],
  };

  const BROKER_EXECUTE_RESULT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      content: { type: 'array', items: { description: 'DSH content block.' } },
    },
    required: ['content'],
  };

  function isMcpToolName(name) {
    return typeof name === 'string' && name.startsWith('mcp__');
  }

  function brokerIdentity(schema, agent) {
    const definition = ctx.tools.get(schema.name, agent);
    if (typeof definition?.mcpServerName === 'string' && typeof definition?.mcpRawName === 'string') {
      return { server: definition.mcpServerName, tool: definition.mcpRawName };
    }
    const rest = schema.name.slice('mcp__'.length);
    const split = rest.indexOf('__');
    if (split < 0) return { server: '', tool: rest };
    return { server: rest.slice(0, split), tool: rest.slice(split + 2) };
  }

  function brokerCatalog(agent) {
    return ctx.tools.schemas(agent)
      .filter((schema) => isMcpToolName(schema.name))
      .map((schema) => ({ schema, ...brokerIdentity(schema, agent) }));
  }

  function brokerJsonRender(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  }

  function makeBrokerDefinitions(approvedParents) {
    let nestedSeq = 1;
    return [
      {
        name: 'mcp_search_tools',
        description: 'Search MCP tools visible in the current session. Use the exact returned name with mcp_describe_tool or mcp_execute_tool.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Keywords describing the needed capability.' },
            server: { type: 'string', description: 'Optional exact MCP server name.' },
            limit: { type: 'integer', description: 'Optional result count, clamped to 1-20 (default 10).' },
          },
          required: ['query'],
        },
        output: { schema: BROKER_SEARCH_RESULT_SCHEMA, render: brokerJsonRender },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const query = String(args?.query ?? '').trim();
          if (!query) throw new Error('query must not be empty');
          const requestedServer = String(args?.server ?? '').trim().toLocaleLowerCase();
          const requestedLimit = Number.isInteger(args?.limit) ? args.limit : 10;
          const limit = Math.max(1, Math.min(20, requestedLimit));
          const terms = [...new Set(query.toLocaleLowerCase().split(/\s+/).filter(Boolean))];
          const matches = [];
          for (const entry of brokerCatalog(exec.agent)) {
            if (requestedServer && entry.server.toLocaleLowerCase() !== requestedServer) continue;
            const server = entry.server.toLocaleLowerCase();
            const tool = entry.tool.toLocaleLowerCase();
            const description = String(entry.schema.description ?? '').toLocaleLowerCase();
            let score = 0;
            for (const term of terms) {
              if (server.includes(term)) score += 2;
              if (tool.includes(term)) score += 3;
              if (description.includes(term)) score += 1;
            }
            if (score === 0) continue;
            matches.push({
              name: entry.schema.name,
              server: entry.server,
              tool: entry.tool,
              description: String(entry.schema.description ?? '').slice(0, 300),
              score,
            });
          }
          matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
          return { query, matches: matches.slice(0, limit) };
        },
      },
      {
        name: 'mcp_describe_tool',
        description: 'Return the complete description and exact input schema for one MCP tool visible in the current session.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Exact mcp__<server>__<tool> name returned by mcp_search_tools.' },
          },
          required: ['name'],
        },
        output: { schema: BROKER_DESCRIBE_RESULT_SCHEMA, render: brokerJsonRender },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const name = String(args?.name ?? '').trim();
          const entry = brokerCatalog(exec.agent).find((candidate) => candidate.schema.name === name);
          if (!entry) throw new Error(`MCP tool "${name}" is not visible in this session`);
          return {
            name: entry.schema.name,
            server: entry.server,
            tool: entry.tool,
            description: String(entry.schema.description ?? ''),
            inputSchema: entry.schema.parameters,
          };
        },
      },
      {
        name: 'mcp_execute_tool',
        description: 'Execute one MCP tool visible in the current session by its exact name and arguments.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: 'Exact mcp__<server>__<tool> name.' },
            arguments: { type: 'object', additionalProperties: true, description: 'Arguments matching the tool input schema.' },
          },
          required: ['name', 'arguments'],
        },
        output: {
          schema: BROKER_EXECUTE_RESULT_SCHEMA,
          render: renderBrokerExecuteResult,
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          const name = String(args?.name ?? '').trim();
          if (!brokerCatalog(exec.agent).some((candidate) => candidate.schema.name === name)) {
            throw new Error(`MCP tool "${name}" is not visible in this session`);
          }
          approvedParents.add(exec.token);
          try {
            const result = await ctx.tools.execute({
              callId: `${exec.callId}:mcp:${nestedSeq++}`,
              rootCallId: exec.rootCallId,
              name,
              arguments: args.arguments ?? {},
              agent: exec.agent,
              parent: exec.token,
              signal: exec.signal,
            });
            if (result.isError) throw new Error(result.error?.message ?? 'MCP tool execution failed');
            return { content: renderBrokerExecuteResult(args, { content: result.content }) };
          } finally {
            approvedParents.delete(exec.token);
          }
        },
      },
    ];
  }

  let brokerRuntimeDispose = null;

  function installBrokerRuntime() {
    const approvedParents = new Set();
    const unsupportedAgents = new WeakSet();
    const warnedUnsupportedAgents = new WeakSet();
    const disposers = [];
    try {
      for (const definition of makeBrokerDefinitions(approvedParents)) {
        disposers.push(ctx.tools.register(definition));
      }
      disposers.push(ctx.tools.guard((exec) => {
        if (!isMcpToolName(exec.name) || exec.agent === undefined || unsupportedAgents.has(exec.agent)) return undefined;
        if (exec.parent !== undefined && approvedParents.has(exec.parent)) return undefined;
        return `direct MCP tool "${exec.name}" is hidden while on-demand MCP tools are enabled; use mcp_execute_tool`;
      }));
      disposers.push(ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next();
        const agent = context.agent ?? context.scope;
        if (!agent || (typeof agent !== 'object' && typeof agent !== 'function')) return assembled;
        const hasCodeSdk = assembled.sections.some((section) => section.name === 'tools:sdk' && section.text.trim() !== '');
        if (hasCodeSdk) {
          unsupportedAgents.add(agent);
          if (!warnedUnsupportedAgents.has(agent)) {
            warnedUnsupportedAgents.add(agent);
            ctx.logger.warn('mcp-manager: on-demand MCP tools require native presentation; keeping the full MCP tool surface for a code/both agent');
          }
          return assembled;
        }
        unsupportedAgents.delete(agent);
        return { ...assembled, tools: assembled.tools.filter((tool) => !isMcpToolName(tool.name)) };
      }, { prepend: true, global: true }));
    } catch (error) {
      for (const dispose of disposers.reverse()) { try { dispose(); } catch {} }
      throw error;
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      approvedParents.clear();
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try { disposers[index](); } catch {}
      }
    };
  }

  function setOnDemandToolInjection(enabled) {
    if (enabled === state.onDemandToolInjection) return;
    const previous = state.onDemandToolInjection;
    let installed = null;
    if (enabled) installed = installBrokerRuntime();
    state.onDemandToolInjection = enabled;
    try {
      saveState(state);
    } catch (error) {
      state.onDemandToolInjection = previous;
      installed?.();
      throw error;
    }
    if (enabled) brokerRuntimeDispose = installed;
    else {
      brokerRuntimeDispose?.();
      brokerRuntimeDispose = null;
    }
  }

  if (state.onDemandToolInjection) brokerRuntimeDispose = installBrokerRuntime();

  // ---------- stdio transport (JSON-RPC over stdin/stdout, newline-delimited) ----------
  function spawnStdio(server, onNotification) {
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
        } else if (msg.id == null && typeof msg.method === 'string') {
          try { onNotification?.(msg); } catch {}
        }
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

  // Build one tool definition from a tools/list entry. Shared by the global
  // (profile) tier and the per-workspace (scoped) tier. callFn(toolName, args)
  // resolves to the raw tools/call result.
  function makeToolDefinition(server, tool, callFn) {
    const images = mcpImageProjectionHandlers(ctx, tool.name);
    return {
      name: publicName(server.name, tool.name),
      mcpServerName: server.name,
      mcpRawName: tool.name,
      description: `${tool.description ?? ''} [${server.name} MCP]`.slice(0, 2000),
      parameters: convParams(tool.inputSchema),
      output: { schema: MCP_RESULT_SCHEMA, render: textRender },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const r = await callFn(tool.name, args ?? {});
        const content = Array.isArray(r?.content) ? r.content : [];
        const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
        if (r?.isError === true) throw new Error(text || `MCP tool "${tool.name}" failed`);
        const value = { text, content, isError: false };
        await images.prepare(value, exec, args);
        return value;
      },
      finalizeContent: images.finalizeContent,
    };
  }

  function registrationSignature(definition) {
    return JSON.stringify({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    });
  }

  function disposeRegistrations(registrations) {
    for (const entry of registrations.values()) { try { entry.dispose(); } catch {} }
    registrations.clear();
  }

  // Preserve registrations whose model-facing schema did not change. Besides
  // keeping prompt caches stable, this avoids transiently removing unrelated
  // tools when a server emits notifications/tools/list_changed.
  function syncToolRegistrations(toolsRegistry, server, registrations, tools, callFn) {
    const desired = new Map();
    const publicNames = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error(`MCP server "${server.name}" returned a tool without a name`);
      if (desired.has(tool.name)) throw new Error(`MCP server "${server.name}" returned duplicate tool "${tool.name}"`);
      const definition = makeToolDefinition(server, tool, callFn);
      if (publicNames.has(definition.name)) throw new Error(`MCP server "${server.name}" returned tools that normalize to duplicate name "${definition.name}"`);
      publicNames.add(definition.name);
      desired.set(tool.name, { definition, signature: registrationSignature(definition) });
    }

    const previous = new Map();
    for (const [rawName, current] of registrations) {
      const next = desired.get(rawName);
      if (next && next.signature === current.signature) continue;
      previous.set(rawName, current);
      try { current.dispose(); } catch {}
      registrations.delete(rawName);
    }

    const added = [];
    try {
      for (const [rawName, next] of desired) {
        if (registrations.has(rawName)) continue;
        const entry = { ...next, dispose: toolsRegistry.register(next.definition) };
        registrations.set(rawName, entry);
        added.push(rawName);
      }
    } catch (error) {
      for (const rawName of added) {
        const entry = registrations.get(rawName);
        try { entry?.dispose(); } catch {}
        registrations.delete(rawName);
      }
      const restoreFailures = [];
      for (const [rawName, entry] of previous) {
        try {
          entry.dispose = toolsRegistry.register(entry.definition);
          registrations.set(rawName, entry);
        } catch (restoreError) {
          restoreFailures.push(`${rawName}: ${restoreError?.message ?? restoreError}`);
        }
      }
      if (restoreFailures.length > 0) {
        throw new Error(`${error?.message ?? error}; rollback failed for ${restoreFailures.join(', ')}`);
      }
      throw error;
    }
    return [...desired.values()].map((entry) => entry.definition.name);
  }

  // Register a connected server's tools into the GLOBAL (profile-level) registry.
  function registerToolsGlobal(server, conn, tools) {
    const call = (name, args) => {
      if (!conn.handle) return Promise.reject(new Error(`MCP server "${server.name}" is not connected`));
      return conn.handle.call(name, args);
    };
    const names = syncToolRegistrations(ctx.tools, server, conn.tools, tools, call);
    conn.toolCount = tools.length;
    conn.status = 'connected';
    conn.error = '';
    setGlobalTools(server.name, names);
    ctx.logger.info(`mcp-manager: ${server.name} connected, ${tools.length} tools`);
  }

  // Track the exact global tool names owned by one global server so workspace
  // `exclude` masking can deny them (restrict() accepts only known global names).
  function setGlobalTools(serverName, names) {
    const set = new Set(names);
    const previous = globalToolsByServer.get(serverName);
    if (previous && previous.size === set.size && [...set].every((name) => previous.has(name))) return;
    if (set.size > 0) globalToolsByServer.set(serverName, set);
    else globalToolsByServer.delete(serverName);
    reconcileRestrictions(serverName);
  }

  function clearGlobalTools(serverName) {
    if (!globalToolsByServer.has(serverName)) return;
    globalToolsByServer.delete(serverName);
    reconcileRestrictions(serverName);
  }

  async function listAllTools(handle) {
    const tools = [];
    const seenCursors = new Set();
    let cursor;
    do {
      const listed = await handle.listTools(cursor);
      if (!Array.isArray(listed?.tools)) throw new Error('MCP tools/list returned no tools array');
      tools.push(...listed.tools);
      const next = typeof listed.nextCursor === 'string' && listed.nextCursor ? listed.nextCursor : undefined;
      if (next && seenCursors.has(next)) throw new Error(`MCP tools/list repeated cursor "${next}"`);
      if (next) seenCursors.add(next);
      cursor = next;
    } while (cursor !== undefined);
    return tools;
  }

  // Establish an HTTP transport: initialize, fetch tools/list, and return a
  // handle that both the global and the workspace tiers can register from.
  async function openHttp(server) {
    const handle = {
      kind: 'http', sessionId: null, transport: null, tools: [], closed: false,
      onNotification: null, notificationStarted: false, notificationController: null,
      call: () => Promise.reject(new Error('not connected')),
      listTools: () => Promise.reject(new Error('not connected')),
      startNotifications: () => {},
      close() {
        handle.closed = true;
        handle.notificationController?.abort();
      },
    };
    const initId = rpcSeq++;
    const initPayload = { jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.6.0' } } };
    let resp = await httpPostJson(server.url, authHeaders(server, handle), initPayload);
    if (resp.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
      resp = await httpPostJson(server.url, authHeaders(server, handle), initPayload);
    }
    if (resp.status === 401) throw new Error('authentication required');
    if (resp.status >= 400) throw new Error(`initialize HTTP ${resp.status}: ${String(resp.text).slice(0, 200)}`);
    const init = parseRpc(resp, initId, handle);
    if (!init || init.error) throw new Error(`initialize failed: ${String(resp.text).slice(0, 200)}`);
    const sid = resp.headers?.get?.('mcp-session-id');
    handle.sessionId = sid ?? null;
    await mcpRpc(server, 'notifications/initialized', undefined, handle, { isNotification: true }).catch(() => {});
    handle.listTools = (cursor) => mcpRpc(server, 'tools/list', cursor === undefined ? {} : { cursor }, handle);
    handle.tools = await listAllTools(handle);
    handle.call = (name, args) => mcpRpc(server, 'tools/call', { name, arguments: args }, handle);
    if (init.result?.capabilities?.tools?.listChanged === true) {
      handle.startNotifications = () => startHttpNotificationStream(server, handle);
    }
    return handle;
  }

  // Establish a stdio transport (spawns the child) and fetch tools/list.
  async function openStdio(server) {
    const handle = {
      kind: 'stdio', sessionId: null, transport: null, tools: [], closed: false,
      onNotification: null,
      call: () => Promise.reject(new Error('not connected')),
      listTools: () => Promise.reject(new Error('not connected')),
      startNotifications: () => {},
      close() {
        if (handle.closed) return;
        handle.closed = true;
        handle.transport?.close();
      },
    };
    const transport = spawnStdio(server, (message) => handle.onNotification?.(message));
    handle.transport = transport;
    try {
      await transport.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.6.0' } });
      transport.notify('notifications/initialized');
      handle.listTools = (cursor) => transport.request('tools/list', cursor === undefined ? {} : { cursor });
      handle.tools = await listAllTools(handle);
      handle.call = (name, args) => transport.request('tools/call', { name, arguments: args });
      return handle;
    } catch (error) {
      handle.close();
      throw error;
    }
  }

  async function openServer(server) {
    if ((server.type ?? 'http') === 'stdio') return openStdio(server);
    return openHttp(server);
  }

  async function connect(server) {
    const conn = setLive(server.id, { status: 'connecting', error: '' });
    conn.name = server.name;
    try {
      // Reap any previous transport (a prior stdio child) before respawning.
      try { conn.handle?.close?.(); } catch {}
      const handle = await openServer(server);
      conn.handle = handle;
      conn.sessionId = handle.sessionId;
      conn.transport = handle.transport;
      registerToolsGlobal(server, conn, handle.tools);
      bindToolsChanged(server, handle, async () => {
        const tools = await listAllTools(handle);
        if (conn.handle !== handle || handle.closed) return;
        handle.tools = tools;
        registerToolsGlobal(server, conn, handle.tools);
      });
    } catch (error) {
      disposeRegistrations(conn.tools);
      conn.toolCount = 0;
      try { conn.handle?.close?.(); } catch {}
      conn.handle = null;
      conn.transport = null;
      clearGlobalTools(server.name);
      conn.status = (server.type ?? 'http') !== 'stdio' && server.authMode === 'oauth' && !server.oauth?.tokens ? 'needs-auth' : 'error';
      conn.error = String(error?.message ?? error).slice(0, 300);
      ctx.logger.warn(`mcp-manager: ${server.name} ${conn.status}: ${conn.error}`);
    }
    return conn;
  }

  function disconnect(serverId) {
    const conn = live.get(serverId);
    if (!conn) return;
    disposeRegistrations(conn.tools);
    try { conn.handle?.close?.(); } catch {}
    live.delete(serverId);
    if (conn.name) clearGlobalTools(conn.name);
  }

  // ---------- workspace (per-workspace) MCP isolation ----------

  function wsConfigPath(cwd) {
    return join(cwd, WORKSPACE_CONFIG_REL);
  }

  function canonicalize(cwd) {
    try { return realpathSync(cwd); } catch { return cwd; }
  }

  function knownWorkspacePath(path) {
    if (!isAbsolute(path)) return null;
    let canonical;
    try { canonical = realpathSync(path); } catch { return null; }
    if (workspaces.has(canonical)) return canonical;
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return null;
    return registry.list().some((ws) => typeof ws?.path === 'string' && canonicalize(ws.path) === canonical) ? canonical : null;
  }

  // Stable, deterministic server id derived from (canonical workspace, name) so
  // an OAuth callback can re-locate the server across config rescans.
  function workspaceServerId(wsPath, name) {
    return `ws-${createHash('sha256').update(`${wsPath}\n${name}`).digest('hex').slice(0, 20)}`;
  }

  function workspaceTokenKey(wsPath, name) {
    return `${wsPath}\n${name}`;
  }

  // Persist OAuth client registration + tokens for one server, routing to the
  // global state or the per-workspace token slot depending on where it lives.
  function persistServer(server) {
    if (server.wsPath) {
      const key = workspaceTokenKey(server.wsPath, server.name);
      if (server.oauth) state.workspaceTokens[key] = { oauth: server.oauth };
      else delete state.workspaceTokens[key];
    }
    saveState(state);
  }

  // Set a server's auth/connection status in whichever tier it belongs to.
  function setServerAuthStatus(server, status, error = '') {
    if (server.wsPath) {
      const ws = workspaces.get(server.wsPath);
      const wc = ws?.servers.get(server.name);
      if (wc) { wc.status = status; wc.error = error; }
    } else {
      setLive(server.id, { status, error });
    }
  }

  // Resolve a server by its (globally unique) id across both tiers.
  function findServerById(id) {
    const g = state.servers.find((s) => s.id === id);
    if (g) return { server: g, wsPath: null, wsConn: null };
    for (const [wsPath, ws] of workspaces) {
      for (const wc of ws.servers.values()) {
        if (wc.server.id === id) return { server: wc.server, wsPath, wsConn: wc };
      }
    }
    return null;
  }

  function normalizeWorkspaceServer(name, cfg, cwd) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(name)) return null;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null;
    const type = cfg.type === 'stdio' ? 'stdio' : 'http';
    if (type === 'stdio') {
      const command = String(cfg.command ?? '').trim();
      if (!command) return null;
      const server = { id: `ws-${b64url(randomBytes(8))}`, name, type: 'stdio', command, args: parseArgs(cfg.args), env: parseEnv(cfg.env) };
      const wcwd = String(cfg.cwd ?? '').trim();
      server.cwd = wcwd || cwd;
      return server;
    }
    const url = String(cfg.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) return null;
    const authMode = cfg.authMode === 'static' ? 'static' : 'oauth';
    const server = { id: `ws-${b64url(randomBytes(8))}`, name, type: 'http', url, authMode, headers: parseEnv(cfg.headers), headerEnv: parseEnv(cfg.headerEnv) };
    if (authMode === 'static') server.tokenEnv = String(cfg.tokenEnv ?? '').trim();
    return server;
  }

  function readWorkspaceConfig(cwd) {
    try {
      const raw = JSON.parse(readFileSync(wsConfigPath(cwd), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root must be a JSON object');
      const mcpServers = raw?.mcpServers;
      const servers = [];
      if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
        for (const [name, cfg] of Object.entries(mcpServers)) {
          const server = normalizeWorkspaceServer(name, cfg, cwd);
          if (server) servers.push(server);
        }
      }
      const exclude = Array.isArray(raw?.exclude) ? raw.exclude.filter((x) => typeof x === 'string') : [];
      return { servers, exclude, error: '' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { servers: [], exclude: [], error: '' };
      return { servers: [], exclude: [], error: `invalid ${WORKSPACE_CONFIG_REL}: ${error?.message ?? error}` };
    }
  }

  // Read/write the raw workspace config object (preserving mcpServers entries).
  function readWorkspaceRaw(cwd) {
    try {
      const raw = JSON.parse(readFileSync(wsConfigPath(cwd), 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root must be a JSON object');
      return raw;
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new Error(`invalid ${WORKSPACE_CONFIG_REL}: ${error?.message ?? error}`);
    }
  }

  function writeWorkspaceRaw(cwd, raw) {
    mkdirSync(dirname(wsConfigPath(cwd)), { recursive: true });
    writeFileSync(wsConfigPath(cwd), JSON.stringify(raw, null, 2) + '\n');
  }

  // Normalize + validate a flat server payload (from the Settings form) into a
  // Claude/Codex-style `mcpServers[name]` entry. Returns { name, entry } or { error }.
  function buildWorkspaceEntry(body) {
    const name = String(body?.name ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return { error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)' };
    const type = body?.type === 'stdio' ? 'stdio' : 'http';
    const entry = { type };
    if (type === 'stdio') {
      const command = String(body?.command ?? '').trim();
      if (!command) return { error: 'stdio server requires a command (executable, e.g. npx / uvx / python)' };
      entry.command = command;
      entry.args = parseArgs(body?.args);
      entry.env = parseEnv(body?.env);
      const cwd = String(body?.cwd ?? '').trim();
      if (cwd) entry.cwd = cwd;
    } else {
      const url = String(body?.url ?? '').trim();
      if (!/^https?:\/\//.test(url)) return { error: 'url must be an http(s) URL' };
      entry.url = url;
      entry.authMode = body?.authMode === 'static' ? 'static' : 'oauth';
      entry.headers = parseEnv(body?.headers);
      entry.headerEnv = parseEnv(body?.headerEnv);
      if (entry.authMode === 'static') entry.tokenEnv = String(body?.tokenEnv ?? '').trim();
    }
    return { name, entry };
  }

  function sameServerConfig(a, b) {
    const norm = (s) => JSON.stringify({
      type: s.type ?? 'http',
      url: s.url ?? '',
      authMode: s.authMode ?? '',
      tokenEnv: s.tokenEnv ?? '',
      headers: s.headers ?? {},
      headerEnv: s.headerEnv ?? {},
      command: s.command ?? '',
      args: s.args ?? [],
      env: s.env ?? {},
      cwd: s.cwd ?? '',
    });
    return norm(a) === norm(b);
  }

  // A server name is globally unique across the global tier and every workspace.
  function serverNameTaken(name, exceptWsPath) {
    if (state.servers.some((s) => s.name === name)) return true;
    for (const [path, other] of workspaces) {
      if (path === exceptWsPath) continue;
      for (const otherName of other.servers.keys()) if (otherName === name) return true;
    }
    return false;
  }

  function openWorkspaceServer(server) {
    const wsConn = { server, handle: null, status: 'connecting', error: '', toolCount: 0, tools: [], call: () => Promise.reject(new Error('not connected')) };
    if ((server.type ?? 'http') !== 'stdio' && !hasToken(server)) {
      wsConn.status = 'needs-auth';
      wsConn.error = server.authMode === 'static' ? 'missing token (set the env var)' : '';
      return wsConn;
    }
    return openWorkspaceServerInner(server, wsConn);
  }

  async function openWorkspaceServerInner(server, wsConn) {
    try {
      const handle = await openServer(server);
      wsConn.handle = handle;
      wsConn.tools = handle.tools ?? [];
      wsConn.toolCount = wsConn.tools.length;
      wsConn.status = 'connected';
      wsConn.error = '';
      wsConn.call = (name, args) => handle.call(name, args);
      bindToolsChanged(server, handle, async () => {
        const tools = await listAllTools(handle);
        if (wsConn.handle !== handle || handle.closed) return;
        wsConn.tools = tools;
        wsConn.toolCount = wsConn.tools.length;
        const ws = workspaces.get(server.wsPath);
        if (ws?.servers.get(server.name) !== wsConn) return;
        for (const agent of ws.agents) rebuildAgentWorkspace(agent, server.wsPath);
      });
    } catch (error) {
      wsConn.status = 'error';
      wsConn.error = String(error?.message ?? error).slice(0, 300);
      ctx.logger.warn(`mcp-manager: workspace server ${server.name} ${wsConn.status}: ${wsConn.error}`);
    }
    return wsConn;
  }

  function closeWorkspaceServer(wsConn) {
    try { wsConn.handle?.close?.(); } catch {}
    wsConn.handle = null;
    wsConn.call = () => Promise.reject(new Error('not connected'));
  }

  function registerWorkspaceTools(agent, wsPath, server, wsConn, registrations) {
    const call = (name, args) => {
      const current = workspaces.get(wsPath)?.servers.get(server.name);
      if (!current || current.status !== 'connected') return Promise.reject(new Error(`workspace MCP server "${server.name}" is not connected`));
      return current.call(name, args);
    };
    syncToolRegistrations(agent.ctx.tools, server, registrations, wsConn.tools, call);
  }

  function disposeAgentScope(st) {
    for (const registrations of st.disposers.values()) disposeRegistrations(registrations);
    st.disposers.clear();
    if (st.restrictDisposer) { try { st.restrictDisposer(); } catch {} st.restrictDisposer = undefined; }
    st.restrictKey = undefined;
  }

  function reconcileRestrictForAgent(agent, ws, st) {
    const deny = [];
    for (const serverName of ws.exclude ?? []) {
      const tools = globalToolsByServer.get(serverName);
      if (tools) for (const t of tools) deny.push(t);
    }
    deny.sort();
    const restrictKey = JSON.stringify(deny);
    if (st.restrictKey === restrictKey) return;
    if (st.restrictDisposer) { try { st.restrictDisposer(); } catch {} st.restrictDisposer = undefined; }
    st.restrictKey = restrictKey;
    if (deny.length === 0) return;
    try {
      st.restrictDisposer = agent.ctx.tools.restrict({ deny });
    } catch (error) {
      ctx.logger.warn(`mcp-manager: restrict(${deny.join(', ')}) failed: ${error?.message ?? error}`);
    }
  }

  // Re-evaluate every live agent's mask after a global tool-set change or an
  // `exclude` edit. `_serverName` is informational (which global server changed).
  function reconcileRestrictions(_serverName) {
    for (const [agent, st] of agentScopeState) {
      const ws = workspaces.get(st.wsPath);
      if (!ws) continue;
      reconcileRestrictForAgent(agent, ws, st);
    }
  }

  function rebuildAgentWorkspace(agent, wsPath) {
    const ws = workspaces.get(wsPath);
    let st = agentScopeState.get(agent);
    if (st && st.wsPath !== wsPath) {
      disposeAgentScope(st);
      agentScopeState.delete(agent);
      st = undefined;
    }
    if (!ws) {
      if (st) { disposeAgentScope(st); agentScopeState.delete(agent); }
      return;
    }
    if (!st) {
      st = { wsPath, disposers: new Map(), restrictDisposer: undefined, restrictKey: undefined };
      agentScopeState.set(agent, st);
    }
    const connected = new Set([...ws.servers].filter(([, wc]) => wc.status === 'connected').map(([name]) => name));
    for (const [name, registrations] of st.disposers) {
      if (connected.has(name)) continue;
      disposeRegistrations(registrations);
      st.disposers.delete(name);
    }
    for (const [name, wc] of ws.servers) {
      if (wc.status !== 'connected') continue;
      try {
        let registrations = st.disposers.get(name);
        if (!registrations) st.disposers.set(name, registrations = new Map());
        registerWorkspaceTools(agent, wsPath, wc.server, wc, registrations);
      } catch (error) {
        ctx.logger.warn(`mcp-manager: registering workspace server "${name}" tools failed: ${error?.message ?? error}`);
      }
    }
    reconcileRestrictForAgent(agent, ws, st);
  }

  function releaseWorkspace(wsPath, agent) {
    const st = agentScopeState.get(agent);
    if (st) { disposeAgentScope(st); agentScopeState.delete(agent); }
    const ws = workspaces.get(wsPath);
    if (!ws) return;
    ws.agents.delete(agent);
    if (ws.agents.size === 0) {
      for (const wc of ws.servers.values()) closeWorkspaceServer(wc);
      ws.servers.clear();
      closeWorkspaceWatchers(ws);
      if (ws.watchTimer) clearTimeout(ws.watchTimer);
      ws.watchTimer = null;
      workspaces.delete(wsPath);
      workspaceRescans.delete(wsPath);
    }
  }

  function ensureWorkspace(wsPath, rawPath) {
    let ws = workspaces.get(wsPath);
    if (ws) return ws;
    ws = { path: wsPath, rawPath, servers: new Map(), agents: new Set(), exclude: [], watchStop: null, watchTimer: null, error: '' };
    workspaces.set(wsPath, ws);
    return ws;
  }

  function rescanWorkspace(wsPath) {
    const prev = workspaceRescans.get(wsPath) ?? Promise.resolve();
    const next = prev.then(() => doRescan(wsPath), () => doRescan(wsPath));
    workspaceRescans.set(wsPath, next.then(() => {}, () => {}));
    return next;
  }

  function closeWorkspaceWatchers(ws) {
    if (!ws.watchStop) return;
    try { ws.watchStop(); } catch {}
    ws.watchStop = null;
  }

  function ensureWorkspaceWatchers(wsPath, ws) {
    if (ws.watchStop) return;
    const root = ws.rawPath ?? ws.path;
    const configPath = wsConfigPath(root);
    const onChange = (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs && current.size === previous.size) return;
      if (ws.watchTimer) clearTimeout(ws.watchTimer);
      ws.watchTimer = setTimeout(() => {
        ws.watchTimer = null;
        void rescanWorkspace(wsPath).catch((error) => {
          ctx.logger.warn(`mcp-manager: workspace rescan failed for ${root}: ${error?.message ?? error}`);
        });
      }, 300);
    };
    try {
      watchFile(configPath, { interval: 250 }, onChange);
      ws.watchStop = () => unwatchFile(configPath, onChange);
    } catch (error) {
      ctx.logger.warn(`mcp-manager: cannot watch workspace config ${configPath}: ${error?.message ?? error}`);
    }
  }

  async function doRescan(wsPath) {
    const ws = workspaces.get(wsPath);
    if (!ws) return;
    ensureWorkspaceWatchers(wsPath, ws);
    const cfg = readWorkspaceConfig(ws.rawPath ?? ws.path);
    if (cfg.error) {
      ws.error = cfg.error;
      return;
    }
    for (const srv of cfg.servers) {
      srv.id = workspaceServerId(wsPath, srv.name);
      srv.wsPath = wsPath;
      const oauth = state.workspaceTokens?.[workspaceTokenKey(wsPath, srv.name)]?.oauth;
      if (oauth) srv.oauth = oauth;
    }
    const errorChanged = ws.error !== '';
    ws.error = '';
    const excludeChanged = JSON.stringify([...(ws.exclude ?? [])].sort()) !== JSON.stringify([...(cfg.exclude ?? [])].sort());
    ws.exclude = cfg.exclude;
    let changed = excludeChanged || errorChanged;
    const desired = new Map();
    for (const srv of cfg.servers) {
      desired.set(srv.name, { conflict: serverNameTaken(srv.name, wsPath), server: srv });
    }
    let tokensDropped = false;
    for (const [name, wc] of ws.servers) {
      if (!desired.has(name)) {
        closeWorkspaceServer(wc);
        ws.servers.delete(name);
        const key = workspaceTokenKey(wsPath, name);
        if (state.workspaceTokens[key]) { delete state.workspaceTokens[key]; tokensDropped = true; }
        changed = true;
      }
    }
    if (tokensDropped) saveState(state);
    for (const [name, entry] of desired) {
      const existing = ws.servers.get(name);
      if (entry.conflict) {
        if (!existing || existing.status !== 'conflict') {
          if (existing) closeWorkspaceServer(existing);
          ws.servers.set(name, {
            server: entry.server, handle: null, status: 'conflict',
            error: `server name "${name}" is already used by another source`,
            toolCount: 0, tools: [], call: () => Promise.reject(new Error('conflict')),
          });
          changed = true;
        }
        continue;
      }
      if (existing && existing.status !== 'conflict' && sameServerConfig(existing.server, entry.server)) continue;
      if (existing) closeWorkspaceServer(existing);
      const wc = await openWorkspaceServer(entry.server);
      ws.servers.set(name, wc);
      changed = true;
    }
    if (changed) {
      for (const agent of ws.agents) rebuildAgentWorkspace(agent, wsPath);
      reconcileRestrictions();
    }
  }

  // Project one workspace server (live wsConn or on-disk config) into the view
  // shape the settings UI needs, including the transport fields for the editor.
  function workspaceServerView(server, status, toolCount, error) {
    const v = {
      id: server.id,
      name: server.name,
      type: server.type ?? 'http',
      authMode: server.authMode ?? '',
      source: 'workspace',
      status,
      toolCount,
      error,
    };
    if (v.type === 'stdio') {
      v.command = server.command;
      v.args = server.args ?? [];
      v.env = server.env ?? {};
      v.cwd = server.cwd ?? '';
    } else {
      v.url = server.url;
      v.headers = server.headers ?? {};
      v.headerEnv = server.headerEnv ?? {};
      if (v.authMode === 'static') v.tokenEnv = server.tokenEnv ?? '';
    }
    return v;
  }

  function workspaceView(ws) {
    return {
      path: ws.rawPath ?? ws.path,
      servers: [...ws.servers.values()].map((wc) => workspaceServerView(wc.server, wc.status, wc.toolCount, wc.error)),
      exclude: ws.exclude ?? [],
      error: ws.error ?? '',
    };
  }

  // Enumerate discovered workspaces for the settings UI: every registered
  // workspace (web) plus every directory an agent has actually opened.
  function listWorkspaces() {
    const discovered = [];
    const seen = new Set([...workspaces.values()].map((w) => w.rawPath ?? w.path));
    const registry = ctx.get('workspaceRegistry');
    if (registry && typeof registry.list === 'function') {
      for (const ws of registry.list()) {
        const path = ws?.path;
        if (typeof path === 'string' && path.length > 0) seen.add(path);
      }
    }
    for (const path of seen) {
      const canonical = canonicalize(path);
      const existing = workspaces.get(canonical);
      if (existing) {
        discovered.push(workspaceView(existing));
      } else {
        // Not yet loaded: reflect the on-disk config without connecting.
        const cfg = readWorkspaceConfig(path);
        discovered.push({
          path,
          servers: cfg.servers.map((s) => workspaceServerView(s, 'configured', 0, '')),
          exclude: cfg.exclude,
          error: cfg.error,
        });
      }
    }
    return discovered;
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

  // ---------- agent-creation decoration (per-agent workspace scoping) ----------

  // Cordis exposes the raw provider target behind its traceable proxy via this
  // process-global symbol (Symbol.for), so we can install a reversible method
  // wrapper without importing @deepseek-ai/cordis.
  const ORIGINAL = Symbol.for('cordis.original');

  function getPropertyDescriptor(target, prop) {
    let proto = target;
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc) return desc;
      proto = Object.getPrototypeOf(proto);
    }
    return undefined;
  }

  function installMethodWrapper(value, method, wrap) {
    const target = value?.[ORIGINAL] ?? value;
    const before = getPropertyDescriptor(target, method);
    if (!before || typeof before.value !== 'function') {
      throw new TypeError(`mcp-manager: cannot wrap non-function method ${String(method)}`);
    }
    const original = before.value;
    const hadOwn = Object.prototype.hasOwnProperty.call(target, method);
    const installed = function (...args) { return wrap(original, this, args); };
    Object.defineProperty(target, method, {
      value: installed,
      writable: true,
      configurable: true,
      enumerable: before.enumerable ?? false,
    });
    let disposed = false;
    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        if (target[method] !== installed) return;
        if (hadOwn) Object.defineProperty(target, method, before);
        else delete target[method];
      },
    };
  }

  // Compose the caller's agent setup with workspace scoping. Best-effort: a
  // missing/invalid cwd or any scoping failure degrades to "global tools only"
  // and never rejects agent creation.
  function composeAgentSetup(callerSetup) {
    return async (agentCtx) => {
      const agent = agentCtx.agent;
      let wsPath = null;
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0 && isAbsolute(cwd)) {
        try {
          wsPath = canonicalize(cwd);
          const ws = ensureWorkspace(wsPath, cwd);
          await rescanWorkspace(wsPath);
          ws.agents.add(agent);
          agentScopeState.set(agent, { wsPath, disposers: new Map(), restrictDisposer: undefined, restrictKey: undefined });
          rebuildAgentWorkspace(agent, wsPath);
        } catch (error) {
          ctx.logger.warn(`mcp-manager: workspace scoping failed for ${cwd}: ${error?.message ?? error}`);
          wsPath = null;
        }
      }
      if (wsPath) {
        agentCtx.effect(() => () => { releaseWorkspace(wsPath, agent); }, 'mcp-workspace-release');
      }
      return (await callerSetup?.(agentCtx)) ?? undefined;
    };
  }

  function installAgentDecorators(agents) {
    const wrapCreate = (original, thisArg, args) => {
      const options = args[0];
      if (!options || typeof options !== 'object') throw new TypeError('mcp-manager: agents.create() requires options');
      return original.call(thisArg, { ...options, setup: composeAgentSetup(options.setup) });
    };
    const wrapResume = (original, thisArg, args) => {
      const options = args[0];
      if (!options || typeof options !== 'object') throw new TypeError('mcp-manager: agents.resume() requires options');
      return original.call(thisArg, { ...options, setup: composeAgentSetup(options.setup) });
    };
    const h1 = installMethodWrapper(agents, 'create', wrapCreate);
    const h2 = installMethodWrapper(agents, 'resume', wrapResume);
    return () => { h2.dispose(); h1.dispose(); };
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
          const found = findServerById(cbMatch[1]);
          const server = found?.server;
          const code = url.searchParams.get('code');
          const flowState = url.searchParams.get('state');
          const oauthError = url.searchParams.get('error');
          const done = (ok, message) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:40px"><h2>${ok ? '✅ Authorized' : '❌ Authorization failed'}</h2><p>${message}</p><p><a href="/">Back to DSH</a></p></body>`);
          };
          if (!server) return done(false, 'No MCP server config matches this callback');
          if (oauthError) { setServerAuthStatus(server, 'needs-auth', oauthError); return done(false, `Server returned: ${oauthError}`); }
          if (!code || pending.get(server.id)?.state !== flowState) { setServerAuthStatus(server, 'needs-auth', 'session expired'); return done(false, 'Authorization session expired or invalid — start again from Settings → MCP'); }
          try {
            await exchangeCode(server, code, origin);
            if (found.wsPath) {
              // Reconnect the workspace server in place and re-register its tools
              // into every live agent in that workspace.
              const ws = workspaces.get(found.wsPath);
              if (ws && found.wsConn) {
                closeWorkspaceServer(found.wsConn);
                const fresh = await openWorkspaceServer(server);
                ws.servers.set(server.name, fresh);
                for (const agent of ws.agents) rebuildAgentWorkspace(agent, found.wsPath);
              }
              const wc = ws?.servers.get(server.name);
              return done(true, `Connected to ${server.name}${wc && wc.status === 'connected' ? `; ${wc.toolCount} tools registered` : ''}. You can close this page.`);
            }
            const conn = await connect(server);
            return done(true, `Connected to ${server.name}; ${conn.toolCount} tools registered. You can close this page.`);
          } catch (error) {
            setServerAuthStatus(server, 'error', String(error?.message ?? error).slice(0, 300));
            return done(false, `Token exchange failed: ${error?.message ?? error}`);
          }
        }

        // JSON API: /mcp-manager/api/...
        if (!path.startsWith(API_PREFIX)) { res.writeHead(404); res.end(); return; }
        const rest = path.slice(API_PREFIX.length);
        const idMatch = rest.match(/^\/servers\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/);

        if (req.method === 'GET' && rest === '/ping') {
          return json(res, 200, { ok: true, version: 4, stdio: true, workspace: true, onDemandTools: true });
        }
        if (req.method === 'GET' && rest === '/settings') {
          return json(res, 200, { onDemandToolInjection: state.onDemandToolInjection });
        }
        if (req.method === 'POST' && rest === '/settings/on-demand') {
          const body = await readBody(req);
          if (typeof body.enabled !== 'boolean') return json(res, 400, { error: 'enabled must be a boolean' });
          setOnDemandToolInjection(body.enabled);
          return json(res, 200, { onDemandToolInjection: state.onDemandToolInjection });
        }
        if (req.method === 'GET' && rest === '/workspaces') {
          return json(res, 200, { workspaces: listWorkspaces() });
        }
        if (req.method === 'POST' && rest === '/workspaces/auth') {
          const body = await readBody(req);
          const path = String(body.path ?? '').trim();
          const name = String(body.name ?? '').trim();
          if (!path || !name) return json(res, 400, { error: 'path and name are required' });
          const canonical = knownWorkspacePath(path);
          if (!canonical) return json(res, 403, { error: 'path is not a registered or active DSH workspace' });
          const ws = workspaces.get(canonical);
          const wc = ws?.servers.get(name);
          if (!wc) return json(res, 404, { error: `workspace server "${name}" not found in ${path}` });
          if ((wc.server.type ?? 'http') !== 'http' || wc.server.authMode !== 'oauth') return json(res, 400, { error: 'only HTTP OAuth workspace servers need authorization' });
          const authorizeUrl = await startAuth(wc.server, origin);
          return json(res, 200, { authorizeUrl });
        }
        if (req.method === 'POST' && rest === '/workspaces/exclude') {
          const body = await readBody(req);
          const path = String(body.path ?? '').trim();
          const server = String(body.server ?? '').trim();
          const exclude = body.exclude === true;
          if (!path) return json(res, 400, { error: 'path is required' });
          if (!state.servers.some((s) => s.name === server)) return json(res, 400, { error: `unknown global server "${server}"` });
          const canonical = knownWorkspacePath(path);
          if (!canonical) return json(res, 403, { error: 'path is not a registered or active DSH workspace' });
          const raw = readWorkspaceRaw(canonical);
          let list = (Array.isArray(raw.exclude) ? raw.exclude : []).filter((x) => typeof x === 'string' && x !== server);
          if (exclude) list.push(server);
          raw.exclude = [...new Set(list)];
          writeWorkspaceRaw(canonical, raw);
          const ws = workspaces.get(canonical);
          if (ws) await rescanWorkspace(canonical);
          return json(res, 200, { workspaces: listWorkspaces() });
        }
        if (req.method === 'POST' && rest === '/workspaces/servers') {
          const body = await readBody(req);
          const path = String(body.path ?? '').trim();
          if (!path) return json(res, 400, { error: 'path is required' });
          const { name, entry, error } = buildWorkspaceEntry(body);
          if (error) return json(res, 400, { error });
          const canonical = knownWorkspacePath(path);
          if (!canonical) return json(res, 403, { error: 'path is not a registered or active DSH workspace' });
          const raw = readWorkspaceRaw(canonical);
          if (raw.mcpServers && typeof raw.mcpServers === 'object' && name in raw.mcpServers) {
            return json(res, 409, { error: `a server named ${name} already exists in this workspace` });
          }
          if (serverNameTaken(name, canonical)) return json(res, 409, { error: `a server named ${name} already exists (global or in another workspace)` });
          raw.mcpServers = raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers) ? raw.mcpServers : {};
          raw.mcpServers[name] = entry;
          writeWorkspaceRaw(canonical, raw);
          const ws = workspaces.get(canonical);
          if (ws) await rescanWorkspace(canonical);
          return json(res, 200, { workspaces: listWorkspaces() });
        }
        if (req.method === 'PUT' && rest === '/workspaces/servers') {
          const body = await readBody(req);
          const path = String(body.path ?? '').trim();
          const oldName = String(body.oldName ?? '').trim();
          if (!path || !oldName) return json(res, 400, { error: 'path and oldName are required' });
          const { name, entry, error } = buildWorkspaceEntry(body);
          if (error) return json(res, 400, { error });
          const canonical = knownWorkspacePath(path);
          if (!canonical) return json(res, 403, { error: 'path is not a registered or active DSH workspace' });
          const raw = readWorkspaceRaw(canonical);
          if (!raw.mcpServers || typeof raw.mcpServers !== 'object' || !(oldName in raw.mcpServers)) {
            return json(res, 404, { error: `workspace server "${oldName}" not found` });
          }
          let keepOAuth = false;
          if (name === oldName && entry.type === 'http' && entry.authMode === 'oauth') {
            const previous = normalizeWorkspaceServer(oldName, raw.mcpServers[oldName], canonical);
            if (previous?.type === 'http' && previous.authMode === 'oauth') {
              try { keepOAuth = issuerOf(previous) === issuerOf({ url: entry.url }); } catch {}
            }
          }
          if (name !== oldName) {
            if (name in raw.mcpServers) return json(res, 409, { error: `a server named ${name} already exists in this workspace` });
            if (serverNameTaken(name, canonical)) return json(res, 409, { error: `a server named ${name} already exists (global or in another workspace)` });
          }
          delete raw.mcpServers[oldName];
          raw.mcpServers[name] = entry;
          writeWorkspaceRaw(canonical, raw);
          // Preserve OAuth state only while the same named server stays on the
          // same issuer; otherwise an old token/client registration is unsafe.
          const oldKey = workspaceTokenKey(canonical, oldName);
          if (!keepOAuth && state.workspaceTokens[oldKey]) {
            delete state.workspaceTokens[oldKey];
            saveState(state);
          }
          const ws = workspaces.get(canonical);
          if (ws) await rescanWorkspace(canonical);
          return json(res, 200, { workspaces: listWorkspaces() });
        }
        if (req.method === 'POST' && rest === '/workspaces/servers/delete') {
          const body = await readBody(req);
          const path = String(body.path ?? '').trim();
          const name = String(body.name ?? '').trim();
          if (!path || !name) return json(res, 400, { error: 'path and name are required' });
          const canonical = knownWorkspacePath(path);
          if (!canonical) return json(res, 403, { error: 'path is not a registered or active DSH workspace' });
          const raw = readWorkspaceRaw(canonical);
          if (raw.mcpServers && typeof raw.mcpServers === 'object') delete raw.mcpServers[name];
          writeWorkspaceRaw(canonical, raw);
          const key = workspaceTokenKey(canonical, name);
          if (state.workspaceTokens[key]) { delete state.workspaceTokens[key]; saveState(state); }
          const ws = workspaces.get(canonical);
          if (ws) await rescanWorkspace(canonical);
          return json(res, 200, { workspaces: listWorkspaces() });
        }
        if (req.method === 'GET' && rest === '/servers') {
          return json(res, 200, { servers: state.servers.map(serverView) });
        }
        if (req.method === 'POST' && rest === '/servers') {
          const body = await readBody(req);
          const name = String(body.name ?? '').trim();
          const type = body.type === 'stdio' ? 'stdio' : 'http';
          if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) return json(res, 400, { error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)' });
          if (serverNameTaken(name)) return json(res, 409, { error: `a server named ${name} already exists (global or in a workspace)` });

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
            const previousType = server.type ?? 'http';
            const previousAuthMode = server.authMode;
            let previousIssuer = '';
            if (previousType === 'http' && previousAuthMode === 'oauth') {
              try { previousIssuer = issuerOf(server); } catch {}
            }

            // 1. 校验(先不改动 server,全部通过后再写)
            const newName = String(body.name ?? server.name).trim();
            if (!/^[A-Za-z0-9_-]{1,32}$/.test(newName)) return json(res, 400, { error: 'name must be 1-32 chars of [A-Za-z0-9_-] (it becomes the mcp__<name>__ tool prefix)' });
            if (newName !== server.name && serverNameTaken(newName)) return json(res, 409, { error: `a server named ${newName} already exists (global or in a workspace)` });

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
              delete server.url; delete server.authMode; delete server.tokenEnv; delete server.headers; delete server.headerEnv; delete server.oauth; delete server.staticToken;
            } else {
              server.url = next.url;
              server.authMode = next.authMode;
              server.headers = next.headers;
              server.headerEnv = next.headerEnv;
              if (next.authMode === 'static') {
                server.tokenEnv = next.tokenEnv;
                delete server.oauth;
                // Once an env var name is set (or kept), the legacy plaintext
                // token is obsolete — drop it.
                if (server.tokenEnv) delete server.staticToken;
              } else {
                delete server.tokenEnv;
                delete server.staticToken;
                let nextIssuer = '';
                try { nextIssuer = issuerOf(server); } catch {}
                if (previousType !== 'http' || previousAuthMode !== 'oauth' || previousIssuer !== nextIssuer) {
                  delete server.oauth;
                }
              }
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

  // Decorate agents.create/resume so every agent gets workspace-scoped MCP.
  // Injected lazily (not a hard plugin dependency): the agent registry may
  // appear after this plugin in some compositions. If it never appears,
  // workspace isolation stays off while the global tier keeps working.
  ctx.effect(() => ctx.inject(['agents'], (childCtx) => {
    const agents = childCtx.agents;
    if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function') {
      ctx.logger.warn('mcp-manager: agents registry lacks create/resume; workspace isolation disabled');
      return;
    }
    childCtx.effect(() => installAgentDecorators(agents), 'mcp-agent-decorators');
  }).dispose);

  // On plugin unload/reload, kill every live global + workspace stdio child
  // process and stop every workspace config watcher.
  ctx.effect(() => () => {
    brokerRuntimeDispose?.();
    brokerRuntimeDispose = null;
    for (const st of agentScopeState.values()) disposeAgentScope(st);
    for (const conn of live.values()) { try { conn.handle?.close?.(); } catch {} }
    for (const ws of workspaces.values()) {
      for (const wc of ws.servers.values()) closeWorkspaceServer(wc);
      closeWorkspaceWatchers(ws);
      if (ws.watchTimer) clearTimeout(ws.watchTimer);
    }
    workspaces.clear();
    agentScopeState.clear();
    workspaceRescans.clear();
    globalToolsByServer.clear();
  });

  // ---------- startup: auto-connect stdio servers and HTTP servers that have credentials ----------
  for (const server of state.servers) {
    if (server.enabled === false) continue; // disabled servers stay dormant until re-enabled
    if ((server.type ?? 'http') === 'stdio') connect(server);
    else if (hasToken(server)) connect(server);
    else setLive(server.id, { status: 'needs-auth', error: '' });
  }
}
