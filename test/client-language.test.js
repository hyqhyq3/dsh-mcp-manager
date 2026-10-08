import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// Run the real module factory with a tiny hook harness; no browser or dependencies.
function mount(fetch, language = "en") {
  let dictionaries, spec, disposed = false;
  const effectLabels = [];
  const t = (key, values = {}) => (dictionaries[language]?.[key] ?? dictionaries.en[key] ?? key)
    .replace(/\{(\w+)\}/g, (match, name) => String(values[name] ?? match));
  let exported, Section;
  let states = [], cursor = 0, effects = [], initialized = false;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = value; }];
    },
    useEffect: (effect) => { if (!initialized) effects.push(effect); },
    useCallback: (callback) => callback,
  };
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { exported = factory(() => react); } } },
    fetch,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  let dispose;
  exported.apply({
    effect(fn, label) { effectLabels.push(label); dispose = fn(); },
    locale: {
      register(ns, table) {
        assert.equal(ns, 'mcp');
        dictionaries = table;
        return () => { disposed = true; };
      },
      bind(ns) { assert.equal(ns, 'mcp'); return t; },
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, component) => { spec = options; Section = component; },
    },
  });
  return {
    get dictionaries() { return dictionaries; },
    get spec() { return spec; },
    get inject() { return exported.inject; },
    effectLabels,
    dispose() { dispose(); assert.equal(disposed, true); },
    setLocale(next) { language = next; },
    render(component = Section, props = { t }) {
      cursor = 0;
      return component(props);
    },
    effects() { initialized = true; for (const effect of effects) effect(); effects = []; },
    reset() { states = []; },
  };
}
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function nodes(tree) {
  return tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
}
const text = (tree) => typeof tree === 'string' ? tree : tree?.children?.map(text).join(' ') ?? '';
const content = (tree) => nodes(tree).find((node) => typeof node.type === 'function');

it('registers balanced mcp dictionaries with effect cleanup and the locale slot seat', () => {
  const app = mount(async () => response({}));
  assert.deepEqual(Object.keys(app.dictionaries.zh).sort(), Object.keys(app.dictionaries.en).sort());
  assert.equal(app.spec.name, 'settings.section');
  assert.equal(app.spec.locale, 'mcp');
  assert.equal(app.spec.label(), 'MCP');
  assert.ok(app.inject.includes('locale'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'));
  assert.deepEqual(app.effectLabels, ['dsh-mcp-manager: dictionaries']);
  for (const key of [...source.matchAll(/\bt\("([\w-]+)"/g)].map((match) => match[1])) {
    for (const locale of ['zh', 'en']) assert.ok(app.dictionaries[locale][key], locale + ': ' + key);
  }
  assert.doesNotMatch(source.slice(source.indexOf('function api')), /\p{Script=Han}/u);
  assert.doesNotMatch(source, /STRINGS|translator|systemLanguage|navigator|settings\/language|mm_language/);
  app.dispose();
});

it('renders the injected t and follows locale changes without plugin language requests', async () => {
  const calls = [];
  const app = mount(async (url) => { calls.push(url); return response({}); });
  let tree = app.render();
  assert.match(text(tree), /MCP servers/);
  app.effects(); await settle();
  app.setLocale('zh');
  tree = app.render();
  assert.match(text(tree), /MCP 服务器/);
  assert.equal(calls.filter((url) => url.endsWith('/settings')).length, 1);
  assert.ok(calls.every((url) => !url.includes('/settings/language')));
  // An arbitrary standard-seat translator reaches the content and nested forms.
  tree = app.render(undefined, { t: (key) => 'seat:' + key });
  assert.match(text(tree), /seat:servers/);
  nodes(tree).find((node) => node.props['aria-label'] === 'seat:addServer').props.onClick();
  const form = content(app.render(undefined, { t: (key) => 'seat:' + key }));
  assert.equal(form.props.t('save'), 'seat:save');
});

it('renders English list, add form, and stdio fields using the same translator', async () => {
  const app = mount(async () => response({}));
  let tree = app.render();
  assert.match(text(tree), /MCP servers/);
  nodes(tree).find((node) => node.props['aria-label'] === 'Add MCP server').props.onClick();
  tree = app.render();
  assert.match(text(tree), /Add MCP server/);
  const form = content(tree);
  app.reset();
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /Authentication method/);
  assert.match(text(tree), /Headers from environment variables/);
  nodes(tree).find((node) => node.type === 'select' && node.props.value === 'http').props.onChange({ target: { value: 'stdio' } });
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /Command \(executable\)/);
  assert.match(text(tree), /Environment variables/);
});

it('offers a no-auth HTTP mode and hides the token field when selected', async () => {
  const app = mount(async () => response({}));
  let tree = app.render();
  nodes(tree).find((node) => node.props['aria-label'] === 'Add MCP server').props.onClick();
  tree = app.render();
  const form = content(tree);
  app.reset();
  tree = app.render(form.type, form.props);

  const authSelect = nodes(tree).find((node) => node.type === 'select' && node.props.value === 'oauth');
  assert.ok(authSelect, 'the authentication-method select renders');
  assert.deepEqual(authSelect.children.map((option) => option.props.value), ['oauth', 'static', 'none']);
  assert.match(text(tree), /No auth \(server needs no credentials\)/);
  assert.doesNotMatch(text(tree), /Bearer token environment variable/);

  // Static still asks for the env var name...
  authSelect.props.onChange({ target: { value: 'static' } });
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /Bearer token environment variable/);

  // ...while no-auth hides the credential field entirely.
  nodes(tree).find((node) => node.type === 'select' && node.props.value === 'static').props.onChange({ target: { value: 'none' } });
  tree = app.render(form.type, form.props);
  assert.match(text(tree), /No auth \(server needs no credentials\)/);
  assert.doesNotMatch(text(tree), /Bearer token environment variable/);
});

