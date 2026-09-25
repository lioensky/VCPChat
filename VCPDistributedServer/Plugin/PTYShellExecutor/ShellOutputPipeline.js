'use strict';

const { StringDecoder } = require('string_decoder');

const DEFAULT_BACKLOG_LIMIT = 2 * 1024 * 1024;
const SHELL_OUTPUT_PROTOCOL_VERSION = 1;
let executionSequence = 0;

function isUsableWebContents(targetWebContents) {
    return Boolean(
        targetWebContents
        && typeof targetWebContents.send === 'function'
        && !targetWebContents.isDestroyed?.()
        && !targetWebContents.isCrashed?.()
    );
}

function retainUtf8Tail(text, maxBytes) {
    const raw = Buffer.from(text, 'utf-8');
    if (raw.length <= maxBytes) return text;

    let start = raw.length - maxBytes;
    while (start < raw.length && (raw[start] & 0xc0) === 0x80) start += 1;
    return raw.subarray(start).toString('utf-8');
}

/**
 * 为单个 ShellViewer 窗口维护输出就绪屏障。
 * attach 创建新代次并清除旧缓存；targetGeneration 将任务输出固定到启动窗口。
 */
class ShellOutputBus {
    constructor({ channel = 'shell-data', maxBacklogBytes = DEFAULT_BACKLOG_LIMIT } = {}) {
        this.channel = channel;
        this.maxBacklogBytes = maxBacklogBytes;
        this.target = null;
        this.generation = 0;
        this.sequence = 0;
        this.backlog = [];
        this.backlogBytes = 0;
    }

    _clearBacklog() {
        this.backlog = [];
        this.backlogBytes = 0;
    }

    _bufferEnvelope(envelope) {
        let bufferedEnvelope = envelope;
        let bytes = Buffer.byteLength(envelope.data, 'utf-8');

        if (bytes > this.maxBacklogBytes) {
            const retained = retainUtf8Tail(envelope.data, this.maxBacklogBytes);
            bufferedEnvelope = { ...envelope, data: retained, truncated: true };
            bytes = Buffer.byteLength(retained, 'utf-8');
        }

        this.backlog.push({ envelope: bufferedEnvelope, bytes });
        this.backlogBytes += bytes;
        while (this.backlogBytes > this.maxBacklogBytes && this.backlog.length > 1) {
            const removed = this.backlog.shift();
            this.backlogBytes -= removed.bytes;
        }
    }

    isCurrentTarget(targetWebContents) {
        return Boolean(
            this.target
            && this.target.webContents === targetWebContents
            && isUsableWebContents(targetWebContents)
        );
    }

    attach(targetWebContents) {
        if (!isUsableWebContents(targetWebContents)) {
            throw new Error('Cannot attach an unavailable ShellViewer webContents.');
        }

        this.generation += 1;
        this.target = { webContents: targetWebContents, generation: this.generation, ready: false };
        this._clearBacklog();
        return this.generation;
    }

    detach(targetWebContents = null) {
        if (!this.target || (targetWebContents && this.target.webContents !== targetWebContents)) {
            return false;
        }
        this.target = null;
        this._clearBacklog();
        return true;
    }

    publish(data, meta = {}) {
        if (data === null || data === undefined || data === '') return false;
        if (!this.target || !isUsableWebContents(this.target.webContents)) {
            this.detach();
            return false;
        }
        const activeTarget = this.target;
        if (meta.targetGeneration !== undefined && meta.targetGeneration !== null
            && meta.targetGeneration !== activeTarget.generation) {
            return false;
        }

        const envelope = {
            version: SHELL_OUTPUT_PROTOCOL_VERSION,
            generation: activeTarget.generation,
            sequence: ++this.sequence,
            source: meta.source || 'system',
            executionId: meta.executionId || null,
            phase: meta.phase || 'data',
            stream: meta.stream || null,
            data: Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
        };

        if (!activeTarget.ready) {
            this._bufferEnvelope(envelope);
            return true;
        }

        try {
            activeTarget.webContents.send(this.channel, envelope);
            return true;
        } catch {
            if (this.target !== activeTarget) return false;
            activeTarget.ready = false;
            if (isUsableWebContents(activeTarget.webContents)) this._bufferEnvelope(envelope);
            else this.detach(activeTarget.webContents);
            return false;
        }
    }

