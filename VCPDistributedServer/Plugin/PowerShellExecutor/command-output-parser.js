'use strict';

/**
 * PTY 数据块不是消息边界。仅保留可能属于标记的末尾，正文逐块交给调用方。
 * 标记由调用方随机生成且不以明文出现在输入回显中。
 */
/** text 的末尾与 marker 开头重合的最长长度（不含整段 marker）。 */
function partialSuffixLength(text, marker) {
    for (let length = Math.min(text.length, marker.length - 1); length > 0; length--) {
        if (marker.startsWith(text.slice(-length))) {
            return length;
        }
    }
    return 0;
}

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

        // 只扣住确实可能是 endBoundary 开头的结尾，其余立即交出，短输出也能边跑边看。
        const keep = partialSuffixLength(this.pending, this.endBoundary);
        const emitLength = this.pending.length - keep;
        const output = this.pending.slice(0, emitLength);
        this.pending = this.pending.slice(emitLength);
        return { output, done: false, trailing: '' };
    }
}

/** 保留终端光标几何，仅把内部标记改为空格；跨数据块也不泄漏半截标记。 */
class CommandTerminalProjection {
    constructor(markers) {
        this.markers = markers;
        this.pending = '';
    }
    push(chunk) {
        this.pending += String(chunk);
        let output = '';
        while (this.pending) {
            let index = -1, marker = null;
            for (const candidate of this.markers) {
                const found = this.pending.indexOf(candidate);
                if (found >= 0 && (index < 0 || found < index)) { index = found; marker = candidate; }
            }
            if (index >= 0) {
                output += this.pending.slice(0, index) + ' '.repeat(marker.length);
                this.pending = this.pending.slice(index + marker.length);
                continue;
            }
            const keep = Math.max(0, ...this.markers.map(value => partialSuffixLength(this.pending, value)));
            output += this.pending.slice(0, this.pending.length - keep);
            this.pending = this.pending.slice(this.pending.length - keep);
            break;
        }
        return output;
    }
    flush() {
        const tail = this.pending;
        this.pending = '';
        return tail;
    }
}

module.exports = { CommandOutputParser, CommandTerminalProjection };