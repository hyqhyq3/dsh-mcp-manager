// Keyless real Loader + agents + system-prompt verification of the on-demand
// broker on DSH 0.2.x, where the waterfall no longer receives the tool list.
// Usage: node scripts/verify-deferral-dsh.mjs <npm prefix containing @deepseek-ai/dsh>
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

assert.ok(process.argv[2], 'Supply an npm prefix containing @deepseek-ai/dsh');
const runtime = resolve(process.argv[2]);
const pkgPath = join(runtime, 'node_modules/@deepseek-ai/dsh/package.json');
const version = JSON.parse(readFileSync(pkgPath)).version;
assert.ok(/^0\.2\./.test(version), `Unverified host ${version}`);

const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-deferral-real-'));
const workspace = join(scratch, 'workspace');
mkdirSync(workspace);
const resultPath = join(scratch, 'result.json');
const verifier = join(scratch, 'verify.mjs');
const fixture = fileURLToPath(new URL('./fixtures/deferral-dsh-verifier.mjs', import.meta.url));
writeFileSync(verifier, readFileSync(fixture, 'utf8')
  .replaceAll('__SCRATCH__', JSON.stringify(scratch))
  .replaceAll('__VERSION__', JSON.stringify(version))
  .replaceAll('__DSH_ROOT__', JSON.stringify(join(runtime, 'node_modules/@deepseek-ai/dsh'))));
const patch = join(scratch, 'smoke.yml');
const host = fileURLToPath(new URL('../lib/index.js', import.meta.url));
writeFileSync(patch, `- insert:\n    - id: deferral-manager\n      name: ${JSON.stringify(host)}\n    - id: deferral-verifier\n      name: ${JSON.stringify(verifier)}\n`);

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
  const end = Date.now() + 90000;
  while (!existsSync(resultPath) && Date.now() < end && child.exitCode === null) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.ok(existsSync(resultPath), `Deferral verification did not finish:\n${output}`);
  const result = JSON.parse(readFileSync(resultPath));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  console.log(JSON.stringify(result));
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
