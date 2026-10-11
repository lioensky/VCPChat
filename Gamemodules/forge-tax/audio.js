(function (root) {
    'use strict';
    // One cue per completed action, including all bonus focus hits.
    function selectCue(result) {
        if (!result?.ok) return null;
        const events = result.events || [];
        const end = events.find(e => e.type === 'end');
        if (end) return end.ending === '弑王·真结局' ? 'victory' : 'death';
        const hits = events.filter(e => e.type === 'hammer');
        if (hits.some(e => e.result === 'break' && !e.blocked)) return 'break';
        const tribute = events.find(e => e.type === 'tribute');
        if (tribute) return tribute.passed ? 'tribute' : 'damage';
        if (events.some(e => e.type === 'evolution')) return 'evolution';
        if (events.some(e => e.type === 'focus')) return 'focus';
        if (hits.some(e => e.result === 'critical')) return 'critical';
        if (hits.some(e => e.result === 'damage' && !e.blocked)) return 'damage';
        if (hits.some(e => e.result === 'success')) return 'success';
        if (hits.length) return 'hammer';
        if (events.some(e => e.type === 'undo')) return 'undo';
        if (events.some(e => ['purchase', 'relicPurchase'].includes(e.type))) return 'purchase';
        if (events.some(e => e.type === 'item')) return 'item';
        return null;
    }
    // Short synthesized motifs. Multiple notes are ONE cue, never one cue per hit.
    const MOTIFS = {
        hammer: [[0, 190, .10, 'triangle'], [0, 1450, .07, 'sine']],
        damage: [[0, 260, .14, 'sawtooth'], [.06, 110, .17, 'triangle']],
        break: [[0, 1800, .08, 'square'], [.04, 730, .10, 'sawtooth'], [.09, 90, .25, 'triangle']],
        success: [[0, 660, .12, 'sine'], [.08, 990, .18, 'sine']],
        critical: [[0, 660, .13, 'triangle'], [.07, 990, .15, 'sine'], [.14, 1320, .22, 'sine']],
        focus: [[0, 440, .14, 'sine'], [.08, 660, .14, 'sine'], [.16, 880, .23, 'sine']],
        evolution: [[0, 523, .13, 'sine'], [.09, 784, .16, 'sine'], [.18, 1047, .25, 'sine']],
        tribute: [[0, 784, .12, 'sine'], [.07, 1047, .19, 'sine']],
        purchase: [[0, 880, .08, 'sine'], [.06, 660, .10, 'sine']],
        item: [[0, 540, .12, 'triangle'], [.08, 810, .16, 'sine']],
        undo: [[0, 990, .12, 'sine'], [.08, 660, .12, 'sine'], [.16, 440, .16, 'sine']],
        death: [[0, 220, .22, 'triangle'], [.16, 165, .22, 'triangle'], [.32, 110, .30, 'triangle']],
        victory: [[0, 523, .18, 'triangle'], [.13, 659, .18, 'triangle'], [.26, 784, .18, 'triangle'], [.39, 1047, .30, 'sine']]
    };
    class Sound {
        constructor(options = {}) {
            this.factory = options.factory || (() => {
                const Context = root.AudioContext || root.webkitAudioContext;
                return Context ? new Context() : null;
            });
            this.context = null; this.enabled = options.enabled !== false;
            this.disposed = false; this.serial = 0; this.voices = new Set();
        }
        unlock() {
            if (this.disposed || !this.enabled) return Promise.resolve(false);
            try {
                this.context ||= this.factory();
                if (!this.context) return Promise.resolve(false);
                return (this.context.state === 'suspended' ? this.context.resume() : Promise.resolve())
                    .then(() => !this.disposed && this.context.state === 'running', () => false);
            } catch { return Promise.resolve(false); }
        }
        stop() {
            this.serial++;
            for (const voice of this.voices) {
                try { voice.osc.stop(); } catch {}
                voice.osc.disconnect(); voice.gain.disconnect();
            }
            this.voices.clear();
        }
        setEnabled(enabled) {
            this.enabled = Boolean(enabled);
            if (!this.enabled) this.stop();
        }
        async playResult(result) {
            const cue = selectCue(result);
            if (!cue || !this.enabled || this.disposed) return;
            this.stop();
            const serial = this.serial;
            if (!await this.unlock() || serial !== this.serial || !this.enabled) return;
            try {
                const ctx = this.context, now = ctx.currentTime + .005;
                for (const [offset, frequency, duration, type] of MOTIFS[cue]) {
                    const osc = ctx.createOscillator(), gain = ctx.createGain();
                    const start = now + offset, finish = start + duration;
                    const voice = { osc, gain };
                    osc.type = type;
                    osc.frequency.setValueAtTime(frequency, start);
                    if (cue === 'hammer' || cue === 'break') osc.frequency.exponentialRampToValueAtTime(Math.max(50, frequency * .5), finish);
                    gain.gain.setValueAtTime(0, start);
                    gain.gain.linearRampToValueAtTime(.10, start + .004);
                    gain.gain.exponentialRampToValueAtTime(.0001, finish);
                    osc.connect(gain); gain.connect(ctx.destination);
                    this.voices.add(voice);
                    osc.onended = () => {
                        osc.disconnect(); gain.disconnect(); this.voices.delete(voice);
                    };
                    osc.start(start); osc.stop(finish + .01);
                }
            } catch { this.stop(); } // Audio availability must never affect rules or saving.
        }
        dispose() {
            this.disposed = true; this.stop();
            if (this.context) this.context.close().catch(() => {});
        }
    }
    const api = { Sound, selectCue };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ForgeTaxAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);