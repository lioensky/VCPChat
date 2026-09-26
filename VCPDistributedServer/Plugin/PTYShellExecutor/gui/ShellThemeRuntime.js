// ShellViewer 的主题快照消费、样式热换与 xterm 调色。

(() => {
    'use strict';

    class ShellThemeController {
        constructor({ getTerminal, fitTerminal }) {
            this.getTerminal = getTerminal;
            this.fitTerminal = fitTerminal;
            this.latestState = null;
            this.applicationToken = 0;
            this.stylesheetToken = 0;
            this.requestedRevision = null;
            this.stylesheet = document.getElementById('app-theme-stylesheet');
            this.stylesheetBaseHref = this.stylesheet?.getAttribute('href')
                || '../../../../styles/themes.css';
        }

        normalize(themeState) {
            if (typeof themeState === 'string') {
                const resolvedMode = themeState === 'light' ? 'light' : 'dark';
                return { mode: resolvedMode, resolvedMode, revision: 0 };
            }

            return {
                mode: ['light', 'dark', 'system'].includes(themeState?.mode)
                    ? themeState.mode
                    : 'system',
                resolvedMode: themeState?.resolvedMode === 'light' ? 'light' : 'dark',
                revision: Number.isFinite(themeState?.revision) ? themeState.revision : 0
            };
        }

        refreshStylesheet(revision) {
            if (!this.stylesheet || this.requestedRevision === revision) {
                return Promise.resolve();
            }

            this.requestedRevision = revision;
            const requestToken = ++this.stylesheetToken;
            const candidate = this.stylesheet.cloneNode(false);
            const themeUrl = new URL(this.stylesheetBaseHref, document.baseURI);
            themeUrl.searchParams.set('revision', String(revision));
            candidate.removeAttribute('id');
            candidate.media = 'not all';
            candidate.href = themeUrl.href;
            this.stylesheet.after(candidate);

            return new Promise((resolve) => {
                let settled = false;
                const finish = (loaded) => {
                    if (settled) return;
                    settled = true;

                    if (loaded && requestToken === this.stylesheetToken) {
                        const previous = this.stylesheet;
                        candidate.id = 'app-theme-stylesheet';
                        candidate.media = 'all';
                        this.stylesheet = candidate;
                        previous.remove();
                    } else {
                        if (requestToken === this.stylesheetToken) this.requestedRevision = null;
                        candidate.remove();
                    }
                    resolve();
                };

                candidate.addEventListener('load', () => finish(true), { once: true });
                candidate.addEventListener('error', () => finish(false), { once: true });
                setTimeout(() => finish(false), 2000);
            });
        }

        cssVariable(variable) {
            return getComputedStyle(document.body).getPropertyValue(variable).trim();
        }

        buildTerminalTheme(isLight) {
            const css = variable => this.cssVariable(variable);
            return {
                background: 'transparent',
                foreground: css('--primary-text') || (isLight ? '#383a42' : '#b5bfd1'),
                cursor: css('--highlight-text') || (isLight ? '#4b6f85' : '#e5c07b'),
                cursorAccent: css('--primary-bg') || (isLight ? '#f5f3ed' : '#1a1d23'),
                selectionBackground: css('--accent-bg') || (isLight ? '#e8e6e0' : '#2c313a'),
                selectionForeground: css('--primary-text') || (isLight ? '#383a42' : '#b5bfd1'),
                black: css('--tertiary-bg') || (isLight ? '#fafaf8' : '#1e2127'),
                red: css('--danger-color') || '#e06c75',
                green: css('--success-color') || '#98c379',
                yellow: css('--quoted-text') || '#e5c07b',
                blue: css('--button-bg') || (isLight ? '#4b6f85' : '#e5c07b'),
                magenta: css('--highlight-text') || (isLight ? '#4b6f85' : '#e5c07b'),
                cyan: css('--secondary-text') || (isLight ? '#9ca0a4' : '#586374'),
                white: css('--primary-text') || (isLight ? '#383a42' : '#b5bfd1'),
                brightBlack: css('--secondary-text') || (isLight ? '#9ca0a4' : '#586374'),
                brightRed: css('--danger-hover-bg') || '#d45a62',
                brightGreen: css('--success-color') || '#98c379',
                brightYellow: css('--quoted-text') || '#e5c07b',
                brightBlue: css('--button-hover-bg') || (isLight ? '#3d5a6d' : '#d9b56f'),
                brightMagenta: css('--highlight-text') || (isLight ? '#4b6f85' : '#e5c07b'),
                brightCyan: css('--secondary-text') || (isLight ? '#9ca0a4' : '#586374'),
                brightWhite: css('--primary-text') || (isLight ? '#383a42' : '#b5bfd1')
            };
        }

        applyTerminalTheme(isLight) {
            const terminal = this.getTerminal();
            if (!terminal) return;
            terminal.options.theme = this.buildTerminalTheme(isLight);
            terminal.refresh(0, terminal.rows - 1);
            this.fitTerminal();
        }

        /** 应用插件主题快照；system 模式只使用已经解析的 resolvedMode。 */
        async apply(themeState) {
            const normalized = this.normalize(themeState);
            this.latestState = normalized;
            const applicationToken = ++this.applicationToken;
            const isLight = normalized.resolvedMode === 'light';

            document.body.classList.toggle('light-theme', isLight);
            document.body.dataset.themeMode = normalized.mode;
            document.body.dataset.resolvedTheme = normalized.resolvedMode;
            await this.refreshStylesheet(normalized.revision);
            if (applicationToken !== this.applicationToken || this.latestState !== normalized) return;

            const scheduleFrame = window.requestAnimationFrame || (callback => setTimeout(callback, 0));
            scheduleFrame(() => {
                if (applicationToken === this.applicationToken) this.applyTerminalTheme(isLight);
            });
        }
    }

    window.ShellThemeRuntime = Object.freeze({
        createThemeController: options => new ShellThemeController(options)
    });
})();
