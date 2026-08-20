import { register } from './next-ui-apps.js';
import { createReadOnlyChatSurface } from '../chat/chatSurface.js';
import { createChatSurfaceSlots } from '../chat/chatSurfaceSlots.js';
import { createChatPresentationState } from '../chat/chatPresentationState.js';
import { createPresentationSkin } from '../chat/chatPresentationSkin.js';
import { createChatThemePlugin } from '../chat/chatThemePlugin.js';
import { createChatPluginLoader } from '../chat/chatPluginManifest.js';

function mountStandaloneChat(container, context = {}) {
    const repository = context.chat?.repository;
    const chatSnapshot = context.chat?.getSnapshot?.() || null;
    const createRenderer = context.chat?.createRenderer;
    const scope = context.scope?.child?.('next:standalone-chat') || null;
    container.innerHTML = `<section class="vcp-standalone-chat" aria-label="聊天历史查看器"><header><h1>聊天历史</h1><p class="vcp-standalone-chat__status">只读查看</p><button type="button" class="vcp-standalone-chat__focus">聚焦内容</button></header><div class="vcp-standalone-chat__messages" tabindex="-1" aria-label="聊天消息"></div></section>`;
    const root = container.querySelector('.vcp-standalone-chat__messages');
    const focusButton = container.querySelector('.vcp-standalone-chat__focus');
    if (!repository || typeof createRenderer !== 'function') {
        container.querySelector('.vcp-standalone-chat__status').textContent = '当前没有可查看的话题';
        return async () => { scope?.dispose?.('standalone-chat-empty'); container.replaceChildren(); };
    }
    const rendererOwner = createRenderer({ root, mode: 'readonly' });
    const renderer = rendererOwner.renderer;
    const slots = createChatSurfaceSlots();
    const presentationState = createChatPresentationState({ ...(context.chat?.presentation?.getSnapshot?.() || {}), activeSurface: 'standalone' });
    const skin = createPresentationSkin({ id: 'readonly-badge', tokens: { accent: 'var(--vcp-accent-color)' }, render: (host, state, tokens) => {
        host.dataset.presentationMode = state.mode;
        host.dataset.skinAccent = tokens.accent;
        return () => { delete host.dataset.presentationMode; delete host.dataset.skinAccent; };
    }, update: (host, state) => { host.dataset.presentationMode = state.mode; } });
    const themePlugin = createChatThemePlugin({ id: 'surface-default', tokens: { accent: 'var(--vcp-accent-color)', surface: 'var(--vcp-surface-color)' } });
    const pluginLoader = createChatPluginLoader({ state: presentationState, slots });
    const skinHost = container.querySelector('.vcp-standalone-chat > header');
    const uninstallBadge = pluginLoader.install({
        id: 'readonly-badge', apiVersion: 1,
        capabilities: ['theme', 'surface-slot', 'presentation-state'], slots: ['header']
    }, ({ registerSlot, applyTheme, mountSkin }) => {
        registerSlot('header', 'badge', (host) => {
            host.textContent = '只读';
            host.setAttribute('aria-label', '只读聊天历史');
        });
        applyTheme(root, themePlugin);
        mountSkin(skinHost, skin);
    });
    const surface = createReadOnlyChatSurface({ root, renderer, repository, focusTarget: root, slots, presentationState, disposeRenderer: () => rendererOwner.dispose() });
    surface.mountSlot('header', container.querySelector('.vcp-standalone-chat > header'), { canSend: false });
    const onFocus = () => surface.focus();
    focusButton.addEventListener('click', onFocus);
    const load = chatSnapshot?.selectedItem?.id && chatSnapshot.topicId
        ? surface.loadHistory(chatSnapshot.selectedItem.id, chatSnapshot.selectedItem.type, chatSnapshot.topicId, { initialBatch: 5, batchSize: 10, batchDelay: 80 })
        : Promise.resolve({ history: [], stale: false });
    load.then(result => {
        if (!result.stale) container.querySelector('.vcp-standalone-chat__status').textContent = `${result.history.length} 条消息`;
    }).catch(error => { container.querySelector('.vcp-standalone-chat__status').textContent = `加载失败：${error.message}`; });
    return async () => { focusButton.removeEventListener('click', onFocus); uninstallBadge(); await surface.dispose(); pluginLoader.dispose(); presentationState.dispose(); slots.dispose(); scope?.dispose?.('standalone-chat-unmounted'); container.replaceChildren(); };
}

register({ id: 'standalone-chat-history', title: '聊天历史', icon: 'chat', kind: 'internal', mount: mountStandaloneChat });
