/* Next account menu presentation and theme-state synchronization. */
(function installAccountMenuController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAccountMenuControllerApi() {
    'use strict';

    class AccountMenuController {
        constructor(options = {}) {
            this.window = options.window || globalThis.window;
            this.document = options.document || this.window.document;
            this.getSettings = options.getSettings || (() => ({}));
            this.openSettings = options.openSettings || (() => {});
            this.openAppearance = options.openAppearance || (() => {});
            this.openThemes = options.openThemes || (() => {});
            this.setThemeMode = options.setThemeMode || (() => false);
            this.toggleTheme = options.toggleTheme || (() => {});
            this.syncAppearance = options.syncAppearance || (() => {});
            this.setIcon = options.setIcon || null;
            this.getMenuRegistry = options.getMenuRegistry || (() => this.window.VCPContributions?.menus);
            this.executeCommand = options.executeCommand || ((id) => this.window.VCPContributions?.commands.execute(id));
            this.subscribeTheme = options.subscribeTheme || null;
            this.scope = null;
            this.abortController = null;
            this.observer = null;
            this.elements = null;
            this.mounted = false;
            this.menuSubscriptionDisposer = null;
            this.themeSubscriptionDisposer = null;
        }

        mount(scope = null) {
            if (this.mounted) return true;
            const byId = id => this.document.getElementById(id);
            const elements = {
                dock: this.document.querySelector('.next-ui-account-dock'),
                menu: byId('nextUiAccountMenu'), trigger: byId('nextUiAccountMenuTrigger'),
                avatar: byId('nextUiAccountAvatar'), userName: byId('nextUiAccountName'),
                settingsButton: byId('nextUiAccountSettingsBtn'),
                appearanceButton: byId('nextUiAccountAppearanceStudioBtn'),
                themeStoreButton: byId('nextUiAccountThemeStoreBtn'),
                themeToggleButton: byId('nextUiAccountThemeToggleBtn'),
                themeIcon: byId('nextUiAccountThemeIcon'), themeLabel: byId('nextUiAccountThemeLabel'),
                topbarThemeButton: byId('nextUiThemeBtn'),
            };
            if (!elements.dock || !elements.menu || !elements.trigger || !elements.avatar || !elements.userName) return false;
            elements.topbarThemeIcon = elements.topbarThemeButton?.querySelector('.vcp-ui-icon');
            elements.contributionHost = this.document.createElement('div');
            elements.contributionHost.className = 'next-ui-account-menu-contributions';
            elements.contributionHost.dataset.contributionLocation = 'account';
            elements.menu.append(elements.contributionHost);
            this.mounted = true;
            this.scope = scope;
            this.elements = elements;
            if (!scope) {
                const AbortControllerConstructor = this.window.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
            }
            const listen = (target, type, handler) => {
                if (!target) return;
                if (scope) scope.listen(target, type, handler, undefined, `account-menu:${type}`);
                else target.addEventListener(type, handler, { signal: this.abortController.signal });
            };
            listen(elements.avatar, 'error', () => {
                if (!elements.avatar.src.endsWith('/assets/default_user_avatar.png')) elements.avatar.src = 'assets/default_user_avatar.png';
            });
            listen(elements.trigger, 'click', event => { event.stopPropagation(); this.setOpen(elements.menu.hidden); });
            listen(elements.settingsButton, 'click', () => { this.setOpen(false); this.openSettings(); });
            listen(elements.appearanceButton, 'click', () => { this.setOpen(false); this.openAppearance(elements.appearanceButton); });
            listen(elements.themeStoreButton, 'click', () => { this.setOpen(false); this.openThemes(); });
            listen(elements.themeToggleButton, 'click', () => {
                const nextTheme = this.document.body.classList.contains('dark-theme') ? 'light' : 'dark';
                this.setOpen(false);
                if (!this.setThemeMode(nextTheme)) this.toggleTheme();
            });
            listen(elements.contributionHost, 'click', event => {
                const button = event.target.closest('[data-contribution-command]');
                if (!button) return;
                this.setOpen(false);
                Promise.resolve(this.executeCommand(button.dataset.contributionCommand)).catch(error => {
                    console.error('[NextUI] Account menu contribution failed:', error);
                });
            });
            listen(this.document, 'pointerdown', event => {
                if (!elements.menu.hidden && !elements.dock.contains(event.target)) this.setOpen(false);
            });
            listen(this.document, 'keydown', event => {
                if (event.key !== 'Escape' || elements.menu.hidden) return;
                event.preventDefault();
                this.setOpen(false);
                elements.trigger.focus();
            });
            listen(this.document, 'next-ui-overlay-changed', event => {
                if (event.detail?.active === true) this.setOpen(false);
            });
            listen(this.window, 'global-settings-updated', () => this.sync());
            if (this.subscribeTheme) {
                const subscribe = () => this.subscribeTheme(() => this.sync(), { immediate: false });
                if (scope) scope.subscribe(subscribe, 'account-theme-state');
                else this.themeSubscriptionDisposer = subscribe();
            } else {
                const Observer = this.window.MutationObserver;
                if (Observer) {
                    this.observer = new Observer(() => this.sync());
                    if (scope) scope.observe(this.observer, this.document.body, { attributes: true, attributeFilter: ['class'] }, 'account-theme-observer');
                    else this.observer.observe(this.document.body, { attributes: true, attributeFilter: ['class'] });
                }
            }
            if (scope) scope.own(() => this.dispose(), 'account-menu-controller', 'controller');
            const menuRegistry = this.getMenuRegistry();
            if (menuRegistry?.subscribe) {
                const subscribe = () => menuRegistry.subscribe(change => {
                    if (change.contribution?.location === 'account') this.renderContributions();
                });
                if (scope) scope.subscribe(subscribe, 'account-menu-contributions');
                else this.menuSubscriptionDisposer = subscribe();
            }
            this.renderContributions();
            this.sync();
            return true;
        }

        sync() {
            if (!this.mounted) return;
            const e = this.elements;
            const settings = this.getSettings() || {};
            e.userName.textContent = settings.userName?.trim() || '用户';
            const avatar = settings.userAvatarUrl || 'assets/default_user_avatar.png';
            if (e.avatar.getAttribute('src') !== avatar) e.avatar.src = avatar;
            this.syncAppearance();
            const isDark = this.document.body.classList.contains('dark-theme');
            const label = isDark ? '切换为浅色模式' : '切换为深色模式';
            const icon = isDark ? 'dark_mode' : 'light_mode';
            if (e.themeIcon) this.setIcon ? this.setIcon(e.themeIcon, icon) : e.themeIcon.textContent = icon;
            if (e.themeLabel) e.themeLabel.textContent = label;
            e.themeToggleButton?.setAttribute('aria-label', label);
            e.themeToggleButton?.setAttribute('aria-pressed', String(isDark));
            if (e.topbarThemeIcon) this.setIcon ? this.setIcon(e.topbarThemeIcon, icon) : e.topbarThemeIcon.textContent = icon;
            e.topbarThemeButton?.setAttribute('aria-label', label);
            e.topbarThemeButton?.setAttribute('title', label);
        }

        renderContributions() {
            if (!this.mounted || !this.elements?.contributionHost) return;
            const host = this.elements.contributionHost;
            host.replaceChildren();
            const items = this.getMenuRegistry()?.list?.(item => item.location === 'account') || [];
            items.sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0) || left.title.localeCompare(right.title));
            items.forEach(item => {
                const button = this.document.createElement('button');
                button.type = 'button';
                button.className = 'next-ui-account-menu-item';
                button.setAttribute('role', 'menuitem');
                button.dataset.contributionId = item.id;
                button.dataset.contributionCommand = item.command;
                if (item.icon) {
                    const icon = this.document.createElement('span');
                    icon.className = 'vcp-ui-icon';
                    icon.setAttribute('aria-hidden', 'true');
                    if (this.setIcon) this.setIcon(icon, item.icon);
                    else icon.textContent = item.icon;
                    button.append(icon);
                }
                const label = this.document.createElement('span');
                label.className = 'next-ui-account-menu-label';
                label.textContent = item.title;
                button.append(label);
                host.append(button);
            });
            host.hidden = items.length === 0;
        }

        setOpen(open) {
            if (!this.mounted) return;
            this.elements.menu.hidden = !open;
            this.elements.trigger.setAttribute('aria-expanded', String(open));
            if (open) this.sync();
        }

        open() { this.setOpen(true); }
        close() { this.setOpen(false); }

        dispose() {
            if (!this.mounted) return;
            this.close();
            this.mounted = false;
            this.abortController?.abort();
            this.observer?.disconnect();
            this.menuSubscriptionDisposer?.();
            this.themeSubscriptionDisposer?.();
            this.elements?.contributionHost?.remove();
            this.abortController = null;
            this.observer = null;
            this.menuSubscriptionDisposer = null;
            this.themeSubscriptionDisposer = null;
            this.elements = null;
            this.scope = null;
        }
    }

    return { AccountMenuController };
});
