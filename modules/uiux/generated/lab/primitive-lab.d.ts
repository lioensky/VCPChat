import type { UiDisposer, UiScope } from '../contracts.js';
/** Candidate-only fixture host. It owns presentation state and no business state. */
export declare function mountPrimitiveLab(root: HTMLElement, scope: UiScope): UiDisposer;
