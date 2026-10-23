// Keyless real Loader + agent + registry + Node PTC runtime verification.
// Usage: node scripts/verify-broker-dsh.mjs <temporary npm prefix> [evidence.json]
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

assert.ok(process.argv[2], 'Supply a temporary npm prefix containing DSH');
const runtime = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version;
assert.ok(['0.2.0-rc.2', '0.2.1-rc.2'].includes(version), `Unverified host ${version}`);
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-broker-real-'));
const workspace = join(scratch, 'workspace');
mkdirSync(workspace);
const resultPath = join(scratch, 'result.json');
const verifier = join(scratch, 'verify.mjs');
const fixture = fileURLToPath(new URL('./fixtures/broker-dsh-verifier.mjs', import.meta.url));
const expected = readFileSync(new URL('../test/fixtures/broker-presentation.snapshot.json', import.meta.url), 'utf8');
writeFileSync(verifier, readFileSync(fixture, 'utf8').replaceAll('__SCRATCH__', JSON.stringify(scratch)).replaceAll('__VERSION__', JSON.stringify(version)).replaceAll('__EXPECTED__', expected));
const patch = join(scratch, 'smoke.yml');
const host = fileURLToPath(new URL('../lib/index.js', import.meta.url));
writeFileSync(patch, `- insert:\n    - id: broker-manager\n      name: ${JSON.stringify(host)}\n    - id: broker-verifier\n      name: ${JSON.stringify(verifier)}\n`);
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
  assert.ok(existsSync(resultPath), `Broker verification did not finish:\n${output}`);
  const result = JSON.parse(readFileSync(resultPath));
  assert.equal(result.ok, true, `${result.error}\n${output}`);
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(result, null, 2) + '\n');
} finally {
  child.kill('SIGTERM');
  await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await exit; }
  rmSync(scratch, { recursive: true, force: true });
}
