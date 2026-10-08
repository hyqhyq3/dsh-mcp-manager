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
/**
 * MCP protocol revision this client asks for during `initialize`. Every transport
 * sends the same value; the server may answer with a revision of its own choosing,
 * which `logNegotiatedProtocol` surfaces instead of silently diverging from it.
 */
const MCP_PROTOCOL_VERSION = '2025-03-26';

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

/**
 * Normalize an env/header payload into a flat string→string map.
 * Accepts the current object form plus the legacy `[{ name, value }]` list
 * (older plugin versions wrote that) and `[{ key, value }]`. Entries without a
 * usable name are dropped; values are coerced to strings.
 */
export function normalizeEnvPairs(value) {
  if (Array.isArray(value)) {
    const out = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const name = entry.name ?? entry.key;
      if (typeof name !== 'string' || !name) continue;
      out[name] = String(entry.value ?? '');
    }
    return out;
  }
  if (value && typeof value === 'object') return value;
  return {};
}

/**
 * One-time migration for a state file written by an older plugin version.
 * - `id`: every runtime lookup (live status, `/servers/:id/*` routes) is keyed
 *   by it. Configs from ≤0.1.x have no `id` at all, so all servers share one
 *   live-status slot (errors cross over) and every id-addressed API 404s.
 * - `env`/`headers`/`headerEnv`: legacy `[{ name, value }]` arrays are spread
 *   into the child environment as numeric keys, silently losing every value.
 * @returns whether anything changed (the caller then persists the state).
 */
export function migrateLoadedState(state, makeId = () => b64url(randomBytes(8))) {
  let changed = false;
  const ids = new Set();
  for (const server of Array.isArray(state?.servers) ? state.servers : []) {
    if (!server || typeof server !== 'object') continue;
    if (typeof server.id !== 'string' || !server.id || ids.has(server.id)) {
      server.id = makeId();
      changed = true;
    }
    ids.add(server.id);
    for (const key of ['env', 'headers', 'headerEnv']) {
      if (Array.isArray(server[key])) {
        server[key] = normalizeEnvPairs(server[key]);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Quote one command-line token for the `cmd.exe /d /s /c` line that Node builds
 * when `spawn(..., { shell: true })` runs on Windows. Node joins the command and
 * its args with plain spaces and adds no quoting, so cmd.exe truncates any token
 * containing whitespace (`C:\Program Files\...` → `C:\Program`). Quoting here is
 * idempotent: a token the user already quoted is left untouched.
 */
export function quoteWindowsToken(token) {
  const text = String(token);
  if (text === '') return '""';
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"') && !text.slice(1, -1).includes('"')) return text;
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
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

// Concurrency classification for MCP tools (see the block above makeToolDefinition).
// Exported so the verb tables can be unit-tested without a live server.
export const CONCURRENCY_READ_VERBS = new Set([
  'get', 'list', 'search', 'query', 'read', 'fetch', 'describe', 'analyze', 'analyse',
  'decode', 'encode', 'hash', 'parse', 'convert', 'inspect', 'status', 'compare',
  'random', 'echo', 'ping', 'version', 'info', 'poll', 'export', 'templates',
  'history', 'fingerprint', 'endpoints', 'extract', 'issues', 'items', 'snapshot',
  'state', 'args', 'check', 'compress', 'decompress', 'intel', 'prompt', 'preview',
]);
export const CONCURRENCY_WRITE_VERBS = new Set([
  'set', 'add', 'remove', 'delete', 'create', 'update', 'clear', 'import',
  'start', 'stop', 'send', 'register', 'unregister', 'annotate', 'write',
  'shutdown', 'kill', 'drop', 'reset', 'enable', 'disable', 'intercept',
  'forge', 'sign', 'crack', 'attack', 'call', 'run', 'execute', 'apply',
  'install', 'load', 'save', 'trigger', 'invoke', 'fuzz', 'race',
  'probe', 'sweep', 'hunt', 'mine', 'discovery',
  'diff',
]);
export const CONCURRENCY_READONLY_EXCEPTIONS = new Set([
  'proxy_intercept_status',
  'analyze_diff',
]);

/**
 * Report the protocol revision the server actually selected. `initialize` is
 * allowed to answer with a different revision than the one requested; logging the
 * mismatch keeps a downgrade visible instead of surfacing later as odd tool errors.
 * Exported for unit testing.
 */
export function protocolVersionNotice(serverName, initResult, requested = MCP_PROTOCOL_VERSION) {
  const negotiated = initResult?.protocolVersion;
  if (typeof negotiated !== 'string' || !negotiated) return null;
  if (negotiated === requested) {
    return { level: 'info', message: `mcp-manager: ${serverName} protocol ${negotiated}` };
  }
  return { level: 'warn', message: `mcp-manager: ${serverName} requested protocol ${requested} but the server selected ${negotiated}` };
}

/** Whether one MCP tool may run concurrently with others. Unknown tools stay serial. */
export function isToolConcurrencySafe(toolName) {
  const raw = String(toolName ?? '').toLowerCase();
  if (!raw) return false;
  if (CONCURRENCY_READONLY_EXCEPTIONS.has(raw)) return true;
  const words = raw.split(/[_\-.]/).filter(Boolean);
  if (words.length === 0) return false;
  if (words.some((word) => CONCURRENCY_WRITE_VERBS.has(word))) return false;
  if (words.some((word) => CONCURRENCY_READ_VERBS.has(word))) return true;
  return false;
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

// ---------- zero-dependency lexical tool search ----------
//
// `mcp_search_tools` is deliberately lexical: NFKC normalization, a small English
// stemmer, CJK unigram/bigram tokenization, a built-in bilingual alias table,
// BM25 over per-field document sets, and a bounded edit-distance fallback. No
// embedding model, no vector store, no network call. The catalog is small
// enough to index on every call (microseconds), so nothing has to be
// invalidated when a server emits `notifications/tools/list_changed`.

/**
 * Bilingual / abbreviation synonym groups. Only query terms are expanded; the
 * document side keeps its own vocabulary, which is the standard cheap choice.
 */
export const MCP_SEARCH_ALIASES = [
  ['log', 'logs', 'logging', '日志'],
  ['search', 'query', 'find', '查询', '搜索', '检索'],
  ['deploy', 'deployment', 'release', 'publish', '部署', '发布', '上线'],
  ['config', 'configuration', 'settings', '配置', '设置'],
  ['database', 'db', '数据库'],
  ['table', '表格', '表'],
  ['user', 'account', '用户', '账号'],
  ['file', 'files', '文件'],
  ['document', 'doc', 'docs', 'documentation', '文档'],
  ['test', 'tests', 'testing', '测试'],
  ['error', 'errors', 'exception', '错误', '异常'],
  ['image', 'images', 'picture', '图片', '图像'],
  ['message', 'messages', 'msg', '消息'],
  ['task', 'tasks', 'job', '任务'],
  ['workflow', 'pipeline', '流程', '工作流'],
  ['monitor', 'monitoring', '监控'],
  ['metric', 'metrics', '指标'],
  ['cluster', '集群'],
  ['namespace', 'ns', '命名空间'],
  ['container', 'pod', '容器'],
  ['repo', 'repository', '仓库'],
  ['branch', '分支'],
  ['commit', '提交'],
  ['build', 'compile', '构建', '编译'],
  ['permission', 'permissions', 'auth', 'authorization', '权限', '认证', '鉴权'],
  ['domain', 'dns', '域名', '解析'],
  ['key', 'token', 'secret', '密钥', '令牌'],
  ['mail', 'email', '邮件'],
  ['calendar', 'schedule', '日历', '日程'],
  ['meeting', '会议'],
  ['create', 'add', 'new', '创建', '新增'],
  ['update', 'edit', 'modify', '更新', '修改'],
  ['delete', 'remove', '删除'],
  ['list', '列表'],
  ['get', 'fetch', 'read', '获取', '读取'],
  ['status', '状态'],
  ['name', '名称'],
  ['time', 'datetime', '时间'],
];

const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_MIN = 1;
const SEARCH_LIMIT_MAX = 50;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SEARCH_FIELD_ORDER = ['tool', 'server', 'description'];
const SEARCH_FIELD_WEIGHTS = { tool: 3, server: 2, description: 1 };
const ALIAS_TERM_WEIGHT = 0.5;
const FUZZY_TERM_WEIGHT = 0.6;
const EXACT_NAME_BONUS = 3;
const EXACT_TOKEN_BONUS = 2;
const MIN_FUZZY_TOKEN_LENGTH = 5;
const MAX_FUZZY_CANDIDATES_PER_TERM = 5;

const SEARCH_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'is', 'are', 'be',
  'in', 'on', 'with', 'by', 'at', 'from', 'as', 'it', 'this', 'that',
]);

const CJK_TOKEN_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/** NFKC + lowercase, used for the exact-name bonus and by callers. */
export function normalizeSearchText(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase();
}

/** Conservative English stemmer; long words only, so short words stay intact. */
export function stemSearchToken(token) {
  const value = String(token ?? '').toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(value)) return value;
  if (value.length >= 5 && value.endsWith('ies')) return value.slice(0, -3) + 'y';
  if (value.length >= 5 && value.endsWith('ing')) {
    const base = value.slice(0, -3);
    return base.length >= 3 ? base : value;
  }
  if (value.length >= 5 && value.endsWith('ed')) {
    const base = value.slice(0, -2);
    return base.length >= 3 ? base : value;
  }
  if (value.length >= 4 && value.endsWith('s') && !value.endsWith('ss') && !value.endsWith('us')) {
    return value.slice(0, -1);
  }
  return value;
}

function pushCjkTokens(tokens, part) {
  const chars = [...part];
  if (chars.length === 1) {
    tokens.push(chars[0]);
    return;
  }
  for (const char of chars) tokens.push(char);
  for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1]);
}

/**
 * Split text into search tokens: camelCase boundaries, punctuation separators,
 * CJK unigrams + bigrams, and surface + stem forms of Latin words. Stopwords
 * are dropped only when something else remains, so a stopword-only query still
 * searches instead of silently browsing.
 */
export function tokenizeSearchText(text) {
  const raw = String(text ?? '').normalize('NFKC').trim();
  if (raw === '') return [];
  const camelSplit = raw.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2');
  const parts = camelSplit.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    if (CJK_TOKEN_RE.test(part)) {
      pushCjkTokens(tokens, part);
      continue;
    }
    tokens.push(part);
    const stem = stemSearchToken(part);
    if (stem !== part && stem !== '') tokens.push(stem);
  }
  if (tokens.length === 0) return [];
  const filtered = tokens.filter((token) => !SEARCH_STOPWORDS.has(token));
  return filtered.length > 0 ? filtered : tokens;
}

