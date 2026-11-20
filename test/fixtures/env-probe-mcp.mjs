/**
 * Stdio MCP fixture that records the environment it was spawned with.
 *
 * `MCP_ENV_PROBE` names the file to write; everything else is a minimal
 * JSON-RPC server so the connection can complete. Used to prove that
 * interpreter/loader hooks from a server config never reach the child.
 *
 * Like `timeout-mcp.mjs`, it does nothing unless started with `--stdio`, so
 * `node --test` loading every file under test/ does not hang on it.
 */
if (process.argv[2] === '--stdio') {
  const { writeFileSync } = await import('node:fs');
  if (process.env.MCP_ENV_PROBE) writeFileSync(process.env.MCP_ENV_PROBE, JSON.stringify(process.env));

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id === undefined) continue;
      const result = msg.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'env-probe', version: '1' } }
        : msg.method === 'tools/list' ? { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  });
}
