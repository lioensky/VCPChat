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
            this.subscribeTheme = options.subscribeTheme || null;
            this.scope = null;
            this.abortController = null;
            this.observer = null;
            this.elements = null;
            this.mounted = false;
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
            listen(this.document, 'pointerdown', event => {
                if (!elements.menu.hidden && !elements.dock.contains(event.target)) this.setOpen(false);
            });
            listen(this.document, 'keydown', event => {
                if (event.key !== 'Escape' || elements.menu.hidden) return;
                event.preventDefault();
                this.setOpen(false);
                elements.trigger.focus();
            });
            listen(elements.menu, 'keydown', event => this.handleMenuKeydown(event));
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

        setOpen(open) {
            if (!this.mounted) return;
            this.elements.menu.hidden = !open;
            this.elements.trigger.setAttribute('aria-expanded', String(open));
            if (open) {
                this.sync();
                this.menuItems()[0]?.focus();
            }
        }

        menuItems() {
            if (!this.elements?.menu) return [];
            return [...this.elements.menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled && !item.hidden);
        }

        handleMenuKeydown(event) {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = this.menuItems();
            const current = items.indexOf(this.document.activeElement);
            if (!items.length) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0
                : event.key === 'End' ? items.length - 1
                    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        }

        open() { this.setOpen(true); }
        close() { this.setOpen(false); }

        dispose() {
            if (!this.mounted) return;
            this.close();
            this.mounted = false;
            this.abortController?.abort();
            this.observer?.disconnect();
            this.themeSubscriptionDisposer?.();
            this.abortController = null;
            this.observer = null;
            this.themeSubscriptionDisposer = null;
            this.elements = null;
            this.scope = null;
        }
    }

    return { AccountMenuController };
});
