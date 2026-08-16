/* Assistant sidebar search presentation for Next UI. */
(function installAssistantSearchController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAssistantSearchControllerApi() {
    'use strict';

    class AssistantSearchController {
        constructor(options = {}) {
            this.document = options.document || globalThis.document;
            this.filter = options.filter || (() => {});
            this.scope = null;
            this.abortController = null;
            this.elements = null;
            this.mounted = false;
        }

        mount(scope = null) {
            if (this.mounted) return true;
            const header = this.document.querySelector('#tabContentAgents .agents-header');
            const trigger = this.document.getElementById('nextUiAgentSearchTrigger');
            const close = this.document.getElementById('nextUiAgentSearchClose');
            const input = this.document.getElementById('agentSearchInput');
            if (!header || !trigger || !close || !input) return false;
            this.mounted = true;
            this.scope = scope;
            this.elements = { header, trigger, close, input };
            if (!scope) {
                const AbortControllerConstructor = this.document.defaultView?.AbortController || AbortController;
                this.abortController = new AbortControllerConstructor();
            }
            const listen = (target, type, handler) => scope
                ? scope.listen(target, type, handler, undefined, `assistant-search:${type}`)
                : target.addEventListener(type, handler, { signal: this.abortController.signal });
            listen(trigger, 'click', () => this.setOpen(true, false));
            listen(close, 'click', () => this.setOpen(false));
            listen(input, 'keydown', event => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                this.setOpen(false);
            });
            this.document.querySelectorAll('.sidebar-tab-button').forEach(button => {
                listen(button, 'click', () => {
                    if (button.dataset.tab !== 'agents') this.setOpen(false);
                });
            });
            if (scope) scope.own(() => this.dispose(), 'assistant-search-controller', 'controller');
            return true;
        }

        setOpen(active, clear = !active) {
            if (!this.mounted) return;
            const { header, trigger, input } = this.elements;
            header.classList.toggle('is-searching', active);
            trigger.setAttribute('aria-expanded', String(active));
            if (clear) {
                input.value = '';
                this.filter('');
            }
            if (active) {
                if (this.scope) this.scope.animationFrame(() => input.focus(), 'focus-agent-search');
                else this.document.defaultView?.requestAnimationFrame(() => input.focus());
            } else if (this.document.activeElement === input) trigger.focus();
        }

        dispose() {
            if (!this.mounted) return;
            const { header, trigger, input } = this.elements;
            this.mounted = false;
            this.abortController?.abort();
            this.abortController = null;
            header.classList.remove('is-searching');
            trigger.setAttribute('aria-expanded', 'false');
            input.value = '';
            this.filter('');
            this.elements = null;
            this.scope = null;
        }
    }

    return { AssistantSearchController };
});
