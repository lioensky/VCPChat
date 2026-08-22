import { PIPELINE_MODES } from './contentModes.js';

export function normalizeStreamChunk(chunk) {
    if (chunk?.error === 'json_parse_error') return '';
    if (typeof chunk?.choices?.[0]?.delta?.content === 'string') return chunk.choices[0].delta.content;
    if (typeof chunk?.delta?.content === 'string') return chunk.delta.content;
    if (typeof chunk?.content === 'string') return chunk.content;
    if (typeof chunk === 'string') return chunk;
    if (typeof chunk?.raw === 'string' && !chunk?.error) return chunk.raw;
    return '';
}

/**
 * Content Runtime contract. It owns content normalization/preprocessing but
 * deliberately knows nothing about DOM, Electron or a chat surface.
 */
export function createContentRuntime({ pipeline }) {
    if (!pipeline || typeof pipeline.process !== 'function') {
        throw new TypeError('ContentRuntime requires a content pipeline');
    }
    const process = (text, mode, options = {}) => pipeline.process(text, { ...options, mode });
    const normalizeAttachments = (attachments) => {
        if (!Array.isArray(attachments)) return Object.freeze([]);
        return Object.freeze(attachments.filter(Boolean).map((attachment) => Object.freeze({
            ...attachment,
            type: typeof attachment.type === 'string' ? attachment.type : 'application/octet-stream',
            name: typeof attachment.name === 'string' && attachment.name.trim()
                ? attachment.name
                : '未命名附件',
            src: typeof attachment.src === 'string' ? attachment.src : ''
        })));
    };
    return Object.freeze({
        normalizeAttachments,
        normalizeMessage(message, options) {
            const source = message && typeof message === 'object' ? message : {};
            return {
                ...source,
                id: source.id || options?.fallbackId || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                role: source.role || 'assistant',
                content: source.content === undefined ? '' : source.content,
                attachments: normalizeAttachments(source.attachments)
            };
        },
        processFull(text, options = {}) {
            return process(text, PIPELINE_MODES.FULL_RENDER, options);
        },
        createRenderModel(message, options = {}) {
            const normalized = this.normalizeMessage(message, options);
            const result = options.mode === PIPELINE_MODES.STREAM_FAST
                ? this.processStream(normalized.content, options)
                : this.processFull(normalized.content, options);
            return Object.freeze({
                message: Object.freeze(normalized),
                text: result.text,
                state: result.state,
                mode: options.mode || PIPELINE_MODES.FULL_RENDER
            });
        },
        processStream(text, options = {}) {
            return process(text, PIPELINE_MODES.STREAM_FAST, options);
        },
        extractChunkText(chunk) {
            return normalizeStreamChunk(chunk);
        },
        createStreamAssembler(initial = '') {
            let text = typeof initial === 'string' ? initial : '';
            return Object.freeze({
                append(chunk) { text += typeof chunk === 'string' ? chunk : ''; return text; },
                get text() { return text; },
                reset(value = '') { text = typeof value === 'string' ? value : ''; return text; }
            });
        }
    });
}
