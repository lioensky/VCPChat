/* Portrait header display settings shared by the side pane home and the agent settings form. */

/**
 * Agent 配置里的 portraitDisplay：立绘在首页头部怎么摆。
 *   header           首页顶部显示什么：'portrait' 立绘（没有立绘时自然是头像）或 'avatar' 头像和名字
 *   focusX / focusY  深色主题画面焦点（百分比），窄侧栏裁切时保住这一点
 *   lightFocusX / lightFocusY  浅色主题独立焦点；旧配置沿用原来的焦点
 *   height           立绘渲染高度（px）；不改变分类切换条和下方组件的位置
 * 读进来的值一律先过 normalizePortraitDisplay，缺的、坏的都回到默认值。
 */
export const PORTRAIT_DISPLAY_DEFAULTS = Object.freeze({ focusX: 50, focusY: 22, height: 248 });
export const PORTRAIT_HEIGHT_RANGE = Object.freeze({ min: 180, max: 360 });
// 「重置位置」只管焦点和高度，所以 header 不在 PORTRAIT_DISPLAY_DEFAULTS 里
export const PORTRAIT_HEADER_MODES = Object.freeze(['portrait', 'avatar']);

const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

export function normalizePortraitDisplay(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const focusX = clamp(source.focusX, 0, 100, PORTRAIT_DISPLAY_DEFAULTS.focusX);
    const focusY = clamp(source.focusY, 0, 100, PORTRAIT_DISPLAY_DEFAULTS.focusY);
    return {
        header: source.header === 'avatar' ? 'avatar' : 'portrait',
        focusX,
        focusY,
        lightFocusX: clamp(source.lightFocusX ?? focusX, 0, 100, focusX),
        lightFocusY: clamp(source.lightFocusY ?? focusY, 0, 100, focusY),
        height: clamp(source.height, PORTRAIT_HEIGHT_RANGE.min, PORTRAIT_HEIGHT_RANGE.max, PORTRAIT_DISPLAY_DEFAULTS.height)
    };
}

export function portraitFocus(display, theme = 'default') {
    const value = normalizePortraitDisplay(display);
    return theme === 'light'
        ? { focusX: value.lightFocusX, focusY: value.lightFocusY }
        : { focusX: value.focusX, focusY: value.focusY };
}

export function isDefaultPortraitDisplay(display, theme = 'default') {
    const value = { ...normalizePortraitDisplay(display), ...portraitFocus(display, theme) };
    return Object.keys(PORTRAIT_DISPLAY_DEFAULTS).every(key => value[key] === PORTRAIT_DISPLAY_DEFAULTS[key]);
}

/**
 * 写到元素上的 CSS 变量（侧栏首页和设置页预览共用）：
 *   --side-pane-portrait-height          立绘高度（px）
 *   --side-pane-portrait-height-value    同一个高度的纯数字，给预览算宽高比
 *   --side-pane-portrait-position        立绘的 object-position
 *   --side-pane-portrait-focus-x / -y    焦点标记的位置
 * 焦点和高度是每个助手自己的设置，只能在运行时写；display 为 null 时清掉，回到样式表里的默认值。
 */
const DISPLAY_PROPERTIES = [
    '--side-pane-portrait-height',
    '--side-pane-portrait-height-value',
    '--side-pane-portrait-position',
    '--side-pane-portrait-position-light',
    '--side-pane-portrait-focus-x',
    '--side-pane-portrait-focus-y'
];

export function applyPortraitDisplay(element, display, theme = 'default') {
    const style = element?.style;
    if (!style) return;
    if (display === null) {
        DISPLAY_PROPERTIES.forEach(name => style.removeProperty(name));
        return;
    }
    const value = normalizePortraitDisplay(display);
    const focus = portraitFocus(value, theme);
    style.setProperty('--side-pane-portrait-height', `${value.height}px`);
    style.setProperty('--side-pane-portrait-height-value', String(value.height));
    style.setProperty('--side-pane-portrait-position', `${focus.focusX}% ${focus.focusY}%`);
    style.setProperty('--side-pane-portrait-position-light', `${value.lightFocusX}% ${value.lightFocusY}%`);
    style.setProperty('--side-pane-portrait-focus-x', `${focus.focusX}%`);
    style.setProperty('--side-pane-portrait-focus-y', `${focus.focusY}%`);
}
