// Real Loader/registry verification of >60s tools; no model or external MCP.
// Usage: node scripts/verify-timeout-dsh.mjs <temporary DSH npm prefix> [evidence.json]
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

assert.ok(process.argv[2], 'Supply a temporary npm prefix containing DSH');
const runtime = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version;
assert.equal(version, '0.2.1-rc.2');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-timeout-real-'));
const workspace = join(scratch, 'workspace'); mkdirSync(workspace);
const fixtureUrl = new URL('../test/fixtures/timeout-mcp.mjs', import.meta.url).href;
const verifier = join(scratch, 'verify.mjs');
const expected = readFileSync(new URL('../test/fixtures/tool-timeout.snapshot.json', import.meta.url), 'utf8');
writeFileSync(verifier, readFileSync(new URL('./fixtures/timeout-dsh-verifier.mjs', import.meta.url), 'utf8')
  .replaceAll('__SCRATCH__', JSON.stringify(scratch)).replaceAll('__VERSION__', JSON.stringify(version))
  .replaceAll('__MCP_FIXTURE__', JSON.stringify(fixtureUrl)).replaceAll('__EXPECTED__', expected));
const patch = join(scratch, 'smoke.yml');
const host = fileURLToPath(new URL('../lib/index.js', import.meta.url));
writeFileSync(patch, `- insert:\n    - id: timeout-manager\n      name: ${JSON.stringify(host)}\n      config:\n        toolCallTimeoutMs: 1000\n    - id: timeout-verifier\n      name: ${JSON.stringify(verifier)}\n`);
let output = '';
const child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--no-open', '--port', '0'], {
  cwd: workspace,
  env: { ...process.env, HOME: scratch, USERPROFILE: scratch, DSH_HOME: join(scratch, '.dsh'), DEEPSEEK_API_KEY: '', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => output += chunk);
child.stderr.on('data', chunk => output += chunk);
const exit = new Promise(resolveExit => child.once('exit', resolveExit));
child.on('error', error => { output += error.stack; });
try {
  const end = Date.now() + 120000;
  while (!existsSync(join(scratch, 'result.json')) && Date.now() < end && child.exitCode === null) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.ok(existsSync(join(scratch, 'result.json')), `Timeout verification did not finish:\n${output}`);
  const result = JSON.parse(readFileSync(join(scratch, 'result.json')));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
