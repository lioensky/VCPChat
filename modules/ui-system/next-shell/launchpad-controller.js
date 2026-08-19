/* Next launchpad application catalog renderer. */
(function installLaunchpadController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createLaunchpadControllerApi() {
    'use strict';
    const DEFAULT_TONES = ['purple', 'green', 'pink', 'cyan', 'amber', 'charcoal', 'red', 'orange'];

    class LaunchpadController {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.getExternalApps = options.getExternalApps || (() => []);
            this.getInternalApps = options.getInternalApps || (() => []);
            this.getIcon = options.getIcon || (() => '');
            this.openExternal = options.openExternal || (() => {});
            this.openEmbedded = options.openEmbedded || (() => {});
            this.openInternal = options.openInternal || (() => {});
            this.tones = options.tones || DEFAULT_TONES;
            this.scope = null;
            this.renderScope = null;
            this.mounted = false;
        }

        mount(scope = null) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope;
            if (scope) scope.own(() => this.dispose(), 'launchpad-controller', 'controller');
            this.render();
        }

        render() {
            if (!this.mounted) return;
            const grid = this.document.getElementById('nextUiAppGrid');
            if (!grid) return;
            if (this.renderScope) {
                const previous = this.renderScope;
                this.renderScope = null;
                void previous.dispose('launchpad-rerender').catch(error => console.error('[NextUI] Failed to dispose launchpad listeners:', error));
            }
            this.renderScope = this.scope?.child('next:app-grid') || null;
            const listen = (target, handler) => this.renderScope
                ? this.renderScope.listen(target, 'click', handler, undefined, 'launchpad:click')
                : target.addEventListener('click', handler);
            const listenKeydown = target => {
                const handler = event => {
                    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                    const buttons = [...grid.querySelectorAll('button.next-ui-app-item')];
                    const index = buttons.indexOf(this.document.activeElement);
                    if (!buttons.length || index < 0) return;
                    const columns = Math.max(1, Number.parseInt(this.document.defaultView?.getComputedStyle(grid).getPropertyValue('--app-grid-columns'), 10) || 1);
                    let next = index;
                    if (event.key === 'Home') next = 0;
                    else if (event.key === 'End') next = buttons.length - 1;
                    else if (event.key === 'ArrowRight') next = Math.min(buttons.length - 1, index + 1);
                    else if (event.key === 'ArrowLeft') next = Math.max(0, index - 1);
                    else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + columns);
                    else if (event.key === 'ArrowUp') next = Math.max(0, index - columns);
                    if (next === index) return;
                    event.preventDefault();
                    buttons[next].focus();
                };
                return this.renderScope
                    ? this.renderScope.listen(target, 'keydown', handler, undefined, 'launchpad:keydown')
                    : target.addEventListener('keydown', handler);
            };
            grid.replaceChildren();
            this.getExternalApps().filter(app => app.id !== 'vchat-app-main').forEach((app, index) => {
                const button = this.document.createElement('button');
                button.type = 'button';
                button.className = 'next-ui-app-item';
                button.dataset.openMode = app.embed ? 'embedded' : 'window';
                button.title = app.embed ? `${app.name}（在标签页中打开）` : `${app.name}（在独立窗口中打开）`;
                button.innerHTML = `<span class="next-ui-app-icon" data-tone="${this.tones[index % this.tones.length]}">${this.getIcon(app.icon)}</span><span>${app.name}</span>`;
                listen(button, () => app.embed ? this.openEmbedded(app) : this.openExternal(app));
                grid.append(button);
            });
            listenKeydown(grid);
            this.getInternalApps().forEach(app => {
                const button = this.document.createElement('button');
                button.type = 'button';
                button.className = 'next-ui-app-item next-ui-internal-app-item';
                button.title = app.title;
                const icon = this.document.createElement('span');
                icon.className = 'next-ui-app-icon vcp-ui-internal-app-icon vcp-ui-scope';
                if (app.icon) icon.append(Object.assign(this.document.createElement('span'), { className: 'vcp-ui-icon', textContent: app.icon }));
                else if (app.iconSvg) icon.innerHTML = app.iconSvg;
                const label = this.document.createElement('span');
                label.textContent = app.title;
                button.append(icon, label);
                listen(button, () => this.openInternal(app.id));
                grid.append(button);
            });
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            const current = this.renderScope;
            this.renderScope = null;
            if (current) void current.dispose('launchpad-dispose');
            this.scope = null;
        }
    }

    return { LaunchpadController };
});