it('collects manual OAuth client credentials only while OAuth is selected', async () => {
  const app = mount(async () => response({}));
  let tree = app.render();
  nodes(tree).find((node) => node.props['aria-label'] === 'Add MCP server').props.onClick();
  tree = app.render();
  const form = content(tree);
  app.reset();
  tree = app.render(form.type, form.props);

  assert.match(text(tree), /OAuth Client ID/);
  assert.match(text(tree), /Client secret environment variable name/);
  assert.match(text(tree), /Scope \(optional/);
  const inputs = nodes(tree).filter((node) => node.type === 'input');
  const clientIdInput = inputs.find((node) => node.props.placeholder === 'Ov23li…');
  const secretInput = inputs.find((node) => node.props.placeholder === 'GITHUB_OAUTH_CLIENT_SECRET');
  const scopeInput = inputs.find((node) => node.props.placeholder === 'repo read:org');
  assert.ok(clientIdInput && secretInput && scopeInput, 'all three OAuth fields render');
  clientIdInput.props.onChange({ target: { value: 'my-client' } });
  secretInput.props.onChange({ target: { value: 'MY_SECRET_ENV' } });
  scopeInput.props.onChange({ target: { value: 'repo' } });
  tree = app.render(form.type, form.props);

  // Switching to a non-OAuth mode hides them again.
  nodes(tree).find((node) => node.type === 'select' && node.props.value === 'oauth').props.onChange({ target: { value: 'none' } });
  tree = app.render(form.type, form.props);
  assert.doesNotMatch(text(tree), /OAuth Client ID/);
  assert.doesNotMatch(text(tree), /Client secret environment variable name/);
});

it('shows a collapsed connection error and lazily loads the attempt log', async () => {
  const calls = [];
  const server = { id: 'srv-1', name: 'github', type: 'http', url: 'https://api.githubcopilot.com/mcp/', authMode: 'oauth', status: 'error', error: 'client registration failed: HTTP 404 — this authorization server may not support dynamic client registration', toolCount: 0, enabled: true };
  const app = mount(async (url) => {
    calls.push(url);
    if (url.endsWith('/servers')) return response({ servers: [server] });
    if (url.endsWith('/workspaces')) return response({ workspaces: [] });
    if (url.endsWith('/settings')) return response({ onDemandToolInjection: false });
    if (url.endsWith('/servers/srv-1/logs')) return response({ logs: [{ at: 1700000000000, phase: 'discovery', url: 'https://github.com/.well-known/oauth-authorization-server/login/oauth', status: 200, detail: 'authorization server metadata' }] });
    return response({});
  });
  let tree = app.render();
  app.effects(); await settle();
  tree = app.render();

  const cardNode = (t) => nodes(t).find((node) => node.props?.server?.id === 'srv-1');
  const renderCard = (node) => { app.reset(); return app.render(node.type, node.props); };

  // The reason is visible without expanding the card...
  const collapsed = renderCard(cardNode(tree));
  assert.match(text(collapsed), /may not support dynamic client registration/);
  assert.doesNotMatch(text(collapsed), /Logs/, 'the log toggle lives in the expanded card');
  assert.ok(!calls.some((url) => url.endsWith('/logs')), 'logs must not be fetched until requested');

  // ...and expanding the card reveals the lazily-loaded log panel.
  const expanded = renderCard({ type: cardNode(tree).type, props: { ...cardNode(tree).props, open: true } });
  assert.match(text(expanded), /may not support dynamic client registration/, 'the reason stays visible while expanded');
  const logNode = nodes(expanded).find((node) => node.props?.serverId === 'srv-1');
  assert.ok(logNode, 'the log panel renders once expanded');

  // The panel itself is collapsed until toggled, then fetches on demand.
  const logProps = { ...logNode.props, key: 'logs' };
  let log = renderCard({ type: logNode.type, props: logProps });
  assert.match(text(log), /Logs/);
  assert.doesNotMatch(text(log), /No log entries yet/, 'the log body is hidden until toggled');
  assert.ok(!calls.some((url) => url.endsWith('/logs')), 'opening the card alone must not fetch the log');
  nodes(log).find((node) => node.props.className === 'mm_logToggle').props.onClick();
  await settle();
  log = app.render(logNode.type, logProps);
  assert.ok(calls.some((url) => url.endsWith('/servers/srv-1/logs')), 'the toggle must fetch the log');
  assert.match(text(log), /authorization server metadata/);
});

