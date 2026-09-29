/**
 * VoiceWaveform: 实时麦克风振幅可视化组件
 * 极速动态波形算法：
 * 预渲染 80 根具有圆角描边的 SVG 竖线，通过 requestAnimationFrame (50ms 节流)
 * 命令式更新 line 几何属性，完全避开框架重渲染开销，保持 60fps 丝滑与超低 CPU 占用。
 */

class VoiceWaveform {
    constructor(options = {}) {
        this.container = null;
        this.svg = null;
        this.bars = [];
        this.frameId = null;
        this.previousTime = -Infinity;
        this.source = null;
        this.active = false;
        this.throttleMs = options.throttleMs || 50;
        this.barCount = options.barCount || 80;
    }

    createSvg() {
        if (typeof document === 'undefined') return null;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 640 40');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', '麦克风实时音频波形');
        svg.classList.add('vcp-voice-waveform-svg');

        for (let i = 0; i < this.barCount; i++) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            const x = i * 8 + 4;
            line.setAttribute('x1', String(x));
            line.setAttribute('x2', String(x));
            line.setAttribute('y1', '19');
            line.setAttribute('y2', '21');
            line.setAttribute('stroke', 'currentColor');
            line.setAttribute('stroke-width', '3');
            line.setAttribute('stroke-linecap', 'round');
            line.setAttribute('opacity', String((0.25 + i / 120).toFixed(3)));
            svg.appendChild(line);
        }

        return svg;
    }

    mount(container) {
        if (!container || typeof document === 'undefined') return;
        this.container = container;
        if (!this.svg) {
            this.svg = this.createSvg();
        }
        if (this.svg && !container.contains(this.svg)) {
            container.appendChild(this.svg);
        }
        this.initBars();
    }

    initBars() {
        if (!this.svg) return;
        const lines = Array.from(this.svg.querySelectorAll('line')).reverse();
        this.bars = lines.map(element => ({ element, level: 0 }));
    }

    attachSource(source) {
        this.source = source;
    }

    start(source) {
        if (source) this.attachSource(source);
        if (this.active) return;
        this.active = true;
        this.previousTime = -Infinity;

        if (this.bars.length === 0) {
            this.initBars();
        }

        const draw = (now) => {
            if (!this.active) return;
            if (now - this.previousTime >= this.throttleMs) {
                this.previousTime = now;
                let next = 0;
                if (typeof this.source?.amplitude === 'function') {
                    try {
                        next = Number(this.source.amplitude()) || 0;
                    } catch (_) {
                        next = 0;
                    }
                }

                for (let i = 0; i < this.bars.length; i++) {
                    const bar = this.bars[i];
                    const previousLevel = bar.level;
                    bar.level = next;
                    next = previousLevel;
                    const height = 1 + Math.min(1, bar.level * 5) * 17;
                    bar.element.setAttribute('y1', String(20 - height));
                    bar.element.setAttribute('y2', String(20 + height));
                }
            }
            this.frameId = requestAnimationFrame(draw);
        };

        this.frameId = requestAnimationFrame(draw);
    }

    reset() {
        for (let i = 0; i < this.bars.length; i++) {
            const bar = this.bars[i];
            bar.level = 0;
            bar.element.setAttribute('y1', '19');
            bar.element.setAttribute('y2', '21');
        }
    }

    stop() {
        this.active = false;
        if (this.frameId) {
            cancelAnimationFrame(this.frameId);
            this.frameId = null;
        }
        this.reset();
    }

    destroy() {
        this.stop();
        if (this.svg && this.svg.parentNode) {
            this.svg.remove();
        }
        this.svg = null;
        this.bars = [];
        this.container = null;
        this.source = null;
    }
}

if (typeof window !== 'undefined') {
    window.VcpVoice = Object.assign(window.VcpVoice || {}, {
        VoiceWaveform,
    });
    window.VoiceWaveform = VoiceWaveform;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        VoiceWaveform,
    };
}
