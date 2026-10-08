import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// STATE_PATH is derived from homedir() when the module is evaluated, so point
// HOME at a scratch directory *before* the dynamic import below.
const scratchHome = mkdtempSync(join(tmpdir(), 'dsh-mcp-manager-search-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome;
process.env.DSH_HOME = scratchHome;

const {
  apply,
  expandSearchTerms,
  searchToolEntries,
  stemSearchToken,
  tokenizeSearchText,
} = await import('../lib/index.js');

/** One broker catalog entry as the search tool sees it. */
function catalogEntry(server, tool, description) {
  return { name: 'mcp__' + server + '__' + tool, server, tool, description };
}

describe('tokenizeSearchText', () => {
  it('splits camelCase boundaries', () => {
    const tokens = tokenizeSearchText('getUserInfo');
    for (const expected of ['get', 'user', 'info']) assert.ok(tokens.includes(expected), expected);
  });

  it('splits snake_case and kebab-case and keeps the stem', () => {
    assert.deepEqual(tokenizeSearchText('query_thor-logs'), ['query', 'thor', 'logs', 'log']);
  });

  it('normalizes full-width characters', () => {
    assert.deepEqual(tokenizeSearchText('ｌｏｇ'), ['log']);
  });

  it('emits CJK unigrams and bigrams', () => {
    const tokens = tokenizeSearchText('查日志');
    for (const expected of ['查', '日', '志', '查日', '日志']) assert.ok(tokens.includes(expected), expected);
  });

  it('keeps a stopword-only query searchable instead of emptying it', () => {
    assert.deepEqual(tokenizeSearchText('the'), ['the']);
  });

  it('returns no tokens for punctuation-only input', () => {
    assert.deepEqual(tokenizeSearchText('???'), []);
  });
});

describe('stemSearchToken', () => {
  it('strips plurals and common verb endings', () => {
    assert.equal(stemSearchToken('logs'), 'log');
    assert.equal(stemSearchToken('queries'), 'query');
    assert.equal(stemSearchToken('running'), 'runn');
    assert.equal(stemSearchToken('tested'), 'test');
  });

  it('leaves short words and non-plural s-endings alone', () => {
    assert.equal(stemSearchToken('bus'), 'bus');
    assert.equal(stemSearchToken('status'), 'status');
    assert.equal(stemSearchToken('is'), 'is');
  });
});

describe('expandSearchTerms', () => {
  it('adds alias terms at a lower weight and keeps originals at weight 1', () => {
    const weights = new Map(expandSearchTerms(tokenizeSearchText('查日志')).map((term) => [term.term, term.weight]));
    assert.equal(weights.get('日志'), 1);
    for (const alias of ['log', 'logs', 'logging']) assert.equal(weights.get(alias), 0.5, alias);
  });

  it('expands a stemmed surface form through its alias group', () => {
    const terms = new Set(expandSearchTerms(['queries']).map((term) => term.term));
    assert.ok(terms.has('queries'));
    assert.ok(terms.has('search'));
  });
});

const thorCatalog = [
  catalogEntry('thor', 'query_logs', 'Query thor logs by service and time range.'),
  catalogEntry('odin', 'deploy_service', 'Deploy a service to the cluster.'),
];

describe('searchToolEntries', () => {
  it('finds an English-described tool from a Chinese query through aliases', () => {
    const result = searchToolEntries(thorCatalog, { query: '查日志' });
    assert.equal(result.total, 1);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].name, 'mcp__thor__query_logs');
  });

  it('ranks a tool-name hit above a description-only hit', () => {
    const entries = [
      catalogEntry('b', 'other', 'search logs quickly'),
      catalogEntry('a', 'search_logs', 'noop helper'),
    ];
    const result = searchToolEntries(entries, { query: 'search' });
    assert.equal(result.matches[0].name, 'mcp__a__search_logs');
  });

  it('tolerates a misspelled token with bounded edit distance', () => {
    const entries = [catalogEntry('k8s', 'list_pods', 'List pods in a kubernetes cluster.')];
    const result = searchToolEntries(entries, { query: 'kubernetis' });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].name, 'mcp__k8s__list_pods');
  });

  it('lists and sorts the catalog when the query is omitted', () => {
    const result = searchToolEntries(thorCatalog, {});
    assert.equal(result.query, '');
    assert.equal(result.total, 2);
    assert.deepEqual(result.matches.map((match) => match.server), ['odin', 'thor']);
    for (const match of result.matches) assert.equal(match.score, 0);
  });

  it('applies the server filter in browse mode, case-insensitively', () => {
    const result = searchToolEntries(thorCatalog, { server: 'THOR' });
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].server, 'thor');
  });

  it('clamps the limit and reports the pre-truncation total', () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      catalogEntry('s', 'tool_' + String(index).padStart(2, '0'), 'shared description'));
    const result = searchToolEntries(entries, { query: 'shared', limit: 999 });
    assert.equal(result.matches.length, 50);
    assert.equal(result.total, 60);
    assert.equal(searchToolEntries(entries, { query: 'shared', limit: 0 }).matches.length, 1);
  });

  it('returns no matches for a punctuation-only query instead of browsing', () => {
    const result = searchToolEntries(thorCatalog, { query: '???' });
    assert.deepEqual(result.matches, []);
    assert.equal(result.total, 0);
  });

  it('is deterministic', () => {
    assert.deepEqual(
      searchToolEntries(thorCatalog, { query: 'deploy log' }),
      searchToolEntries(thorCatalog, { query: 'deploy log' }),
    );
  });

  it('returns an empty result for an empty catalog', () => {
    assert.deepEqual(searchToolEntries([], { query: 'anything' }), { query: 'anything', total: 0, matches: [] });
    assert.deepEqual(searchToolEntries([], {}), { query: '', total: 0, matches: [] });
  });
});

