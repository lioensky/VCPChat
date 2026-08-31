import type { UiDisposer, UiScope } from '../contracts.js';

const STYLE_ID = 'vcp-harness-uiux-color-pair';
function ensureStyles() { if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return; const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = `.vcp-uiux-color-pair{display:inline-flex;align-items:center;gap:6px;height:32px}.vcp-uiux-color-pair input[type=color]{width:32px;height:32px;padding:2px;border:0;border-radius:8px}.vcp-uiux-color-pair input[type=text]{height:32px;padding:0 8px;border:1px solid var(--vcp-color-border,#c8ccd4);border-radius:8px;font-size:14px;line-height:22px}`; (document.head || document.documentElement).append(style); }

export interface ColorPairProps {
    /** Presentation-only reaction; canonical values remain in native controls. */
    readonly onValueChange?: (value: string, source: 'color' | 'text') => void;
    /** Called after invalid text is restored to the canonical color value. */
    readonly onInvalid?: (value: string) => void;
}

export function mountColorPair(color: HTMLInputElement, text: HTMLInputElement, scope: UiScope, props: ColorPairProps = {}): UiDisposer {
    if (!color || color.type !== 'color' || !text || text.type !== 'text' || !scope) throw new TypeError('ColorPair requires color and text inputs.');
    ensureStyles(); const parent = color.parentNode; if (!parent || text.parentNode !== parent) throw new Error('ColorPair inputs must share a parent.');
    const wrap = document.createElement('span'); wrap.className = 'vcp-uiux-color-pair'; parent.insertBefore(wrap, color); wrap.append(color, text);
    const valid = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
    const syncText = () => { text.value = color.value; };
    const onColor = () => { syncText(); props.onValueChange?.(color.value, 'color'); };
    const onText = () => {
        if (!valid(text.value)) return;
        color.value = text.value;
        syncText();
        props.onValueChange?.(color.value, 'text');
    };
    const onTextBlur = () => {
        if (valid(text.value)) return;
        const invalid = text.value;
        syncText();
        props.onInvalid?.(invalid);
    };
    scope.listen(color, 'input', onColor); scope.listen(color, 'change', onColor);
    scope.listen(text, 'input', onText); scope.listen(text, 'change', onText); scope.listen(text, 'blur', onTextBlur);
    // vcp-uiux-sync mirrors host-driven programmatic writes (snapshot replay,
    // Agent populate). The canonical color input replays through the full
    // onColor path so presentation hooks (avatar preview) converge; the text
    // twin only re-mirrors, never re-fires onValueChange.
    scope.listen(color, 'vcp-uiux-sync', onColor);
    scope.listen(text, 'vcp-uiux-sync', syncText);
    syncText();
    return scope.own(() => { if (color.parentNode === wrap) parent.insertBefore(color, wrap); if (text.parentNode === wrap) parent.append(text); wrap.remove(); }, 'harness-color-pair', 'ui-primitive');
}
