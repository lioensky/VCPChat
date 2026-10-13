import { replaceToolRequestBlocks, findUnclosedToolRequest, readToolRequestField } from './toolRequestScanner.js';

const ATTRIBUTE = 'data-vcp-projectforge-topic';

export function containsProjectForgeRequest(text) {
    if (typeof text !== 'string' || !/ProjectForge/i.test(text)) return false;
    let found = false;
    const inspect = (source) => {
        // Field order is not fixed: valet/maid may precede tool_name.
        // Shared field scanning skips payloads, including ESCAPE-wrapped examples.
        if (readToolRequestField(source, 'tool_name')?.toLowerCase() === 'projectforge') found = true;
    };
    replaceToolRequestBlocks(text, (block, source) => {
        inspect(source);
        return block;
    });
    if (!found) {
        const partial = findUnclosedToolRequest(text);
        if (partial) inspect(partial.content.slice('<<<[TOOL_REQUEST]>>>'.length));
    }
    return found;
}

/** Render-only state, owned by each surface root; never changes stored/AI history. */
export function createProjectForgeTopicSurface() {
    const states = new WeakMap();
    const roots = new Set();
    function state(root) {
        if (!states.has(root)) {
            states.set(root, new Map());
            roots.add(root);
        }
        return states.get(root);
    }
    function publish(root, entries) {
        if ([...entries.values()].some(Boolean)) root.setAttribute(ATTRIBUTE, 'true');
        else root.removeAttribute(ATTRIBUTE);
    }
    function observe(root, message) {
        if (!root || !message?.id) return;
        const entries = state(root);
        const text = typeof message.content === 'string' ? message.content : message.content?.text;
        entries.set(message.id, message.role === 'assistant' && containsProjectForgeRequest(text));
        publish(root, entries);
    }
    function replaceHistory(root, history = []) {
        if (!root) return;
        states.set(root, new Map());
        roots.add(root);
        for (const message of history) {
            const text = typeof message.content === 'string' ? message.content : message.content?.text;
            states.get(root).set(message.id, message.role === 'assistant' && containsProjectForgeRequest(text));
        }
        publish(root, states.get(root));
    }
    function remove(root, id) {
        if (!root) return;
        const entries = state(root);
        entries.delete(id);
        publish(root, entries);
    }
    function clear(root) {
        if (!root) return;
        root.removeAttribute(ATTRIBUTE);
        states.delete(root);
        roots.delete(root);
    }
    return { observe, replaceHistory, remove, clear, dispose() { [...roots].forEach(clear); } };
}