function buildAliasIndex(aliasGroups) {
  const index = new Map();
  const link = (from, members) => {
    const aliases = index.get(from) ?? new Set();
    for (const member of members) if (member !== from) aliases.add(member);
    index.set(from, aliases);
  };
  for (const group of aliasGroups) {
    const members = [...new Set(group.map((member) => String(member).toLowerCase()))];
    for (const member of members) {
      link(member, members);
      const stem = stemSearchToken(member);
      if (stem !== member && stem !== '') link(stem, members);
    }
  }
  return index;
}

const SEARCH_ALIAS_INDEX = buildAliasIndex(MCP_SEARCH_ALIASES);

/** Expand query tokens with alias groups; the original term always wins. */
export function expandSearchTerms(tokens) {
  const weights = new Map();
  const add = (term, weight) => {
    if (!term) return;
    const previous = weights.get(term);
    if (previous === undefined || weight > previous) weights.set(term, weight);
  };
  const list = Array.isArray(tokens) ? tokens : [];
  for (const token of list) add(token, 1);
  for (const token of list) {
    const aliases = SEARCH_ALIAS_INDEX.get(token) ?? SEARCH_ALIAS_INDEX.get(stemSearchToken(token));
    if (!aliases) continue;
    for (const alias of aliases) {
      add(alias, ALIAS_TERM_WEIGHT);
      const stem = stemSearchToken(alias);
      if (stem !== alias) add(stem, ALIAS_TERM_WEIGHT);
    }
  }
  return [...weights.entries()].map(([term, weight]) => ({ term, weight }));
}

function searchTermFrequency(tokens) {
  const frequency = new Map();
  for (const token of tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return frequency;
}

function compareSearchText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function clampSearchLimit(value) {
  const requested = Number.isInteger(value) ? value : SEARCH_LIMIT_DEFAULT;
  return Math.max(SEARCH_LIMIT_MIN, Math.min(SEARCH_LIMIT_MAX, requested));
}

function buildSearchIndex(entries) {
  const documents = entries.map((entry) => {
    const fields = {};
    for (const field of SEARCH_FIELD_ORDER) {
      const tokens = tokenizeSearchText(entry[field] ?? '');
      fields[field] = { tf: searchTermFrequency(tokens), length: tokens.length, tokens: new Set(tokens) };
    }
    return { entry, fields };
  });
  const stats = {};
  const vocabulary = new Set();
  for (const field of SEARCH_FIELD_ORDER) {
    const df = new Map();
    let totalLength = 0;
    for (const document of documents) {
      totalLength += document.fields[field].length;
      for (const token of document.fields[field].tf.keys()) {
        df.set(token, (df.get(token) ?? 0) + 1);
        vocabulary.add(token);
      }
    }
    stats[field] = { df, avgLength: documents.length > 0 ? totalLength / documents.length : 0 };
  }
  return { documents, stats, vocabulary };
}

function bm25TermScore(field, term, stats, documentCount) {
  const documentFrequency = stats.df.get(term) ?? 0;
  if (documentFrequency === 0) return 0;
  const termFrequency = field.tf.get(term) ?? 0;
  if (termFrequency === 0) return 0;
  const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
  const lengthRatio = stats.avgLength > 0 ? field.length / stats.avgLength : 1;
  const denominator = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio);
  return (idf * termFrequency * (BM25_K1 + 1)) / denominator;
}

function boundedEditDistance(left, right, maxDistance) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = new Array(right.length + 1);
  let current = new Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
      if (current[column] < rowMinimum) rowMinimum = current[column];
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length];
}

