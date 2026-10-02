'use strict';

/**
 * PTY 数据块不是消息边界。仅保留可能属于标记的末尾，正文逐块交给调用方。
 * 标记由调用方随机生成且不以明文出现在输入回显中。
 */
class CommandOutputParser {
    constructor(startBoundary, endBoundary) {
        if (!startBoundary || !endBoundary) {
            throw new Error('Command boundaries must not be empty.');
        }
        this.startBoundary = startBoundary;
        this.endBoundary = endBoundary;
        this.pending = '';
        this.started = false;
        this.done = false;
    }

    push(chunk) {
        if (this.done) {
            return { output: '', done: true, trailing: String(chunk) };
        }
        this.pending += String(chunk);

        if (!this.started) {
            const startIndex = this.pending.indexOf(this.startBoundary);
            if (startIndex === -1) {
                this.pending = this.pending.slice(-(this.startBoundary.length - 1));
                return { output: '', done: false, trailing: '' };
            }
            this.started = true;
            this.pending = this.pending.slice(startIndex + this.startBoundary.length);
        }

        const endIndex = this.pending.indexOf(this.endBoundary);
        if (endIndex !== -1) {
            const output = this.pending.slice(0, endIndex);
            const trailing = this.pending.slice(endIndex + this.endBoundary.length);
            this.pending = '';
            this.done = true;
            return { output, done: true, trailing };
        }

        // 只有结尾可能仍是一个尚未收齐的 endBoundary。
        const keep = this.endBoundary.length - 1;
        const emitLength = Math.max(0, this.pending.length - keep);
        const output = this.pending.slice(0, emitLength);
        this.pending = this.pending.slice(emitLength);
        return { output, done: false, trailing: '' };
    }
}

module.exports = { CommandOutputParser };