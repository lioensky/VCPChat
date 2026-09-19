'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const inputEnhancerSource = fs.readFileSync(
    path.resolve(__dirname, '..', 'modules', 'inputEnhancer.js'),
    'utf8',
);

function flushAsyncWork() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

function createFixture() {
    const dom = new JSDOM(
        '<!doctype html><body><div id="composer"><textarea id="message"></textarea></div><button id="other">其他控件</button></body>',
        { runScripts: 'dangerously', url: 'http://localhost/' },
    );
    const { window } = dom;
    const messageInput = window.document.getElementById('message');
    const attachments = [];
    const handledFiles = [];
    let previewUpdates = 0;
    let sendAttempts = 0;

    window.console = console;
    window.alert = message => {
        throw new Error(`Unexpected alert: ${message}`);
    };
    window.electronPath = {
        basename: async filePath => path.basename(filePath),
    };
    window.eval(inputEnhancerSource);

    const electronAPI = {
        searchNotes: async () => [
            { name: '第一篇.md', path: 'C:\\notes\\第一篇.md' },
            { name: '第二篇.md', path: 'C:\\notes\\第二篇.md' },
        ],
        handleFileDrop: async (_agentId, _topicId, files) => {
            handledFiles.push(...files);
            return files.map(file => ({
                success: true,
                attachment: {
                    name: file.name,
                    type: 'text/markdown',
                    size: 10,
                    internalPath: `attachments/${file.name}`,
                },
            }));
        },
        onAddFileToInput: () => () => {},
    };

    window.inputEnhancer.initializeInputEnhancer({
        messageInput,
        dropTargetElement: window.document.getElementById('composer'),
        electronAPI,
        attachedFiles: {
            append(value) {
                attachments.push(value);
            },
        },
        updateAttachmentPreview() {
            previewUpdates += 1;
        },
        getCurrentAgentId: () => 'agent-1',
        getCurrentTopicId: () => 'topic-1',
    });

    // Simulates the chat send listener registered elsewhere after InputEnhancer.
    messageInput.addEventListener('keydown', event => {
        if (event.defaultPrevented) return;
        if (event.key === 'Enter' && !event.shiftKey) sendAttempts += 1;
    });

    async function openSuggestions() {
        messageInput.value = '@篇';
        messageInput.selectionStart = messageInput.value.length;
        messageInput.selectionEnd = messageInput.value.length;
        messageInput.focus();
        messageInput.dispatchEvent(new window.Event('input', { bubbles: true }));
        await flushAsyncWork();

        const popup = window.document.getElementById('note-suggestion-popup');
        assert.ok(popup);
        assert.equal(popup.style.display, 'block');
        assert.equal(popup.querySelectorAll('.suggestion-item').length, 2);
        return popup;
    }

    return {
        dom,
        window,
        messageInput,
        attachments,
        handledFiles,
        get previewUpdates() {
            return previewUpdates;
        },
        get sendAttempts() {
            return sendAttempts;
        },
        openSuggestions,
    };
}

test('Enter confirms the highlighted @note without sending the message', async t => {
    const fixture = createFixture();
    t.after(async () => {
        await fixture.window.inputEnhancer.dispose();
        fixture.dom.window.close();
    });

    const popup = await fixture.openSuggestions();
    fixture.messageInput.dispatchEvent(new fixture.window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
    }));
    assert.equal(popup.querySelectorAll('.suggestion-item')[1].classList.contains('active'), true);

    const enterEvent = new fixture.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
    });
    const dispatchResult = fixture.messageInput.dispatchEvent(enterEvent);
    await flushAsyncWork();

    assert.equal(dispatchResult, false);
    assert.equal(enterEvent.defaultPrevented, true);
    assert.equal(fixture.sendAttempts, 0);
    assert.equal(fixture.handledFiles[0].name, '第二篇.md');
    assert.equal(fixture.attachments[0].originalName, '第二篇.md');
    assert.equal(fixture.previewUpdates, 1);
    assert.equal(fixture.messageInput.value, '');
});

test('Tab confirms the highlighted @note and keeps focus in the composer', async t => {
    const fixture = createFixture();
    t.after(async () => {
        await fixture.window.inputEnhancer.dispose();
        fixture.dom.window.close();
    });

    await fixture.openSuggestions();
    assert.equal(fixture.window.document.activeElement, fixture.messageInput);

    const tabEvent = new fixture.window.KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
    });
    const dispatchResult = fixture.messageInput.dispatchEvent(tabEvent);
    await flushAsyncWork();

    assert.equal(dispatchResult, false);
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(fixture.window.document.activeElement, fixture.messageInput);
    assert.equal(fixture.sendAttempts, 0);
    assert.equal(fixture.handledFiles[0].name, '第一篇.md');
    assert.equal(fixture.attachments[0].originalName, '第一篇.md');
    assert.equal(fixture.previewUpdates, 1);
    assert.equal(fixture.messageInput.value, '');
});