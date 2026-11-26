import { normalizeStreamChunk } from './contentRuntime.js';

/** One assembler per stream operation. This projects calls; it never executes them. */
export function createNativeToolCallStream() {
    const pending = new Map();
    let invalid = false;

    function flush() {
        const calls = [...pending].sort(([a], [b]) => a - b).map(([, call]) => call);
        pending.clear();
        const valid = !invalid && calls.length > 0
            && new Set(calls.map(call => call.id)).size === calls.length
            && calls.every(call => call.id && call.type === 'function' && call.function.name
                && call.function.arguments);
        invalid = false;
        return valid ? [{ vcpHostedToolCalls: calls }] : [];
    }

    function append(parts, complete) {
        if (!Array.isArray(parts)) return;
        for (const [position, part] of parts.entries()) {
            const index = part?.index ?? position;
            if (!part || !Number.isSafeInteger(index) || index < 0 || index >= 1024) {
                invalid = true;
                continue;
            }
            const call = pending.get(index) ?? { id: '', type: '', function: { name: '', arguments: '' } };
            for (const key of ['id', 'type']) {
                if (part[key] === undefined) continue;
                if (typeof part[key] !== 'string' || (call[key] && call[key] !== part[key])) invalid = true;
                else call[key] = part[key];
            }
            for (const key of ['name', 'arguments']) {
                if (part.function?.[key] === undefined) continue;
                if (typeof part.function[key] !== 'string') invalid = true;
                else if (complete) call.function[key] = part.function[key];
                else call.function[key] += part.function[key];
            }
            pending.set(index, call);
        }
    }

    return {
        push(chunk) {
            const choice = chunk?.choices?.find?.(choice => (choice?.index ?? 0) === 0);
            const text = choice && choice !== chunk.choices[0]
                ? normalizeStreamChunk({ choices: [choice] })
                : chunk?.choices?.length && !choice ? '' : normalizeStreamChunk(chunk);
            const calls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
            const output = [];
            // A following text frame is a hard boundary even when the provider
            // omits an intermediate finish_reason in a multi-round response.
            if (text && !calls?.length) output.push(...flush());
            if (text) output.push(text);
            append(calls, Boolean(choice?.message));
            if (choice?.message?.tool_calls || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'stop') {
                output.push(...flush());
            }
            return output;
        },
        flush,
    };
}