/** Mount the plugin on a stub ctx that records the registered tool definitions. */
function mountBroker(catalogSchemas) {
  const registered = new Map();
  const disposers = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      restrict: () => () => {},
      guard: () => () => {},
      schemas: () => catalogSchemas,
      get: () => undefined,
      execute: async () => ({ content: [] }),
    },
    webServer: { register: () => () => {} },
    get: () => undefined,
    on: () => () => {},
    inject: () => ({ dispose: () => {} }),
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
  };
  apply(ctx);
  return {
    registered,
    dispose: () => { for (const fn of disposers.reverse()) { try { fn(); } catch {} } },
  };
}

describe('mcp_search_tools broker wiring', () => {
  it('searches and browses the live agent catalog through the registered tool', async (t) => {
    mkdirSync(join(scratchHome, '.dsh'), { recursive: true });
    writeFileSync(join(scratchHome, '.dsh', 'mcp-manager.json'), JSON.stringify({ servers: [], onDemandToolInjection: true }));
    const schemas = [
      { name: 'mcp__thor__query_logs', description: 'Query thor logs by service and time range.' },
      { name: 'mcp__odin__deploy_service', description: 'Deploy a service to the cluster.' },
    ];
    const { registered, dispose } = mountBroker(schemas);
    t.after(dispose);
    const search = registered.get('mcp_search_tools');
    assert.ok(search, 'on-demand mode must register mcp_search_tools');

    const browsed = await search.execute({}, { agent: {} });
    assert.deepEqual(Object.keys(browsed).sort(), ['matches', 'query', 'total']);
    assert.equal(browsed.total, 2);
    assert.deepEqual(browsed.matches.map((match) => match.name), [
      'mcp__odin__deploy_service',
      'mcp__thor__query_logs',
    ]);
    for (const match of browsed.matches) {
      assert.deepEqual(Object.keys(match).sort(), ['description', 'name', 'score', 'server', 'tool']);
      assert.equal(match.score, 0);
    }

    const found = await search.execute({ query: '查日志' }, { agent: {} });
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].name, 'mcp__thor__query_logs');
    assert.ok(Number.isInteger(found.matches[0].score) && found.matches[0].score > 0);
  });
});