    markReady(targetWebContents) {
        if (!this.isCurrentTarget(targetWebContents)) return false;

        const activeTarget = this.target;
        activeTarget.ready = true;
        const pending = this.backlog;
        this._clearBacklog();
        for (let index = 0; index < pending.length; index++) {
            try {
                targetWebContents.send(this.channel, pending[index].envelope);
                if (this.target !== activeTarget) return false;
            } catch {
                if (this.target !== activeTarget) return false;
                activeTarget.ready = false;
                for (let retryIndex = index; retryIndex < pending.length; retryIndex++) {
                    this._bufferEnvelope(pending[retryIndex].envelope);
                }
                return false;
            }
        }
        return true;
    }

    currentGeneration() {
        return this.target?.generation ?? null;
    }

    currentWebContents() {
        return this.target?.webContents ?? null;
    }

    snapshot() {
        return {
            generation: this.target?.generation ?? null,
            ready: this.target?.ready ?? false,
            backlogLength: this.backlog.length,
            backlogBytes: this.backlogBytes
        };
    }
}

function createShellOutputBus(options) {
    return new ShellOutputBus(options);
}

/** 为 stdout/stderr 等独立字节流提供不会破坏跨 chunk UTF-8 的增量解码。 */
function createUtf8StreamDecoder(streamNames = ['stdout', 'stderr']) {
    const decoders = new Map(streamNames.map(name => [name, new StringDecoder('utf8')]));
    let ended = false;

    return {
        write(stream, chunk) {
            if (ended) return '';
            if (!decoders.has(stream)) decoders.set(stream, new StringDecoder('utf8'));
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8');
            return decoders.get(stream).write(data);
        },
        end() {
            if (ended) return [];
            ended = true;
            const tails = [];
            for (const [stream, decoder] of decoders) {
                const data = decoder.end();
                if (data) tails.push({ stream, data });
            }
            return tails;
        }
    };
}

function normalizeForTerminal(data) {
    return String(data).replace(/\r?\n/g, '\r\n');
}

function formatTranscriptCommand(command) {
    return String(command)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map((line, index) => `${index === 0 ? '$' : '>'} ${line}`)
        .join('\r\n');
}

function createExecutionId(prefix = 'agent') {
    executionSequence += 1;
    return `${prefix}-${Date.now().toString(36)}-${executionSequence.toString(36)}`;
}

function getTranscriptLabel(source, phase) {
    const prefix = source === 'agent-async'
        ? 'Agent Async'
        : (source === 'user-command' ? 'User' : 'Agent');
    return `${prefix} ${phase}`;
}

function writeExecutionTranscriptStart(command, options, shell, executionId, publishShellData) {
    const cwd = options.cwd || process.env.HOME || '/home';
    const source = options.source || 'agent-sync';
    publishShellData(
        `\r\n\x1b[90m[${getTranscriptLabel(source, 'Execute')}] id=${executionId} cwd=${cwd} shell=${shell}\x1b[0m\r\n`
        + `\x1b[36m${formatTranscriptCommand(command)}\x1b[0m\r\n`,
        { source, executionId, phase: 'start', targetGeneration: options.targetGeneration }
    );
}

function writeExecutionTranscriptEnd(code, signal, options, executionId, publishShellData, status = null) {
    const source = options.source || 'agent-sync';
    const signalText = signal ? ` signal=${signal}` : '';
    const statusText = status ? ` status=${status}` : '';
    publishShellData(
        `\r\n\x1b[90m[${getTranscriptLabel(source, 'Exit')}] id=${executionId} code=${code ?? 'null'}${signalText}${statusText}\x1b[0m\r\n`,
        { source, executionId, phase: 'end', targetGeneration: options.targetGeneration }
    );
}

module.exports = {
    createExecutionId,
    createShellOutputBus,
    createUtf8StreamDecoder,
    isUsableWebContents,
    normalizeForTerminal,
    writeExecutionTranscriptEnd,
    writeExecutionTranscriptStart
};
