/**
 * 桌宠在主窗口这一侧的唯一入口：样式、全局设置的「桌宠」分区、和桌宠之间的往来。
 * event-listeners.js 只在 preload 暴露了桌宠接口时才动态载入这里；删掉桌宠，主窗口不受影响。
 */
import { registerSettingsSection } from '../../modules/settings/extensions.js';
import { deskPetSection } from './settingsSection.js';
import { installDeskPetBridge } from './bridge.js';

// dock.css 是桌宠页面和设置页预览共用的小胶囊样式
const STYLESHEETS = ['../dock.css', './settings.css'];

function addStylesheets(doc) {
    for (const file of STYLESHEETS) {
        const href = new URL(file, import.meta.url).href;
        if ([...doc.querySelectorAll('link[rel="stylesheet"]')].some(link => link.href === href)) continue;
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        doc.head.append(link);
    }
}

let installed = false;

export function install(context) {
    if (installed) return;
    installed = true;
    addStylesheets(document);
    registerSettingsSection({ section: deskPetSection, label: '桌宠', icon: 'paw-print' });
    installDeskPetBridge(context);
}
