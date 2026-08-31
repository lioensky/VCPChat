import type { UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-state-dot';
const MATRIX_CELLS = [[0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4]] as const;

function ensureStyles() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `.vcp-harness-state-dot,.vcp-harness-state-matrix{--dsh-state-ongoing:var(--dsw-static-deepseek-450,rgb(86,134,254))}.vcp-harness-state-dot{position:relative;display:inline-block;flex:none}.vcp-harness-state-dot::before{content:'';position:absolute;inset:0;border-radius:50%;background:currentColor;opacity:.1}.vcp-harness-state-dot::after{content:'';position:absolute;inset:20%;border-radius:50%;background:currentColor}.vcp-harness-state-dot[data-state=done]{color:var(--dsw-alias-state-success-primary,rgb(34,197,94))}.vcp-harness-state-dot[data-state=warning]{color:var(--dsw-alias-state-warn-primary,rgb(245,158,11))}.vcp-harness-state-dot[data-state=error]{color:var(--dsw-alias-state-error-primary,rgb(217,45,32))}.vcp-harness-state-matrix{display:inline-block;flex:none;color:var(--dsh-state-ongoing)}.vcp-harness-state-cell{fill:currentColor;opacity:.15;animation:vcp-harness-state-dot-chase 1s infinite}@keyframes vcp-harness-state-dot-chase{0%,12.4%{opacity:1}12.5%,24.9%{opacity:.6}25%,37.4%{opacity:.35}37.5%,100%{opacity:.15}}@media(prefers-reduced-motion:reduce){.vcp-harness-state-cell{animation:none;opacity:.6}}`;
    (document.head || document.documentElement).append(style);
}

export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error';

export interface StateDotProps {
    readonly state: StateDotState;
    readonly size?: number;
    readonly className?: string;
}

export interface StateDotController {
    readonly host: HTMLElement;
    readonly element: HTMLElement | SVGSVGElement;
    readonly state: StateDotState;
    readonly size: number;
    setState(state: StateDotState): void;
    setSize(size: number): void;
    dispose(): void | Promise<void>;
}

function assertState(state: string): asserts state is StateDotState {
    if (!['done', 'warning', 'ongoing', 'error'].includes(state)) throw new TypeError(`Unknown StateDot state: ${state}`);
}

/** Harness state marker; visual-only and deliberately aria-hidden. */
export function mountStateDot(host: HTMLElement, props: StateDotProps, scope: UiScope): StateDotController {
    if (!host || !props?.state || !scope) throw new TypeError('StateDot requires a host, state and scope.');
    assertState(props.state);
    ensureStyles();
    const originalNodes = Array.from(host.childNodes);
    let state = props.state;
    let size = props.size ?? 10;
    if (!Number.isFinite(size) || size <= 0) throw new TypeError('StateDot size must be a positive finite number.');
    let element: HTMLElement | SVGSVGElement;

    const render = () => {
        if (state === 'ongoing') {
            const matrix = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            matrix.classList.add('vcp-harness-state-matrix');
            if (props.className) matrix.classList.add(...props.className.split(/\s+/).filter(Boolean));
            matrix.dataset.state = state;
            matrix.setAttribute('width', String(size));
            matrix.setAttribute('height', String(size));
            matrix.setAttribute('viewBox', '0 0 10 10');
            matrix.setAttribute('shape-rendering', 'crispEdges');
            matrix.setAttribute('aria-hidden', 'true');
            MATRIX_CELLS.forEach(([x, y], index) => {
                const cell = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                cell.classList.add('vcp-harness-state-cell');
                cell.setAttribute('x', String(x));
                cell.setAttribute('y', String(y));
                cell.setAttribute('width', '2');
                cell.setAttribute('height', '2');
                cell.style.animationDelay = `${(index - MATRIX_CELLS.length) * 125}ms`;
                matrix.append(cell);
            });
            element = matrix;
        } else {
            const dot = document.createElement('span');
            dot.className = 'vcp-harness-state-dot';
            if (props.className) dot.classList.add(...props.className.split(/\s+/).filter(Boolean));
            dot.dataset.state = state;
            dot.style.width = `${size}px`;
            dot.style.height = `${size}px`;
            dot.setAttribute('aria-hidden', 'true');
            element = dot;
        }
        host.replaceChildren(element);
    };
    render();
    const dispose = scope.own(() => host.replaceChildren(...originalNodes), 'harness-state-dot', 'ui-primitive');
    const controller: StateDotController = {
        host,
        get element() { return element; },
        get state() { return state; },
        get size() { return size; },
        setState(value) { assertState(value); state = value; render(); },
        setSize(value) {
            if (!Number.isFinite(value) || value <= 0) throw new TypeError('StateDot size must be a positive finite number.');
            size = value;
            render();
        },
        dispose,
    };
    return controller;
}
