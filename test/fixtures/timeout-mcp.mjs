import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function result(message, handshakeDelay = 0) {
  if (message.method === 'initialize') {
    await sleep(handshakeDelay);
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'timeout-fixture', version: '1' } };
  }
  if (message.method === 'tools/list') {
    await sleep(handshakeDelay);
    return { tools: [{ name: 'wait', inputSchema: { type: 'object', properties: { delayMs: { type: 'number' }, holdPost: { type: 'boolean' } } } }] };
  }
  await sleep(message.params?.arguments?.delayMs ?? 0);
  return { content: [{ type: 'text', text: 'finished' }] };
}

export async function startTimeoutMcp({ sse = false, handshakeDelay = 0 } = {}) {
  const streams = new Map();
  const timers = new Set();
  let sessions = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && sse) {
      const id = String(++sessions);
      streams.set(id, res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
      req.on('close', () => streams.delete(id));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (sse && !url.searchParams.has('sessionId')) {
      res.writeHead(400); res.end('sessionId query parameter is not provided'); return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    if (message.params?.arguments?.holdPost) return;
    if (sse) { res.writeHead(202); res.end(); }
    // Make fixture shutdown cancel long-running replies as well as sockets.
    const delay = message.method === 'tools/call' ? message.params?.arguments?.delayMs ?? 0 : handshakeDelay;
    const timer = setTimeout(async () => {
      timers.delete(timer);
      const reply = { jsonrpc: '2.0', id: message.id, result: await result({ ...message, params: { ...message.params, arguments: { delayMs: 0 } } }) };
      if (sse) {
        const stream = streams.get(url.searchParams.get('sessionId'));
        if (stream && !stream.destroyed) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      } else if (!res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      }
    }, delay);
    timers.add(timer);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/${sse ? 'sse' : 'mcp'}`,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const stream of streams.values()) stream.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[2] === '--stdio' && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', async line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = await result(message, Number(process.argv[3] ?? 0));
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: reply }) + '\n');
  });
}
