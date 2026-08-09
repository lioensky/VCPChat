// Single source of truth for the Web Awesome runtime shipped by VCPChat.
// Both the browser adapter and the offline closure generator consume this
// manifest, so adding a component necessarily changes the reproducible vendor
// output and its packaging gate.

export const WEB_AWESOME_VERSION = '3.11.0';
export const WEB_AWESOME_LOCALE = 'zh-CN';
export const WEB_AWESOME_COMPONENTS = Object.freeze([
    'button',
    'card',
    'input',
    'textarea',
    'select',
    'option',
    'checkbox',
    'switch',
    'tab',
    'tab-panel',
    'tab-group',
    'dialog',
    'tooltip',
]);
