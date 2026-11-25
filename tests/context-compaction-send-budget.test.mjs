import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightContextSend } from '../modules/chat/contextCompactionService.js';

const context = { agentId: 'a', topicId: 't' };

test('send budget follows the message window and does not read encoded media', async () => {
    let mediaReads = 0;
    const result = await preflightContextSend({
        context,
        electronAPI: { async getFileAsBase64() { mediaReads++; } },
        agentConfig: { contextTokenLimit: 500, contextMessageWindowSize: 1 },
        history: [{ id: 'old', role: 'assistant', content: '旧'.repeat(1000) }],
        pendingMessage: {
            id: 'u', role: 'user', content: '看图',
            attachments: [{ type: 'image/png', src: 'file:///test.png' }],
        },
    });
    assert.equal(result.shouldCompact, false);
    assert.ok(result.tokens < 500);
    assert.equal(mediaReads, 0);
});

test('send budget counts refreshed live text and expanded workspace prompt', async () => {
    const pendingMessage = {
        id: 'u', role: 'user', content: '看看',
        attachments: [{
            type: 'text/plain', src: 'file:///test.txt',
            _fileManagerData: { isLiveReference: true, extractedText: '短' },
        }],
    };
    await assert.rejects(preflightContextSend({
        context,
        electronAPI: {
            async getTextContent() { return { text: '文'.repeat(400) }; },
            async expandWorkspacePlaceholders() { return { success: true, text: '树'.repeat(400) }; },
        },
        agentConfig: { contextTokenLimit: 500, systemPrompt: '{{VCPChatWorkSpace}}' },
        history: [],
        pendingMessage,
    }), /超过上限 500/);
});