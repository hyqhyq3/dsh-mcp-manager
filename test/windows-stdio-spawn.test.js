/**
 * Windows-only integration: real child_process spawn through the same spec
 * shape as lib/index.js spawnStdio (windowsNeedsShell / windowsShellSpec).
 * Linux CI skips the file via describe.skip.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, it, after } from 'node:test';
import { buildWindowsCmdLine, windowsNeedsShell, windowsShellSpec } from '../lib/index.js';

const isWin = process.platform === 'win32';
const describeWin = isWin ? describe : describe.skip;

const argvFixture = fileURLToPath(new URL('./fixtures/win-record-argv.mjs', import.meta.url));

/** Mirror spawnStdio's Windows branch (no shell: true). */
function winSpawnSpec(server) {
  return windowsNeedsShell(server.command)
    ? windowsShellSpec(server.command, server.args ?? [])
    : { command: server.command, args: server.args ?? [], verbatim: false };
}

function runWinSpawn(server, timeoutMs = 8000) {
  const spec = winSpawnSpec(server);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: server.cwd || process.cwd(),
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments: spec.verbatim === true,
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`spawn timed out after ${timeoutMs}ms; stderr: ${stderr.slice(-500)}`));
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}; stderr: ${stderr.slice(-500)}`));
      else resolve();
    });
  });
}

describeWin('Windows stdio spawn (integration)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-mm-win-spawn-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('spawns node.exe directly and preserves arguments', async () => {
    const out = join(scratch, 'direct.json');
    await runWinSpawn({
      command: process.execPath,
      args: [argvFixture, 'plain', 'a b', 'c&d'],
      env: { WIN_ARG_OUT: out },
    });
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['plain', 'a b', 'c&d']);
  });

  it('routes a .cmd shim through cmd.exe with spaces and metacharacters intact', async () => {
    const shimDir = join(scratch, 'shim dir');
    const shim = join(shimDir, 'record.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${argvFixture}" %*\r\n`, 'utf8');
    const out = join(scratch, 'shim.json');
    await runWinSpawn({
      command: shim,
      args: ['-y', 'pkg name', 'a&b', 'c|d'],
      cwd: scratch,
      env: { WIN_ARG_OUT: out },
    });
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), ['-y', 'pkg name', 'a&b', 'c|d']);
    assert.equal(windowsNeedsShell(shim), true);
  });

  it('rejects cmd-literal tokens before spawn (no marker file)', async () => {
    const marker = join(scratch, 'inj-marker.txt');
    if (existsSync(marker)) rmSync(marker);
    assert.throws(() => buildWindowsCmdLine('npx', ['x" & type nul > "' + marker.replace(/\\/g, '\\\\') + '" & "y']), /cannot pass/);
    assert.equal(existsSync(marker), false, 'rejection must happen before any child runs');
    const cmdLine = (() => {
      try {
        return buildWindowsCmdLine('npx', ['safe', '%PATH%']);
      } catch { return null; }
    })();
    assert.equal(cmdLine, null);
    assert.equal(existsSync(marker), false);
  });

  it('uses /d /s /c with verbatim quoting for .cmd servers', () => {
    const spec = windowsShellSpec(join(scratch, 'tool.cmd'), ['--flag', 'value with spaces']);
    assert.match(spec.args[3], /^"/);
    assert.equal(spec.verbatim, true);
    assert.equal(spec.command.toLowerCase().endsWith('cmd.exe') || spec.command.toLowerCase().endsWith('cmd'), true);
  });
});