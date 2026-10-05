/* Side pane new tab page: assistant profile, tool / app / notification sections and the open-tab entry registry. */
'use strict';
import { createSidePaneEntries } from './side-pane-entries.js';

/**
 * 新标签页（引导页）：上面地址栏，下面工具入口。工具入口由各模块通过 registerEntry 自己登记，
 * 「+」按钮和面板空着时展开也按登记的入口决定打开什么。
 *   isNotificationsActive()   通知标签是不是当前标签（通知页是新标签页里的一个分类）
 *   showNotifications() / showLauncher() / hideMenus()
 *   onEntriesChanged()        入口变化后标签条要重新排（「+」按钮可能出现或消失）
 */
export function createSidePaneLauncher({
    contentContainer,
    addButton = null,
    isNotificationsActive,
    showNotifications,
    showLauncher,
    hideMenus = () => {},
    onEntriesChanged = () => {}
}) {
    const view = contentContainer?.querySelector?.('#sidePaneViewLauncher') || null;
    const doc = (view || contentContainer || addButton)?.ownerDocument || globalThis.document;
    const cleanups = [];
    let disposed = false;

    const find = (parent, selector) => parent?.querySelector?.(selector) || null;
    const list = find(view, '.side-pane-open-tab-list');
    const toolsSection = find(view, '[data-launcher-section="tools"]');
    const profile = find(view, '.side-pane-launcher-profile');
    const profileAvatar = find(profile, '.side-pane-launcher-avatar');
    const profileImage = find(profileAvatar, 'img');
    const profileName = find(profile, '.side-pane-launcher-name');
    const segmentTabs = find(view, '.side-pane-launcher-tabs');
    const appsSection = find(view, '[data-launcher-section="apps"]');
    const appGrid = find(appsSection, '.side-pane-launcher-app-grid');
    const notificationsSection = find(view, '[data-launcher-section="notifications"]');
    const notificationsSegmentBtn = find(view, '[data-launcher-tab="notifications"]');
    const toolsGroup = find(toolsSection, '[data-launcher-group="tools"]');
    const recommendedGroup = find(toolsSection, '[data-launcher-group="recommended"]');
    const recommendedRow = find(recommendedGroup, '.side-pane-launcher-recommended-row');
    const recommendedAction = find(recommendedGroup, '.side-pane-launcher-group-action');

    let profileProvider = null;
    let profileEdit = null;
    let profileRename = null;
    let profileNameValue = '';
    let nameEdit = null;
    let appsProvider = null;
    let apps = new Map();
    let recommendedProvider = null;
    let recommendedSettings = null;
    let recommended = new Map();
    let segment = 'tools';

    const entriesOwner = createSidePaneEntries({ doc, list, addButton, hideMenus, syncSections, onEntriesChanged });
    const { availableEntries, registerEntry, renderEntries, runEntry } = entriesOwner;

    // ---- 当前助手的头像和名字；每次打开新标签页时现取，改了头像或名字也能跟上 ----
    function renderProfile() {
        if (!profile) return;
        let current = null;
        try {
            current = profileProvider?.() || null;
        } catch (error) {
            console.warn('[SidePaneLauncher] Failed to read launcher profile:', error);
        }
        profile.hidden = !current;
        profileEdit = typeof current?.onEditAvatar === 'function' ? current.onEditAvatar : null;
        profileRename = typeof current?.onRename === 'function' ? current.onRename : null;
        if (!current) return;
        profileNameValue = current.name || '';
        if (profileName) {
            // 正在改名时不覆盖输入框
            if (!nameEdit) profileName.value = profileNameValue;
            profileName.readOnly = !profileRename;
            profileName.title = profileRename ? '编辑名称' : '';
        }
        if (profileImage) {
            const src = current.avatarUrl || 'assets/default_avatar.png';
            if (profileImage.getAttribute('src') !== src) profileImage.setAttribute('src', src);
        }
        if (profileAvatar) {
            profileAvatar.disabled = !profileEdit;
            profileAvatar.setAttribute('aria-label', profileEdit ? '编辑头像' : (current.name || '头像'));
        }
    }

    if (profileAvatar) {
        const onAvatarClick = () => {
            if (profileEdit) profileEdit();
        };
        profileAvatar.addEventListener('click', onAvatarClick);
        cleanups.push(() => profileAvatar.removeEventListener('click', onAvatarClick));
    }

    // 名字点一下就能改：回车或点别处保存，Esc 放弃；空名字不保存
    if (profileName) {
        const onNameFocus = () => {
            if (profileName.readOnly || !profileRename) return;
            nameEdit = { rename: profileRename, original: profileNameValue };
        };
        const onNameKeydown = (e) => {
            if (!nameEdit) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                profileName.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                profileName.value = nameEdit.original;
                profileName.blur();
            }
        };
        const onNameBlur = async () => {
            const edit = nameEdit;
            nameEdit = null;
            if (!edit) return;
            const next = profileName.value.trim();
            if (!next || next === edit.original) {
                profileName.value = edit.original;
                return;
            }
            profileName.value = next;
            try {
                const result = await edit.rename(next);
                if (result === false || result?.error) throw new Error(result?.error || 'rename-failed');
                if (profileNameValue === edit.original) profileNameValue = next;
            } catch (error) {
                console.warn('[SidePaneLauncher] Failed to rename:', error);
                if (!nameEdit && profileName.value === next) profileName.value = edit.original;
            }
        };
        profileName.addEventListener('focus', onNameFocus);
        profileName.addEventListener('keydown', onNameKeydown);
        profileName.addEventListener('blur', onNameBlur);
        cleanups.push(() => {
            profileName.removeEventListener('focus', onNameFocus);
            profileName.removeEventListener('keydown', onNameKeydown);
            profileName.removeEventListener('blur', onNameBlur);
        });
    }

    // ---- 工具 / 应用 / 通知 三个分类 ----
    // 通知分类就是状态里的通知标签（关完标签后的兜底也落在这里），工具和应用记在 segment 里；
    // 没有应用来源也没有通知分类时不显示切换条
    function currentSegment() {
        return notificationsSection && isNotificationsActive() ? 'notifications' : segment;
    }

    function syncSections() {
        if (!appsProvider) segment = 'tools';
        const shown = currentSegment();
        if (segmentTabs) {
            segmentTabs.hidden = !appsProvider && !notificationsSection;
            segmentTabs.querySelectorAll('[data-launcher-tab]').forEach(btn => {
                const key = btn.getAttribute('data-launcher-tab');
                btn.hidden = key === 'apps' && !appsProvider;
                const selected = key === shown;
                btn.setAttribute('aria-selected', String(selected));
                btn.tabIndex = selected ? 0 : -1;
            });
        }
        if (view) view.dataset.launcherSegment = shown;
        const hasEntries = availableEntries().length > 0;
        if (toolsGroup) toolsGroup.hidden = !hasEntries;
        if (toolsSection) toolsSection.hidden = shown !== 'tools' || (!hasEntries && recommended.size === 0);
        if (appsSection) appsSection.hidden = shown !== 'apps';
        if (notificationsSection) notificationsSection.hidden = shown !== 'notifications';
    }

    function selectSegment(next) {
        if (next === 'notifications' && notificationsSection) {
            showNotifications();
            return;
        }
        const target = next === 'apps' && appsProvider ? 'apps' : 'tools';
        if (isNotificationsActive()) {
            segment = target;
            showLauncher();
            return;
        }
        if (target === segment) return;
        segment = target;
        renderSegment();
        syncSections();
    }

    function readItems(provider, what) {
        try {
            return provider?.() || [];
        } catch (error) {
            console.warn(`[SidePaneLauncher] Failed to read launcher ${what}:`, error);
            return [];
        }
    }

    // 应用页和推荐共用的大图标卡片；返回 id -> 条目，点击时按所在区域查表
    function renderCards(container, items) {
        const registry = new Map();
        const mounts = [];
        container.replaceChildren(...items.filter(app => app?.id && !registry.has(app.id)).map(app => {
            registry.set(app.id, app);
            const btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = 'side-pane-launcher-app';
            btn.setAttribute('data-launcher-app', app.id);
            if (app.title) btn.title = app.title;
            const iconEl = doc.createElement('span');
            iconEl.className = 'side-pane-launcher-app-icon';
            iconEl.setAttribute('aria-hidden', 'true');
            const labelEl = doc.createElement('span');
            labelEl.className = 'side-pane-launcher-app-label';
            labelEl.textContent = app.label || app.id;
            btn.append(iconEl, labelEl);
            if (typeof app.mountIcon === 'function') mounts.push(() => app.mountIcon(btn, iconEl));
            return btn;
        }));
        mounts.forEach(mount => {
            try {
                mount();
            } catch (error) {
                console.warn('[SidePaneLauncher] Failed to draw launcher app icon:', error);
            }
        });
        return registry;
    }

    function renderApps() {
        if (!appGrid) return;
        apps = renderCards(appGrid, readItems(appsProvider, 'apps'));
    }

    function renderRecommended() {
        if (recommendedRow) {
            recommended = renderCards(recommendedRow, recommendedProvider ? readItems(recommendedProvider, 'recommendations') : []);
        }
        if (recommendedGroup) recommendedGroup.hidden = recommended.size === 0;
        if (recommendedAction) recommendedAction.hidden = !recommendedSettings;
        syncSections();
    }

    function renderSegment() {
        if (segment === 'apps') renderApps();
        else renderRecommended();
    }

    async function runApp(appId, registry) {
        const app = registry.get(appId);
        if (!app || disposed) return;
        try {
            await app.open();
        } catch (error) {
            console.error(`[SidePaneLauncher] Failed to open app "${appId}":`, error);
        }
    }

    if (segmentTabs) {
        const onTabsKeydown = (e) => {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const tabs = [...segmentTabs.querySelectorAll('[data-launcher-tab]:not([hidden])')];
            const index = tabs.findIndex(btn => btn.getAttribute('data-launcher-tab') === currentSegment());
            const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
            if (!next) return;
            e.preventDefault();
            selectSegment(next.getAttribute('data-launcher-tab'));
            next.focus();
        };
        segmentTabs.addEventListener('keydown', onTabsKeydown);
        cleanups.push(() => segmentTabs.removeEventListener('keydown', onTabsKeydown));
    }

    if (view) {
        const onViewClick = (e) => {
            const entryBtn = e.target.closest('[data-open-tab-entry]');
            if (entryBtn) {
                runEntry(entryBtn.getAttribute('data-open-tab-entry'));
                return;
            }
            const segmentBtn = e.target.closest('[data-launcher-tab]');
            if (segmentBtn) {
                selectSegment(segmentBtn.getAttribute('data-launcher-tab'));
                return;
            }
            const appBtn = e.target.closest('[data-launcher-app]');
            if (appBtn) {
                runApp(appBtn.getAttribute('data-launcher-app'), recommendedRow?.contains(appBtn) ? recommended : apps);
                return;
            }
            if (recommendedAction?.contains(e.target)) {
                try {
                    recommendedSettings?.();
                } catch (error) {
                    console.error('[SidePaneLauncher] Failed to open recommendation settings:', error);
                }
            }
        };
        view.addEventListener('click', onViewClick);
        cleanups.push(() => view.removeEventListener('click', onViewClick));
    }

    if (addButton) {
        // 和浏览器一样，「+」打开新标签页；只登记了一个入口时直接打开它
        const onAddClick = (e) => {
            e.stopPropagation();
            const entries = availableEntries();
            if (entries.length === 0) return;
            if (entries.length === 1) {
                runEntry(entries[0].id);
                return;
            }
            hideMenus();
            showLauncher();
        };
        addButton.addEventListener('click', onAddClick);
        cleanups.push(() => addButton.removeEventListener('click', onAddClick));
    }

    return Object.freeze({
        // 通知放进新标签页的“通知”分类时，通知页仍是首页/兜底，只是不再占标签条上的位置
        hostsNotifications: Boolean(notificationsSection),
        availableEntries,
        registerEntry,
        renderEntries,
        renderProfile,
        renderSegment,
        syncSections,

        // 面板里没有可关的标签时展开：只有一个入口就直接打开它，否则显示新标签页
        async expandFromEmpty() {
            const entries = availableEntries();
            if (entries.length === 1) await runEntry(entries[0].id);
            else showLauncher();
        },

        syncStatus(current) {
            if (!notificationsSegmentBtn || !current) return;
            const segmentDot = notificationsSegmentBtn.querySelector('.side-pane-launcher-tab-status');
            if (segmentDot) segmentDot.dataset.status = current.status || 'unknown';
            const label = (current.text || '').replace(/:\s*/, ' ');
            notificationsSegmentBtn.title = label;
            if (label) notificationsSegmentBtn.setAttribute('aria-label', `通知，${label}`);
            else notificationsSegmentBtn.removeAttribute('aria-label');
        },

        setProfileProvider(provider) {
            profileProvider = typeof provider === 'function' ? provider : null;
            renderProfile();
        },

        setAppsProvider(provider) {
            appsProvider = typeof provider === 'function' ? provider : null;
            if (!appsProvider) segment = 'tools';
            syncSections();
            if (segment === 'apps') renderApps();
        },

        setRecommendedProvider(provider, { onSettings = null } = {}) {
            recommendedProvider = typeof provider === 'function' ? provider : null;
            recommendedSettings = typeof onSettings === 'function' ? onSettings : null;
            renderRecommended();
        },

        refreshRecommended() {
            renderRecommended();
        },

        dispose() {
            disposed = true;
            entriesOwner.dispose();
            cleanups.forEach(cleanup => cleanup());
            cleanups.length = 0;
        }
    });
}
