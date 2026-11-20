import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { migrateLoadedState, normalizeEnvPairs, buildWindowsCmdLine, windowsNeedsShell, windowsShellSpec } from '../lib/index.js';

describe('normalizeEnvPairs (legacy [{ name, value }] support)', () => {
  it('converts the legacy list into a flat map', () => {
    assert.deepEqual(
      normalizeEnvPairs([{ name: 'UV_CACHE_DIR', value: '/tmp/uv' }, { name: 'A', value: '1' }]),
      { UV_CACHE_DIR: '/tmp/uv', A: '1' },
    );
  });

  it('accepts { key, value } entries and coerces values to strings', () => {
    assert.deepEqual(normalizeEnvPairs([{ key: 'N', value: 2 }]), { N: '2' });
    assert.deepEqual(normalizeEnvPairs([{ name: 'E', value: undefined }]), { E: '' });
  });

  it('drops entries without a usable name', () => {
    assert.deepEqual(normalizeEnvPairs([{ value: 'x' }, null, 'nope', 7, { name: '', value: 'x' }]), {});
  });

  it('passes the current object form through and rejects anything else', () => {
    const object = { A: '1' };
    assert.equal(normalizeEnvPairs(object), object);
    assert.deepEqual(normalizeEnvPairs(undefined), {});
    assert.deepEqual(normalizeEnvPairs('A=1'), {});
  });
});

describe('migrateLoadedState', () => {
  it('backfills a missing id on every legacy server', () => {
    const state = { servers: [{ name: 'docker' }, { name: 'github' }, { name: 'github-write' }] };
    let assigned = 0;
    const changed = migrateLoadedState(state, () => `id-${++assigned}`);
    assert.equal(changed, true);
    // Distinct ids are what keep the live-status map from cross-wiring errors.
    assert.deepEqual(state.servers.map((server) => server.id), ['id-1', 'id-2', 'id-3']);
  });

  it('keeps existing unique ids and assigns only the missing ones', () => {
    const state = { servers: [{ id: 'keep', name: 'a' }, { name: 'b' }] };
    assert.equal(migrateLoadedState(state, () => 'fresh'), true);
    assert.deepEqual(state.servers.map((server) => server.id), ['keep', 'fresh']);
  });

  it('reassigns a duplicated id so status can no longer cross over', () => {
    const state = { servers: [{ id: 'dup', name: 'a' }, { id: 'dup', name: 'b' }] };
    assert.equal(migrateLoadedState(state, () => 'new'), true);
    assert.deepEqual(state.servers.map((server) => server.id), ['dup', 'new']);
  });

  it('normalizes legacy env/header arrays in place', () => {
    const state = {
      servers: [{
        id: 'a',
        env: [{ name: 'UV_CACHE_DIR', value: '/tmp/uv' }],
        headers: [{ name: 'X-Tenant', value: 't1' }],
        headerEnv: [],
      }],
    };
    assert.equal(migrateLoadedState(state), true);
    assert.deepEqual(state.servers[0].env, { UV_CACHE_DIR: '/tmp/uv' });
    assert.deepEqual(state.servers[0].headers, { 'X-Tenant': 't1' });
    assert.deepEqual(state.servers[0].headerEnv, {});
  });

  it('reports no change for an already-migrated state', () => {
    const state = { servers: [{ id: 'a', env: { A: '1' } }], workspaceTokens: {} };
    assert.equal(migrateLoadedState(state), false);
  });

  it('tolerates malformed servers and a missing list', () => {
    assert.equal(migrateLoadedState({}), false);
    assert.equal(migrateLoadedState(undefined), false);
    assert.equal(migrateLoadedState({ servers: { nope: true } }), false);
    const state = { servers: [null, 'nope', { id: 'ok' }] };
    assert.equal(migrateLoadedState(state), false);
    assert.equal(state.servers[2].id, 'ok');
  });
});

describe('buildWindowsCmdLine (cmd.exe command line for .cmd/.bat shims)', () => {
  it('quotes tokens containing whitespace or cmd metacharacters', () => {
    assert.equal(
      buildWindowsCmdLine('C:\\Users\\me\\AppData\\Local\\GitHub CLI\\extensions\\gh-mcp.cmd'),
      '"C:\\Users\\me\\AppData\\Local\\GitHub CLI\\extensions\\gh-mcp.cmd"',
    );
    assert.equal(buildWindowsCmdLine('npx', ['-y', 'a b', 'plain']), 'npx -y "a b" plain');
    assert.equal(buildWindowsCmdLine('cmd', ['a&b', 'c|d', '(e)']), 'cmd "a&b" "c|d" "(e)"');
  });

  it('refuses tokens cmd.exe cannot treat literally instead of half-escaping them', () => {
    // `\"` is not an escape in cmd.exe, so a quote used to break out of the
    // quoted argument (the reported bypass) must be rejected.
    assert.throws(() => buildWindowsCmdLine('npx', ['x" & calc & "y']), /cannot pass/);
    assert.throws(() => buildWindowsCmdLine('npx', ['%PATH%']), /cannot pass/);
    assert.throws(() => buildWindowsCmdLine('npx', ['line\nbreak']), /cannot pass/);
    assert.throws(() => buildWindowsCmdLine('na"me'), /cannot pass/);
  });
});

describe('windowsNeedsShell (.cmd/.bat detection)', () => {
  const fileExists = (...present) => (path) => present.includes(path);

  it('routes explicit .cmd/.bat paths through cmd.exe and leaves .exe alone', () => {
    assert.equal(windowsNeedsShell('C:\\tools\\uvx.cmd'), true);
    assert.equal(windowsNeedsShell('C:\\tools\\uvx.BAT'), true);
    assert.equal(windowsNeedsShell('C:\\tools\\uvx.exe'), false);
    assert.equal(windowsNeedsShell('C:\\tools\\uvx'), false, 'CreateProcess appends .exe for an explicit path');
  });

  it('resolves a bare name by PATH then PATHEXT, dir-major', () => {
    // Paths are joined with the host separator, so build the expectations the
    // same way rather than hardcoding a Windows-only string.
    const options = (present) => ({ pathEnv: 'C:\\a;C:\\b', pathext: '.EXE;.CMD', pathDelimiter: ';', fileExists: fileExists(...present) });
    assert.equal(windowsNeedsShell('npx', options([join('C:\\b', 'npx.CMD')])), true);
    assert.equal(windowsNeedsShell('npx', options([join('C:\\a', 'npx.EXE'), join('C:\\b', 'npx.CMD')])), false, 'the first PATH hit wins');
    assert.equal(windowsNeedsShell('missing', options([])), false);
  });
});

describe('windowsShellSpec (cmd.exe invocation)', () => {
  it('wraps the line in the pair of quotes cmd /s unwraps and asks for verbatim arguments', () => {
    const spec = windowsShellSpec('npx', ['-y', 'a b']);
    // Node's own `shell: true` shape: the whole line in one pair of quotes.
    // Without `verbatim` Node would re-quote it and turn the inner `"` into the
    // `\"` cmd.exe does not understand.
    assert.deepEqual(spec.args, ['/d', '/s', '/c', '"npx -y "a b""']);
    assert.equal(spec.verbatim, true);
    assert.ok(spec.command);
  });
});
