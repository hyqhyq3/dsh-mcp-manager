// Keyless shipping-host verification through a real DSH Loader and web API.
// Usage: node scripts/verify-transport-redaction-dsh.mjs <DSH npm prefix> [evidence.json]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// This function is serialized into a test-only Loader plugin below.
async function verify(ctx) {
  const logs = [];
  // Observe the real structured logger; the web profile does not print host
  // warnings to stdout. An exporter also avoids depending on the UI log view.
  const disposeExporter = ctx.logger.exporter({
    levels: { default: 3 },
    export(message) { logs.push(message.args.map(String).join(' ')); },
  });
  const until = async predicate => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('redaction Loader condition timed out');
  };
  const token = `synthetic-credential-prefix-${'x'.repeat(700)}-end`;
  let stream;
  let refresh = false;
  let refreshRequests = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': ready\n\n');
      return;
    }
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      const msg = JSON.parse(raw);
      const bearer = String(req.headers.authorization).replace(/^Bearer /, '');
      assert.equal(bearer, token);
      const reason = JSON.stringify({ access_token: bearer, reason: 'rejected' });
      res.writeHead(req.url === '/bad' ? 400 : 200, { 'Content-Type': 'application/json' });
      if (req.url === '/bad') return res.end(reason);
      if (msg.method === 'tools/list' && refresh) {
        refreshRequests++;
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: reason } }));
      }
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'redaction', version: '1' } }
        : { tools: [] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ids = [];
  let api;
  try {
    await until(() => ctx.webServer.port);
    api = async (method, path, body) => {
      const response = await fetch(`${ctx.webServer.getOrigin()}/mcp-manager/api/${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.ok(response.ok, `API ${method} ${path}: HTTP ${response.status}`);
      return response.json();
    };
    await until(async () => { try { return (await api('GET', 'ping')).ok; } catch { return false; } });
    process.env.DSH_REDACTION_TEST_TOKEN = token;
    for (const name of ['bad', 'live']) {
      const created = await api('POST', 'servers', {
        name, type: 'http', url: `http://127.0.0.1:${server.address().port}/${name}`,
        authMode: 'static', tokenEnv: 'DSH_REDACTION_TEST_TOKEN',
      });
      ids.push(created.server.id);
      await api('POST', `servers/${created.server.id}/connect`);
    }
    const rows = (await api('GET', 'servers')).servers;
    const bad = rows.find(row => row.name === 'bad');
    assert.equal(bad.status, 'error');
    assert.equal(rows.find(row => row.name === 'live').status, 'connected');
    const attempts = (await api('GET', `servers/${bad.id}/logs`)).logs;
    const attempt = attempts.find(entry => entry.phase === 'initialize').detail;
    await until(() => stream);
    refresh = true;
    stream.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n');
    await until(() => refreshRequests === 1);
    await until(() => logs.some(line => line.includes('refreshing tools for live')));
    assert.equal(logs.some(line => line.includes('synthetic-credential-prefix')), false);
    return { initialize: bad.error, attempt, refreshRequests, hostWarning: logs.find(line => line.includes('refreshing tools for live')) };
  } finally {
    for (const id of ids) await api('DELETE', `servers/${id}`).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    disposeExporter();
  }
}

assert.ok(process.argv[2], 'Supply an npm prefix containing @deepseek-ai/dsh');
const runtime = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version;
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-redaction-loader-'));
const workspace = join(scratch, 'workspace');
mkdirSync(workspace);
const resultPath = join(scratch, 'result.json');
const verifierPath = join(scratch, 'verify.mjs');
writeFileSync(verifierPath, `import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
export const inject = ['webServer'];
${verify.toString()}
export function apply(ctx) {
  void verify(ctx).then(result => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ok: true, result })),
    error => writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ok: false, error: error.stack })));
}
`);
const patchPath = join(scratch, 'smoke.yml');
const hostPath = fileURLToPath(new URL('../lib/index.js', import.meta.url));
writeFileSync(patchPath, `- insert:\n    - id: redaction-manager\n      name: ${JSON.stringify(hostPath)}\n    - id: redaction-verifier\n      name: ${JSON.stringify(verifierPath)}\n`);
let output = '';
const child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patchPath, '--no-open', '--port', '0'], {
  cwd: workspace,
  env: { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'), DEEPSEEK_API_KEY: '', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);
child.on('error', error => output += error.stack);
const exit = new Promise(resolve => child.once('exit', resolve));
const safeOutput = () => output.replace(/([?&]token=)[^&\s]*/g, '$1<redacted>');
try {
  const end = Date.now() + 45000;
  while (!existsSync(resultPath) && Date.now() < end && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(existsSync(resultPath), `Loader verification did not finish:\n${safeOutput()}`);
  const evidence = JSON.parse(readFileSync(resultPath));
  assert.equal(evidence.ok, true, `${evidence.error}\n${safeOutput()}`);
  const expected = JSON.parse(readFileSync(new URL('../test/fixtures/transport-redaction.snapshot.json', import.meta.url)));
  assert.deepEqual(evidence.result, expected);
  assert.equal(output.includes('synthetic-credential-prefix'), false, 'host log must not contain the synthetic credential prefix');
  const result = { ...evidence, dsh: version, node: process.version, platform: process.platform, hostWarningRedacted: true };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