function fuzzySearchTerms(term, vocabulary) {
  if (term.length < MIN_FUZZY_TOKEN_LENGTH) return [];
  const maxDistance = term.length >= 8 ? 2 : 1;
  const candidates = [];
  for (const candidate of vocabulary) {
    if (candidate === term) continue;
    if (Math.abs(candidate.length - term.length) > maxDistance) continue;
    if (boundedEditDistance(term, candidate, maxDistance) <= maxDistance) candidates.push(candidate);
  }
  candidates.sort();
  return candidates.slice(0, MAX_FUZZY_CANDIDATES_PER_TERM);
}

function toSearchMatch(entry, score) {
  return {
    name: String(entry.name ?? ''),
    server: String(entry.server ?? ''),
    tool: String(entry.tool ?? ''),
    description: String(entry.description ?? '').slice(0, 300),
    score,
  };
}

/**
 * Rank one catalog snapshot against a lexical query. Pure: no `ctx`, no I/O, no
 * clock. Returns `{ query, total, matches }` where `total` is the number of
 * results before `limit` truncation.
 */
export function searchToolEntries(entries, options = {}) {
  const catalog = Array.isArray(entries) ? entries : [];
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const serverFilter = typeof options.server === 'string' ? options.server.trim().toLowerCase() : '';
  const limit = clampSearchLimit(options.limit);
  const filtered = serverFilter === ''
    ? catalog.slice()
    : catalog.filter((entry) => String(entry.server ?? '').toLowerCase() === serverFilter);

  if (query === '') {
    const browse = filtered
      .map((entry) => ({ entry, server: String(entry.server ?? ''), name: String(entry.name ?? '') }))
      .sort((left, right) => compareSearchText(left.server, right.server) || compareSearchText(left.name, right.name))
      .slice(0, limit)
      .map((item) => toSearchMatch(item.entry, 0));
    return { query: '', total: filtered.length, matches: browse };
  }

  const tokens = tokenizeSearchText(query);
  if (tokens.length === 0) return { query, total: 0, matches: [] };

  const index = buildSearchIndex(filtered);
  const terms = expandSearchTerms(tokens);
  for (const term of [...terms]) {
    if (index.vocabulary.has(term.term)) continue;
    for (const candidate of fuzzySearchTerms(term.term, index.vocabulary)) {
      terms.push({ term: candidate, weight: term.weight * FUZZY_TERM_WEIGHT });
    }
  }

  const exactQuery = normalizeSearchText(query);
  const queryTokens = new Set(tokens);
  const scored = [];
  for (const document of index.documents) {
    let score = 0;
    for (const term of terms) {
      for (const field of SEARCH_FIELD_ORDER) {
        const fieldScore = bm25TermScore(document.fields[field], term.term, index.stats[field], filtered.length);
        if (fieldScore > 0) score += fieldScore * SEARCH_FIELD_WEIGHTS[field] * term.weight;
      }
    }
    const toolName = String(document.entry.tool ?? '').toLowerCase();
    const publicName = String(document.entry.server ?? '').toLowerCase() + '__' + toolName;
    if (exactQuery !== '' && (toolName.includes(exactQuery) || publicName.includes(exactQuery))) {
      score += EXACT_NAME_BONUS;
    }
    for (const token of queryTokens) {
      if (document.fields.tool.tokens.has(token)) {
        score += EXACT_TOKEN_BONUS;
        break;
      }
    }
    if (score <= 0) continue;
    scored.push({ entry: document.entry, score: Math.round(score * 100) });
  }
  scored.sort((left, right) => right.score - left.score
    || compareSearchText(String(left.entry.server ?? ''), String(right.entry.server ?? ''))
    || compareSearchText(String(left.entry.name ?? ''), String(right.entry.name ?? '')));
  return {
    query,
    total: scored.length,
    matches: scored.slice(0, limit).map((item) => toSearchMatch(item.entry, item.score)),
  };
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

/**
 * Resolve the Agent handed to an agent-setup callback.
 *
 * Older harness builds call `setup(agentCtx)` and expose the Agent through an
 * `agent` accessor declared on the context. Newer builds (0.1.5-rc.*) dropped
 * that accessor and pass the Agent as the second argument instead, so reading
 * `agentCtx.agent` there throws "cannot get property \"agent\" without inject"
 * and used to fail every session create/resume. Prefer the explicit argument,
 * fall back to the guarded accessor, and never throw: workspace scoping is
 * best-effort and must not break session creation.
 */
export function resolveSetupAgent(agentCtx, agent) {
  if (agent !== undefined && agent !== null) return agent;
  if (agentCtx === null || typeof agentCtx !== 'object') return undefined;
  try {
    if ('agent' in agentCtx) return agentCtx.agent;
  } catch {
    // A context whose `agent` accessor exists but refuses to resolve: no agent.
  }
  return undefined;
}

export const inject = ['tools'];

export function apply(ctx) {
  const state = loadState();
  // Per-workspace OAuth client registrations + tokens (keyed by canonical
  // workspace path + server name); secrets live in the same sensitive state
  // file as the global servers, never in the declarative mcp.json.
  if (!state.workspaceTokens) state.workspaceTokens = {};
  if (state.onDemandToolInjection !== true) state.onDemandToolInjection = false;

  // One-time migration for configs written by older plugin versions: assign the
  // missing per-server `id` (otherwise every id-addressed API 404s and all
  // live status/errors share one key) and normalize legacy env/header arrays.
  // Persist immediately so the ids stay stable across restarts.
  if (migrateLoadedState(state)) {
    ctx.logger.warn('mcp-manager: migrated legacy state file (assigned missing server ids and/or normalized env/header pairs)');
    try {
      saveState(state);
    } catch (error) {
      ctx.logger.error(`mcp-manager: could not persist the migrated state file: ${error?.message ?? error}`);
    }
  }

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

  // A local server pointed at the discard port (127.0.0.1:9) or a reserved
  // `.invalid` host is a test fixture, not something anyone typed on purpose.
  // Before tests pinned USERPROFILE, running the suite on Windows wrote its stub
  // servers into the developer's real state file, where they showed up as a
  // permanent red "error" row with no hint of where they came from. Name it.
  for (const server of state.servers ?? []) {
    if (server.type !== 'http' || typeof server.url !== 'string') continue;
    let host;
    let port;
    try {
      const parsed = new URL(server.url);
      host = parsed.hostname;
      port = parsed.port;
    } catch {
      continue;
    }
    if (port === '9' || host.endsWith('.invalid')) {
      ctx.logger.warn(`mcp-manager: ${server.name} points at ${server.url}, which looks like leftover test data (the discard port or a reserved .invalid host) — remove it in Settings → MCP unless you meant to keep it`);
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

  // The issuer is the authorization server once discovery has identified one;
  // otherwise the MCP endpoint's own origin. Deliberately pure (no I/O):
  // callers compare issuers across a config edit to decide whether cached OAuth
  // state is still valid.
  function issuerOf(server) {
    if (server.oauth?.authorizationServer) return String(server.oauth.authorizationServer).replace(/\/$/, '');
    if (server.oauth?.issuer) return server.oauth.issuer.replace(/\/$/, '');
    return new URL(server.url).origin;
  }

  // RFC 8414 inserts the issuer's path *before* the well-known segment:
  //   https://github.com/login/oauth
  //     -> https://github.com/.well-known/oauth-authorization-server/login/oauth
  // That is the form GitHub (and most multi-tenant issuers) actually serve; the
  // naive `${issuer}/.well-known/...` form is probed too, for compatibility.
  function wellKnownUrl(issuer, segment) {
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/$/, '');
    return `${u.origin}/.well-known/${segment}${path}`;
  }

  // Per-server attempt log: an in-memory ring buffer explaining *why* a
  // connection or handshake failed. Deliberately not persisted — the durable
  // record stays `ctx.logger`, and a log file would add a new secret-at-rest
  // surface. Redaction happens on write, never on render.
  const attemptLogs = new Map();
  const ATTEMPT_LOG_MAX = 20;

  function redactDetail(value) {
    return String(value ?? '')
      .replace(/([?&](?:code|state|client_secret|access_token|refresh_token|id_token)=)[^&\s"']*/gi, '$1<redacted>')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer <redacted>')
      .replace(/\b(authorization|access_token|refresh_token|client_secret|id_token)\b\s*[:=]\s*[^&\s"',]+/gi, '$1=<redacted>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  function recordAttempt(server, entry) {
    if (!server?.id) return;
    const list = attemptLogs.get(server.id) ?? [];
    list.push({
      at: Date.now(),
      phase: String(entry.phase ?? 'request').slice(0, 32),
      url: redactDetail(entry.url),
      status: Number.isFinite(entry.status) ? entry.status : 0,
      detail: redactDetail(entry.detail),
    });
    if (list.length > ATTEMPT_LOG_MAX) list.splice(0, list.length - ATTEMPT_LOG_MAX);
    attemptLogs.set(server.id, list);
  }

  function readAttempts(serverId) {
    return (attemptLogs.get(serverId) ?? []).slice();
  }

  function clearAttempts(serverId) {
    attemptLogs.delete(serverId);
  }

  async function fetchJson(url, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal, redirect: 'follow' });
      const text = await resp.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return { status: resp.status, ok: resp.ok, json: parsed };
    } finally {
      clearTimeout(timer);
    }
  }

  // Ordered discovery. RFC 9728 protected-resource metadata (advertised by the
  // 401 WWW-Authenticate header, or at its well-known location) names the
  // authorization server; RFC 8414 metadata then describes its endpoints. Only
  // when nothing is discoverable do we guess ${origin}/oauth/* — and that result
  // is tagged so the UI can say the endpoints were guessed, not discovered.
  async function discoverOauthMetadata(server) {
    const endpoint = new URL(server.url);
    const origin = endpoint.origin;
    const path = endpoint.pathname.replace(/\/$/, '');
    const tried = [];

    const probe = async (url, label) => {
      let out = null;
      try {
        out = await fetchJson(url);
      } catch (error) {
        tried.push({ url, status: 0 });
        recordAttempt(server, { phase: 'discovery', url, status: 0, detail: `${label}: ${error?.message ?? error}` });
        return null;
      }
      tried.push({ url, status: out.status });
      if (out.ok && out.json) {
        recordAttempt(server, { phase: 'discovery', url, status: out.status, detail: label });
        return out.json;
      }
      recordAttempt(server, { phase: 'discovery', url, status: out.status, detail: `${label}: HTTP ${out.status}` });
      return null;
    };

    const resourceUrls = [];
    if (server.oauth?.resourceMetadataUrl) resourceUrls.push(server.oauth.resourceMetadataUrl);
    if (path) resourceUrls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
    resourceUrls.push(`${origin}/.well-known/oauth-protected-resource`);

    let resourceUrl = '';
    let resourceMd = null;
    for (const url of resourceUrls) {
      const md = await probe(url, 'protected resource metadata');
      if (Array.isArray(md?.authorization_servers) && md.authorization_servers.length > 0) {
        resourceMd = md;
        resourceUrl = url;
        break;
      }
    }

    const issuers = [];
    for (const issuer of resourceMd?.authorization_servers ?? []) {
      if (typeof issuer === 'string' && issuer.trim()) issuers.push(issuer.trim());
    }
    if (issuers.length === 0) issuers.push(origin);

    const seen = new Set();
    for (const issuer of issuers) {
      const candidates = [];
      for (const candidate of [
        wellKnownUrl(issuer, 'oauth-authorization-server'),
        wellKnownUrl(issuer, 'openid-configuration'),
        `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
      ]) {
        if (!seen.has(candidate)) { seen.add(candidate); candidates.push(candidate); }
      }
      for (const url of candidates) {
        const md = await probe(url, 'authorization server metadata');
        if (md?.authorization_endpoint && md?.token_endpoint) {
          server.oauth = server.oauth ?? {};
          if (resourceUrl) server.oauth.resourceMetadataUrl = resourceUrl;
          server.oauth.authorizationServer = issuer;
          return { ...md, source: resourceMd ? 'protected-resource' : 'authorization-server', authorizationServer: issuer, tried };
        }
      }
    }

    recordAttempt(server, { phase: 'discovery', url: origin, status: 0, detail: 'no metadata found; guessing /oauth/* endpoints' });
    return {
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/register`,
      source: 'fallback',
      authorizationServer: origin,
      tried,
    };
  }

  function callbackFor(origin, serverId) {
    return `${origin}${CALLBACK_PATH}/${serverId}`;
  }

  // A manually configured client id means the user registered an app with the
  // provider themselves; DCR is skipped entirely and the redirect URI must
  // already be whitelisted there.
  function manualClientId(server) {
    return typeof server.clientId === 'string' ? server.clientId.trim() : '';
  }

  // client_secret_post (RFC 6749 §2.3.1). Only the *name* of the environment
  // variable is persisted — never the secret, not on disk and not in any log.
  // Returns '' for a public client (PKCE alone), and fails by naming the
  // variable when it is configured but unset.
  function clientSecretOf(server) {
    const name = typeof server.clientSecretEnv === 'string' ? server.clientSecretEnv.trim() : '';
    if (!name) return '';
    const value = process.env[name];
    if (!value) throw new Error(`client secret environment variable ${name} is not set`);
    return value;
  }

  function oauthScopeOf(server) {
    return typeof server.scope === 'string' ? server.scope.trim() : '';
  }

  // Discovery mutates the non-secret cache on `server.oauth`; persist it (only
  // when it actually changed) so the next authorize skips the probing chain.
  function oauthCacheKey(server) {
    return JSON.stringify([server.oauth?.resourceMetadataUrl ?? '', server.oauth?.authorizationServer ?? '']);
  }

  async function discoverAndPersist(server) {
    const before = oauthCacheKey(server);
    const md = await discoverOauthMetadata(server);
    if (oauthCacheKey(server) !== before) persistServer(server);
    return md;
  }

  // Validate the three manual-credential fields shared by the global and
  // workspace editors. Pure (no I/O), so callers can validate before mutating.
  function parseOauthFields(input, current = {}) {
    const clientId = String(input.clientId ?? current.clientId ?? '').trim();
    if (clientId.length > 512) throw new Error('clientId must be at most 512 characters');
    const clientSecretEnv = String(input.clientSecretEnv ?? current.clientSecretEnv ?? '').trim();
    if (clientSecretEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(clientSecretEnv)) {
      throw new Error('clientSecretEnv must be the name of an environment variable (letters, digits, underscore), not the secret itself');
    }
    const scope = String(input.scope ?? current.scope ?? '').trim();
    if (scope.length > 512) throw new Error('scope must be at most 512 characters');
    return { clientId, clientSecretEnv, scope };
  }

  // Copy the optional OAuth client-credential fields onto a server object,
  // dropping keys that are empty so the persisted JSON stays minimal.
  function applyOauthFields(server, fields) {
    if (fields.clientId) server.clientId = fields.clientId; else delete server.clientId;
    if (fields.clientSecretEnv) server.clientSecretEnv = fields.clientSecretEnv; else delete server.clientSecretEnv;
    if (fields.scope) server.scope = fields.scope; else delete server.scope;
  }

  // Register a dynamic OAuth client for this server (RFC 7591), bound to the
  // origin the browser actually uses. Re-registers if the origin changed
  // (e.g. the GUI moved to another port), since redirect_uri must match
  // exactly at exchange time.
  async function ensureClientId(server, md, origin) {
    const manual = manualClientId(server);
    if (manual) return manual;
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
    recordAttempt(server, {
      phase: 'register',
      url: regEndpoint,
      status: resp.status,
      detail: reg?.client_id ? `dynamic client ${reg.client_id} registered` : String(resp.text).slice(0, 200),
    });
    if (!reg?.client_id) {
      throw new Error(`client registration failed: HTTP ${resp.status} — this authorization server may not support dynamic client registration (RFC 7591); set a Client ID registered with the provider, or use a static Bearer token`);
    }
    server.oauth = server.oauth ?? {};
    server.oauth.clientId = reg.client_id;
    server.oauth.redirect = redirect;
    persistServer(server);
    return reg.client_id;
  }

  async function startAuth(server, origin) {
    const md = await discoverAndPersist(server);
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
    const scope = oauthScopeOf(server);
    if (scope) url.searchParams.set('scope', scope);
    recordAttempt(server, {
      phase: 'authorize',
      url: url.toString(),
      status: 302,
      detail: `redirecting to ${md.authorization_endpoint} (${md.source ?? 'discovered'})`,
    });
    setServerAuthStatus(server, 'authorizing');
    return url.toString();
  }

  async function exchangeCode(server, code, origin) {
    const flow = pending.get(server.id);
    if (!flow) throw new Error('no pending authorization for this server');
    pending.delete(server.id);
    const md = await discoverAndPersist(server);
    const clientId = await ensureClientId(server, md, origin);
    const secret = clientSecretOf(server);
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackFor(origin, server.id),
      client_id: clientId,
      code_verifier: flow.verifier,
    };
    if (secret) form.client_secret = secret;
    const resp = await httpPostForm(md.token_endpoint, {}, form);
    const tok = parseBody(resp);
    recordAttempt(server, {
      phase: 'token-exchange',
      url: md.token_endpoint,
      status: resp.status,
      detail: tok?.access_token ? 'access token issued' : String(resp.text).slice(0, 200),
    });
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
    const md = await discoverAndPersist(server);
    const clientId = server.oauth?.clientId;
    if (!clientId) return false;
    const form = {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    };
    let secret = '';
    try { secret = clientSecretOf(server); } catch { return false; }
    if (secret) form.client_secret = secret;
    const resp = await httpPostForm(md.token_endpoint, {}, form);
    const tok = parseBody(resp);
    recordAttempt(server, {
      phase: 'refresh',
      url: md.token_endpoint,
      status: resp.status,
      detail: tok?.access_token ? 'access token refreshed' : `refresh failed: HTTP ${resp.status}`,
    });
    if (!tok?.access_token) return false;
    server.oauth.tokens = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000 - 60000,
    };
    persistServer(server);
    return true;
  }

  // HTTP auth modes: oauth | static | none. Unknown or legacy values fall back
  // to oauth so a hand-edited config can never leave a server in a limbo state.
  function normalizeAuthMode(value) {
    return value === 'static' || value === 'none' ? value : 'oauth';
  }

  function accessToken(server) {
    // "none" means unauthenticated: never send an Authorization header, even if
    // a stale OAuth token is still attached (hand-edited workspace mcp.json).
    if (server.authMode === 'none') return '';
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
    if (server.authMode === 'none') return true;
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
      total: { type: 'integer' },
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
    required: ['query', 'total', 'matches'],
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
        description: 'Search MCP tools visible in the current session. Use the exact returned name with mcp_describe_tool or mcp_execute_tool. Omit query to list the catalog.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Keywords describing the needed capability. Omit or leave empty to list the catalog instead.' },
            server: { type: 'string', description: 'Optional exact MCP server name.' },
            limit: { type: 'integer', description: 'Optional result count, clamped to 1-50 (default 10).' },
          },
        },
        output: { schema: BROKER_SEARCH_RESULT_SCHEMA, render: brokerJsonRender },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const catalog = brokerCatalog(exec.agent).map((entry) => ({
            name: entry.schema.name,
            server: entry.server,
            tool: entry.tool,
            description: String(entry.schema.description ?? ''),
          }));
          return searchToolEntries(catalog, { query: args?.query, server: args?.server, limit: args?.limit });
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
    // With `shell: true` Node hands `cmd.exe /d /s /c "<line>"` the command and
    // args joined by bare spaces and adds no quoting of its own, so any token
    // containing whitespace must be quoted here or cmd truncates it at the
    // first space. Quoting is idempotent for already-quoted config values.
    const command = isWin ? quoteWindowsToken(server.command) : server.command;
    const args = isWin ? (server.args ?? []).map(quoteWindowsToken) : (server.args ?? []);
    const child = spawn(command, args, {
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
    recordAttempt(server, { phase: 'stdio-spawn', url: [server.command, ...(server.args ?? [])].join(' '), status: 0, detail: `spawned pid ${child.pid ?? '?'}` });
    child.on('error', (error) => {
      recordAttempt(server, { phase: 'stdio-exit', url: server.command, status: 0, detail: `spawn error: ${error?.message ?? error}` });
      fail(error);
    });
    child.on('close', (code, signal) => {
      recordAttempt(server, {
        phase: 'stdio-exit',
        url: server.command,
        status: Number.isFinite(code) ? code : 0,
        detail: `exited code=${code ?? 'null'} signal=${signal ?? 'null'}${stderrTail ? `; stderr: ${stderrTail}` : ''}`,
      });
      fail(new Error(stderrTail ? `stdio process exited: ${stderrTail.slice(-300)}` : 'stdio process exited'));
    });

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

  // ---------- concurrency classification ----------
  // Verb tables and `isToolConcurrencySafe` live at module scope so they can be
  // unit-tested directly (see the exports near `renderMcpResult`). Rationale for the
  // ordering rules is documented there; `makeToolDefinition` is the only caller.
  // ---------- end concurrency classification ----------

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
      isConcurrencySafe: () => isToolConcurrencySafe(tool.name),
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

  // ---------- HTTP-with-SSE transport ----------
  //
  // MCP has two generations of HTTP transport, and they are not interchangeable:
  //
  //   Streamable HTTP : POST <url>                    -> the JSON-RPC result is the POST response body
  //   HTTP with SSE   : GET  <url>                    -> a long-lived event stream; its first
  //                                                       `event: endpoint` frame advertises the
  //                                                       session target (`?sessionId=…`)
  //                     POST <advertised endpoint>    -> 202 Accepted with an empty body;
  //                                                       the JSON-RPC result arrives asynchronously
  //                                                       as an `event: message` frame on the stream
  //
  // `parseRpc`'s SSE handling only covers a *response body* that happens to be SSE-framed.
  // A real SSE session needs the GET stream first, which is why such servers answer a bare
  // POST with e.g. `400 sessionId query parameter is not provided` (BurpMCP-Ultra does).
  // `openSseEndpoint` detects that shape and `openSseSession` speaks the rest of the protocol.

  /** A response is worth retrying as an SSE session only for these shapes. */
  function looksLikeSseEndpoint(resp, parsed) {
    if (parsed) return false;                                  // already a JSON-RPC payload
    if (resp.status >= 200 && resp.status < 300) return true;   // 2xx but not JSON (202/empty)
    return /session\s*id/i.test(String(resp.text ?? ''));       // error text names a session id
  }

  /** Turn an `event:`/`data:` frame into JSON-RPC messages, forwarding each one. */
  function dispatchSseFrame(block, onMessage) {
    let event = null;
    const data = [];
    for (const line of String(block).replace(/\r\n/g, '\n').split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (event === 'endpoint') return { endpoint: data.join('\n').trim() };
    for (const message of parseSseMessages(`${block}\n\n`)) onMessage?.(message);
    return null;
  }

  /**
   * Open the GET stream and resolve the advertised POST target.
   * `closed` is polled by the caller's retry loop, so a stream teardown simply
   * rejects the read and lets the caller decide whether to reconnect.
   */
  async function openSseSession(server, handle, abortController, onMessage, waiters) {
    const resp = await fetch(server.url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...authHeaders(server, handle) },
      signal: abortController.signal,
      redirect: 'manual',
    });
    if (resp.status === 401) {
      // Surface the server's own wording — "missing or invalid token" is far more
      // actionable than a bare "authentication required".
      const reason = serverReason(resp);
      const error = new Error(`HTTP 401: ${reason || 'authentication required'}`);
      error.status = 401;
      throw error;
    }
    if (!resp.ok || !resp.body) throw new Error(`SSE GET HTTP ${resp.status}`);

    let endpointResolve;
    const endpointReady = new Promise((resolve) => { endpointResolve = resolve; });
    const decoder = new TextDecoder();
    let buffer = '';
    let sawEndpoint = false;

    // Consume frames for the lifetime of the stream. Both the endpoint frame and
    // every JSON-RPC reply travel this one connection. The stream ending means the
    // session is gone, so pending callers are failed rather than left to time out.
    let streamEnded = false;
    const endStream = () => {
      if (streamEnded) return;
      streamEnded = true;
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('SSE stream closed'));
      }
      waiters.clear();
      if (!handle.closed) handle.onStreamClosed?.();
    };
    void (async () => {
      try {
        for await (const chunk of resp.body) {
          buffer += decoder.decode(chunk, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const found = dispatchSseFrame(block, onMessage);
            if (found?.endpoint && !sawEndpoint) {
              sawEndpoint = true;
              endpointResolve(found.endpoint);
            }
          }
        }
        buffer += decoder.decode();
        for (const message of parseSseMessages(buffer)) onMessage?.(message);
      } catch {
        // Aborted or dropped — treated the same as a clean end below.
      } finally {
        if (!sawEndpoint) endpointResolve(null);
        endStream();
      }
    })();

    const endpoint = await Promise.race([
      endpointReady,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), 15000);
        timer.unref?.();
      }),
    ]);
    if (!endpoint) {
      abortController.abort();
      throw new Error('SSE stream did not advertise an endpoint within 15s');
    }

    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint, server.url).toString();
    } catch {
      abortController.abort();
      throw new Error('SSE stream advertised an unusable endpoint');
    }
    return { endpointUrl };
  }

  /** POST one JSON-RPC message to the advertised session endpoint. */
  async function sseSessionPost(server, handle, endpointUrl, payload, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const resp = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...authHeaders(server, handle) },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'manual',
      });
      if (resp.status === 401) {
        const reason = serverReason(resp);
        const error = new Error(`HTTP 401: ${reason || 'authentication required'}`);
        error.status = 401;
        throw error;
      }
      if (resp.status >= 400) {
        const reason = serverReason(resp);
        throw new Error(`POST HTTP ${resp.status}${reason ? `: ${reason}` : ''}`);
      }
      // 202 Accepted with an empty body is the normal SSE-session reply.
      await resp.body?.cancel().catch(() => {});
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a request over an SSE session, correlating the reply by JSON-RPC id.
   * Replies are delivered by the stream pump, so this only needs a waiter table.
   */
  function sseSessionCall(server, handle, endpointUrl, waiters) {
    return (method, params, { isNotification = false, timeoutMs = 60000 } = {}) => {
      const payload = { jsonrpc: '2.0', method };
      if (params !== undefined) payload.params = params;
      if (isNotification) {
        return sseSessionPost(server, handle, endpointUrl, payload, timeoutMs).then(() => null);
      }
      const id = rpcSeq++;
      payload.id = id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`MCP ${method} timeout after ${timeoutMs}ms (no SSE reply)`));
        }, timeoutMs);
        timer.unref?.();
        waiters.set(id, { resolve, reject, timer });
        sseSessionPost(server, handle, endpointUrl, payload, timeoutMs).catch((error) => {
          waiters.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    };
  }

  /** Resolve a pending waiter for one JSON-RPC reply frame. */
  function settleSseReply(handle, waiters, message) {
    if (message?.id == null || !waiters.has(message.id)) return;
    const waiter = waiters.get(message.id);
    waiters.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  }

  /** Read the server's own error wording out of a response body, if any. */
  function serverReason(resp) {
    const raw = typeof resp?.text === 'string' ? resp.text.slice(0, 300) : '';
    if (!raw) return '';
    try {
      const parsed = JSON.parse(raw);
      return String(parsed?.error ?? parsed?.message ?? raw).slice(0, 200);
    } catch {
      return raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }

  /** Emit the protocol-revision notice for one `initialize` result. */
  function logProtocolVersion(server, initResult) {
    const notice = protocolVersionNotice(server.name, initResult);
    if (!notice) return;
    if (notice.level === 'warn') ctx.logger.warn(notice.message);
    else ctx.logger.info(notice.message);
  }

  // Open an HTTP-with-SSE session and return a handle with the same contract as
  // `openHttp`, so callers (global and workspace tiers) do not special-case it.
  async function openSse(server) {
    const handle = {
      kind: 'http', sessionId: null, transport: 'sse', tools: [], closed: false,
      onNotification: null, notificationStarted: false, notificationController: null,
      call: () => Promise.reject(new Error('not connected')),
      listTools: () => Promise.reject(new Error('not connected')),
      startNotifications: () => {},   // the session stream already carries notifications
      close() {
        handle.closed = true;
        handle.notificationController?.abort();
      },
    };

    const controller = new AbortController();
    handle.notificationController = controller;
    handle.notificationStarted = true;   // the session stream already carries notifications

    const waiters = new Map();
    // One dispatcher settles replies by id and forwards everything else
    // (notifications) to the handle's listener.
    const onMessage = (message) => {
      if (message?.id != null) settleSseReply(handle, waiters, message);
      else if (typeof message?.method === 'string') handle.onNotification?.(message);
    };

    const session = await openSseSession(server, handle, controller, onMessage, waiters);
    handle.sessionId = new URL(session.endpointUrl).searchParams.get('sessionId') ?? null;
    handle.sessionEndpoint = session.endpointUrl;

    const call = sseSessionCall(server, handle, session.endpointUrl, waiters);
    handle.call = (name, args) => call('tools/call', { name, arguments: args });
    handle.listTools = (cursor) => call('tools/list', cursor === undefined ? {} : { cursor });

    const init = await call('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-mcp-manager', version: '0.6.0' },
    });
    logProtocolVersion(server, init);
    await call('notifications/initialized', undefined, { isNotification: true }).catch(() => {});
    handle.tools = await listAllTools(handle);
    handle.initResult = init;
    return handle;
  }
  // ---------- end HTTP-with-SSE transport ----------

  // The 401 advertises the protected-resource metadata URL (RFC 9728 §5.1).
  // Caching it lets the next authorize skip the whole probing chain.
  function captureResourceMetadata(server, resp) {
    const header = resp.headers?.get?.('www-authenticate');
    if (!header) return;
    const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
    if (!match) return;
    const url = match[1];
    if (/^https?:\/\//.test(url) && server.oauth?.resourceMetadataUrl !== url) {
      server.oauth = server.oauth ?? {};
      server.oauth.resourceMetadataUrl = url;
      persistServer(server);
    }
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
    const initPayload = { jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.6.0' } } };
    let resp = await httpPostJson(server.url, authHeaders(server, handle), initPayload);
    if (resp.status === 401 && server.authMode === 'oauth' && (await refreshTokens(server))) {
      resp = await httpPostJson(server.url, authHeaders(server, handle), initPayload);
    }
    if (resp.status === 401) {
      // The 401 advertises which authorization server protects this endpoint.
      captureResourceMetadata(server, resp);
      // Prefer the server's own wording when it supplies one.
      const reason = serverReason(resp);
      throw new Error(`HTTP 401: ${reason || 'authentication required'}`);
    }
    const init = parseRpc(resp, initId, handle);

    // A server that answers a bare POST with a session-id complaint is speaking
    // HTTP-with-SSE, not Streamable HTTP — retry it over a real SSE session.
    if (!init && looksLikeSseEndpoint(resp, init)) {
      const why = `HTTP ${resp.status}${serverReason(resp) ? `: ${serverReason(resp)}` : ''}`;
      try {
        const sseHandle = await openSse(server);
        ctx.logger.info(`mcp-manager: ${server.name} connected over ${sseHandle.transport} transport (Streamable HTTP probe: ${why})`);
        return sseHandle;
      } catch (error) {
        throw new Error(`server looks like HTTP-with-SSE but the SSE session failed (Streamable HTTP probe: ${why}): ${error?.message ?? error}`);
      }
    }

    if (resp.status >= 400) throw new Error(`initialize HTTP ${resp.status}${serverReason(resp) ? `: ${serverReason(resp)}` : ''}`);
    if (!init || init.error) throw new Error(`initialize failed: ${String(resp.text).slice(0, 200)}`);
    logProtocolVersion(server, init.result);
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
      const stdioInit = await transport.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'dsh-mcp-manager', version: '0.6.0' } });
      logProtocolVersion(server, stdioInit);
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

  // ---------- reconnect with exponential backoff ----------
  //
  // A failed connect used to leave the server in `error` until the user pressed
  // reconnect, so starting DSH before the MCP server was a permanent dead end.
  // Retries back off 3s → 6s → 12s … capped at 60s, and reset on success.
  // `needs-auth` is never retried: it needs a browser round trip, not patience.
  const RECONNECT_BASE_MS = 3000;
  const RECONNECT_MAX_MS = 60000;
  const reconnectAttempts = new Map();   // serverId -> consecutive failures
  const reconnectTimers = new Map();     // serverId -> pending timer

  function cancelReconnect(serverId, { resetAttempts = false } = {}) {
    const timer = reconnectTimers.get(serverId);
    if (timer) { clearTimeout(timer); reconnectTimers.delete(serverId); }
    if (resetAttempts) reconnectAttempts.delete(serverId);
  }

  /**
   * Queue a reconnect.
   * @param immediate 用于"本来连着、突然断了"（SSE 流被服务端关闭）：
   *                  这是既定会话失效，不是启动竞态，没必要让用户等一个退避周期。
   */
  function scheduleReconnect(server, { immediate = false } = {}) {
    cancelReconnect(server.id);
    if (immediate) reconnectAttempts.delete(server.id);
    const attempt = (reconnectAttempts.get(server.id) ?? 0) + 1;
    reconnectAttempts.set(server.id, attempt);
    const delay = immediate ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    const timer = setTimeout(() => {
      reconnectTimers.delete(server.id);
      // The server may have been deleted, disabled, or reconnected in the meantime.
      if (!state.servers.some((candidate) => candidate.id === server.id)) return;
      ctx.logger.info(`mcp-manager: reconnecting ${server.name}${immediate ? '' : ` (attempt ${attempt})`}`);
      void connect(server);
    }, delay);
    timer.unref?.();
    reconnectTimers.set(server.id, timer);
    const conn = live.get(server.id);
    if (conn) conn.reconnectInMs = delay;
  }
  // ---------- end reconnect ----------

  async function openServer(server) {
    if ((server.type ?? 'http') === 'stdio') return openStdio(server);
    return openHttp(server);
  }

  async function connect(server) {
    cancelReconnect(server.id); // a manual retry supersedes any queued one, but keeps the backoff count
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
      recordAttempt(server, { phase: 'tools/list', url: server.url ?? server.command ?? '', status: 200, detail: `${handle.tools.length} tools listed` });
      bindToolsChanged(server, handle, async () => {
        const tools = await listAllTools(handle);
        if (conn.handle !== handle || handle.closed) return;
        handle.tools = tools;
        registerToolsGlobal(server, conn, handle.tools);
      });
      // An SSE session dies with its stream. Without this the handle stays
      // "connected" while every call blocks until its timeout.
      handle.onStreamClosed = () => {
        if (conn.handle !== handle) return;          // already superseded
        ctx.logger.warn(`mcp-manager: ${server.name} SSE stream closed; reconnecting`);
        disposeRegistrations(conn.tools);
        conn.toolCount = 0;
        clearGlobalTools(server.name);
        conn.status = 'error';
        conn.error = 'SSE stream closed';
        scheduleReconnect(server, { immediate: true });
      };
      reconnectAttempts.delete(server.id);
      conn.reconnectInMs = 0;
    } catch (error) {
      disposeRegistrations(conn.tools);
      conn.toolCount = 0;
      try { conn.handle?.close?.(); } catch {}
      conn.handle = null;
      conn.transport = null;
      clearGlobalTools(server.name);
      conn.status = (server.type ?? 'http') !== 'stdio' && server.authMode === 'oauth' && !server.oauth?.tokens ? 'needs-auth' : 'error';
      conn.error = String(error?.message ?? error).slice(0, 300);
      if ((server.type ?? 'http') !== 'stdio') {
        recordAttempt(server, { phase: 'initialize', url: server.url, status: 0, detail: conn.error });
      }
      ctx.logger.warn(`mcp-manager: ${server.name} ${conn.status}: ${conn.error}`);
      // needs-auth requires a browser round trip; retrying it would just spin.
      if (conn.status !== 'needs-auth') scheduleReconnect(server);
    }
    return conn;
  }

  function disconnect(serverId) {
    cancelReconnect(serverId, { resetAttempts: true });
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
    const authMode = normalizeAuthMode(cfg.authMode);
    const server = { id: `ws-${b64url(randomBytes(8))}`, name, type: 'http', url, authMode, headers: parseEnv(cfg.headers), headerEnv: parseEnv(cfg.headerEnv) };
    if (authMode === 'static') {
      server.tokenEnv = String(cfg.tokenEnv ?? '').trim();
    } else if (authMode === 'oauth') {
      // Hand-written configs may carry the manual client credentials too.
      try { applyOauthFields(server, parseOauthFields(cfg)); } catch { /* ignore invalid optional fields */ }
    }
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
      entry.authMode = normalizeAuthMode(body?.authMode);
      entry.headers = parseEnv(body?.headers);
      entry.headerEnv = parseEnv(body?.headerEnv);
      if (entry.authMode === 'static') {
        entry.tokenEnv = String(body?.tokenEnv ?? '').trim();
      } else if (entry.authMode === 'oauth') {
        let fields;
        try { fields = parseOauthFields(body ?? {}); } catch (error) { return { error: error?.message ?? String(error) }; }
        if (fields.clientId) entry.clientId = fields.clientId;
        if (fields.clientSecretEnv) entry.clientSecretEnv = fields.clientSecretEnv;
        if (fields.scope) entry.scope = fields.scope;
      }
    }
    return { name, entry };
  }

  function sameServerConfig(a, b) {
    const norm = (s) => JSON.stringify({
      type: s.type ?? 'http',
      url: s.url ?? '',
      authMode: s.authMode ?? '',
      tokenEnv: s.tokenEnv ?? '',
      clientId: s.clientId ?? '',
      clientSecretEnv: s.clientSecretEnv ?? '',
      scope: s.scope ?? '',
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
      v.clientId = server.clientId ?? '';
      v.clientSecretEnv = server.clientSecretEnv ?? '';
      v.scope = server.scope ?? '';
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
      view.clientId = server.clientId ?? '';
      view.clientSecretEnv = server.clientSecretEnv ?? '';
      view.scope = server.scope ?? '';
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
    return async (agentCtx, explicitAgent) => {
      const agent = resolveSetupAgent(agentCtx, explicitAgent);
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
      return (await callerSetup?.(agentCtx, agent)) ?? undefined;
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

  // Normalize an env payload (object, `[{name,value}]` list, or JSON string) into
  // a flat string->string map.
  function parseEnv(env) {
    if (Array.isArray(env)) return parseEnv(normalizeEnvPairs(env));
    if (env && typeof env === 'object') {
      const out = {};
      for (const k of Object.keys(env)) out[k] = String(env[k] ?? '');
      return out;
    }
    if (typeof env === 'string' && env.trim()) {
      try {
        const o = JSON.parse(env);
        if (o && typeof o === 'object') return parseEnv(o);
      } catch {}
    }
    return {};
  }

  const routeDefinition = {
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
            const authMode = normalizeAuthMode(body.authMode);
            if (!/^https?:\/\//.test(serverUrl)) return json(res, 400, { error: 'url must be an http(s) URL' });
            let oauthFields = null;
            if (authMode === 'oauth') {
              try { oauthFields = parseOauthFields(body); } catch (error) { return json(res, 400, { error: error?.message ?? String(error) }); }
            }
            server = {
              id: b64url(randomBytes(8)),
              name, type: 'http', url: serverUrl, authMode,
              headers: parseEnv(body.headers),
              headerEnv: parseEnv(body.headerEnv),
              ...(authMode === 'static' ? { tokenEnv: String(body.tokenEnv ?? '').trim() } : {}),
            };
            if (oauthFields) applyOauthFields(server, oauthFields);
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
          if (req.method === 'GET' && action === '/logs') {
            return json(res, 200, { logs: readAttempts(server.id) });
          }
          if (req.method === 'POST' && action === '/auth') {
            if (server.authMode !== 'oauth') return json(res, 400, { error: 'only HTTP OAuth servers need authorization' });
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
                authMode: normalizeAuthMode(body.authMode),
                headers: parseEnv(body.headers),
                headerEnv: parseEnv(body.headerEnv),
              };
              if (next.authMode === 'static') {
                // 留空表示保留原有环境变量名(编辑表单只回填变量名,不回填实际值)
                next.tokenEnv = String(body.tokenEnv ?? '').trim() || server.tokenEnv || '';
              } else if (next.authMode === 'oauth') {
                // Empty means "keep the current value" (the form round-trips the
                // stored value, but a partial client must not silently wipe it).
                try { next.oauthFields = parseOauthFields(body, server); } catch (error) { return json(res, 400, { error: error?.message ?? String(error) }); }
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
              delete server.clientId; delete server.clientSecretEnv; delete server.scope;
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
                delete server.clientId; delete server.clientSecretEnv; delete server.scope;
              } else if (next.authMode === 'none') {
                // Unauthenticated: drop every credential, including a leftover
                // OAuth client registration/token, so nothing stale can be sent.
                delete server.tokenEnv;
                delete server.staticToken;
                delete server.oauth;
                delete server.clientId; delete server.clientSecretEnv; delete server.scope;
              } else {
                delete server.tokenEnv;
                delete server.staticToken;
                // The cache is keyed on the client identity and the issuer: a new
                // client id, secret source, or issuer invalidates it.
                let cacheKey = '';
                try {
                  cacheKey = JSON.stringify([server.clientId ?? '', server.clientSecretEnv ?? '', issuerOf(server)]);
                } catch {}
                applyOauthFields(server, next.oauthFields);
                let nextCacheKey = '';
                try {
                  nextCacheKey = JSON.stringify([server.clientId ?? '', server.clientSecretEnv ?? '', issuerOf(server)]);
                } catch {}
                if (previousType !== 'http' || previousAuthMode !== 'oauth' || previousIssuer !== (() => { try { return issuerOf({ url: next.url }); } catch { return ''; } })() || cacheKey !== nextCacheKey) {
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
            clearAttempts(server.id);
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
  };
  // The Settings → MCP UI needs the GUI webserver, but the agent-side tiers do
  // not. Mount the route when (and if) a webserver appears instead of declaring
  // a hard dependency: a profile without one (headless/tui) then keeps its MCP
  // tools, whereas newer harness builds fail the whole boot when an installed
  // entry never activates.
  ctx.effect(() => ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(routeDefinition));
  }).dispose);

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
    // Cancel queued reconnects first: their timers would otherwise fire after the
    // plugin is gone and try to reconnect against a torn-down ctx.
    for (const serverId of [...reconnectTimers.keys()]) cancelReconnect(serverId, { resetAttempts: true });
    reconnectAttempts.clear();
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
