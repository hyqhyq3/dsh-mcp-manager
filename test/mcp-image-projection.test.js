import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mcpImageProjectionHandlers,
  renderBrokerExecuteResult,
  renderMcpResult,
} from '../lib/index.js';

const PNG = { type: 'image', data: 'AQ==', mimeType: 'image/png' };
const JPEG = { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' };

/** DSH history path: reads attachmentId/bytes on every image block. */
function dshConsume(blocks) {
  for (const block of blocks) {
    if (block?.type === 'image') {
      void block.attachment.attachmentId;
      void block.attachment.bytes;
    }
  }
}

function assertNoBareMcpImage(blocks) {
  assert.ok(Array.isArray(blocks), 'render must return a content array');
  assert.doesNotThrow(() => dshConsume(blocks));
  for (const block of blocks) {
    if (block?.type === 'image') {
      assert.ok(block.attachment, 'DSH image blocks need attachment');
      assert.notEqual(block.attachment.attachmentId, undefined);
      assert.notEqual(block.attachment.bytes, undefined);
    }
  }
}

describe('renderMcpResult (MCP tool output.render)', () => {
  it('does not forward a raw MCP image block without a DSH attachment', () => {
    const blocks = renderMcpResult({}, {
      text: '',
      content: [PNG],
      isError: false,
    });
    assertNoBareMcpImage(blocks);
  });

  it('keeps text blocks unchanged', () => {
    const blocks = renderMcpResult({}, {
      text: 'hello',
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    });
    assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }]);
  });

  it('keeps multiple text blocks as separate blocks', () => {
    const content = [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }];
    assert.deepEqual(renderMcpResult({}, { text: 'a\nb', content, isError: false }), content);
  });

  it('keeps ordered text around a projected image and stays DSH-safe', () => {
    const blocks = renderMcpResult({}, {
      text: 'before\nafter',
      content: [
        { type: 'text', text: 'before' },
        PNG,
        { type: 'text', text: 'after' },
      ],
      isError: false,
    });
    assertNoBareMcpImage(blocks);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[0].text, 'before');
    assert.equal(blocks.at(-1).type, 'text');
    assert.equal(blocks.at(-1).text, 'after');
  });

  it('falls back to value.text when content is empty', () => {
    const blocks = renderMcpResult({}, { text: 'only text', content: [], isError: false });
    assert.deepEqual(blocks, [{ type: 'text', text: 'only text' }]);
  });
});

describe('renderBrokerExecuteResult (mcp_execute_tool output.render)', () => {
  it('does not forward a nested raw MCP image block without a DSH attachment', () => {
    const blocks = renderBrokerExecuteResult({}, { content: [PNG, JPEG] });
    assertNoBareMcpImage(blocks);
  });

  it('keeps already-projected DSH image attachments', () => {
    const attached = {
      type: 'image',
      attachment: { attachmentId: 'sha256:aa', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    };
    const blocks = renderBrokerExecuteResult({}, { content: [{ type: 'text', text: 'ok' }, attached] });
    assert.deepEqual(blocks, [{ type: 'text', text: 'ok' }, attached]);
    assertNoBareMcpImage(blocks);
  });

  it('keeps text-only broker results', () => {
    const blocks = renderBrokerExecuteResult({}, { content: [{ type: 'text', text: 'done' }] });
    assert.deepEqual(blocks, [{ type: 'text', text: 'done' }]);
  });
});

describe('mcpImageProjectionHandlers (execute + finalizeContent)', () => {
  const exec = {
    signal: new AbortController().signal,
    agent: {
      options: { provider: 'visual', model: 'vision' },
      session: { requestHeader: () => undefined },
    },
  };

  it('degrades to a text placeholder when exec is missing', async () => {
    const handlers = mcpImageProjectionHandlers({}, 'screenshot');
    const value = { text: '', content: [PNG], isError: false };
    await handlers.prepare(value, undefined, {});
    const rendered = renderMcpResult({}, value);
    assertNoBareMcpImage(rendered);
    assert.equal(handlers.finalizeContent({}, { isError: false, value, content: rendered }), undefined);
  });

  it('admits an ordered mixed image result when attachments and vision are available', async () => {
    const saved = [];
    const ctx = {
      get(name) {
        if (name === 'attachments') {
          return {
            async saveImages(batch) {
              saved.push(...batch);
              return batch.map((item, i) => ({
                attachmentId: `sha256:${i}`,
                mediaType: item.mediaType,
                bytes: item.data.byteLength,
                width: 1,
                height: 1,
              }));
            },
          };
        }
        if (name === 'llm') {
          return {
            async resolveModelInfo() {
              return { inputModalities: ['text', 'image'] };
            },
          };
        }
        return undefined;
      },
    };
    const handlers = mcpImageProjectionHandlers(ctx, 'img');
    const value = {
      text: 'before\nafter',
      content: [
        { type: 'text', text: 'before' },
        PNG,
        { type: 'text', text: 'after' },
      ],
      isError: false,
    };
    await handlers.prepare(value, exec, {});
    const fallback = renderMcpResult({}, value);
    assertNoBareMcpImage(fallback);
    const finalized = handlers.finalizeContent(exec, { isError: false, value, content: fallback });
    assert.ok(finalized);
    assertNoBareMcpImage(finalized);
    assert.deepEqual(finalized.map((b) => b.type), ['text', 'image', 'text']);
    assert.equal(finalized[0].text, 'before');
    assert.equal(finalized[2].text, 'after');
    assert.equal(finalized[1].attachment.mediaType, 'image/png');
    assert.equal(finalized[1].attachment.bytes, 1);
    assert.equal(saved.length, 1);
    assert.deepEqual([...saved[0].data], [1]);
  });

  it('refuses images as text when no attachment store is mounted', async () => {
    const handlers = mcpImageProjectionHandlers({}, 'img');
    const value = { text: '', content: [PNG], isError: false };
    await handlers.prepare(value, exec, {});
    const fallback = renderMcpResult({}, value);
    const finalized = handlers.finalizeContent(exec, { isError: false, value, content: fallback });
    assertNoBareMcpImage(finalized);
    assert.equal(finalized[0].type, 'text');
    assert.match(finalized[0].text, /no attachment store is mounted/);
  });
});
