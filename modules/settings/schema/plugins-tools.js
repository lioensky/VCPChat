import { section, custom } from './kernel.js';
export const pluginsToolsSection = section('plugins-tools', '插件与工具', [custom('pluginsTools', doc => {
    const host = doc.createElement('div');
    host.className = 'plugins-settings';
    host.dataset.vcpPluginSettings = 'true';
    return host;
})]);
