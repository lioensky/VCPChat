// Dynamic settings slots. Schema owns ordinary controls; these slots own the
// two pieces of settings UI whose shape changes at runtime.

const DEFAULT_DIRECTOR_TEMPLATE = `【角色】
写清人物的身份、年龄、性格底色、外形气质与说话习惯。

【场景】
交代此刻发生了什么、和谁说话、情绪处在什么位置。

【指导】
像导演一样下达演绎要领：
- 语速与顿挫：
- 气息与虚实：
- 停顿与重音：
- 共鸣位置：
- 音色质感：
- 情绪起伏：`;

const normalizedPrompts = prompts => Array.isArray(prompts)
    ? prompts.map(prompt => String(prompt ?? '').trim()).filter(Boolean)
    : [];

class MimoDirectorSlot {
    constructor({ form, scope, manager = globalThis.window?.settingsManager, notify } = {}) {
        this.form = form;
        this.scope = scope;
        this.manager = manager;
        this.notify = notify || ((message, kind) => globalThis.window?.uiHelperFunctions?.showToastNotification?.(message, kind));
        this.host = null;
        this.input = null;
        this.list = null;
        this.prompts = [];
        this.release = null;
        this.rowScopes = new Set();
    }

    mount() {
        const host = this.form?.querySelector?.('.tts-director-settings');
        if (!host || !this.scope) return null;
        this.host = host;
        this.input = host.querySelector('#agentTtsDirectorPromptInput');
        this.list = host.querySelector('#agentTtsDirectorPromptsContainer');
        const add = host.querySelector('#addAgentTtsDirectorPromptBtn');
        const fill = host.querySelector('#fillAgentTtsDirectorTemplateBtn');
        if (!this.input || !this.list || !add || !fill) return null;

        this.slotScope = this.scope.child ? this.scope.child('mimo-director-slot') : this.scope;
        host.dataset.vcpSettingsSlot = 'mimo-director';
        this.prompts = normalizedPrompts(this.manager?.getTtsDirectorPrompts?.());
        this.render();
        this.slotScope.listen(add, 'mousedown', event => event.preventDefault(), undefined, 'mimo-director-add-guard');
        this.slotScope.listen(add, 'click', () => this.add(), undefined, 'mimo-director-add');
        this.slotScope.listen(fill, 'click', () => this.fillTemplate(), undefined, 'mimo-director-template');
        this.slotScope.listen(this.input, 'keydown', event => {
            if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
            event.preventDefault();
            this.add();
        }, undefined, 'mimo-director-submit');
        this.bindEditor(this.input, () => this.renderDraftState());
        this.resize(this.input, false);
        this.release = () => this.dispose();
        if (this.scope !== this.slotScope) {
            this.scope.own(() => this.dispose(), 'mimo-director-slot-owner', 'ui-slot');
        }
        return this;
    }

    dispose() {
        if (this.host?.dataset.vcpSettingsSlot === 'mimo-director') delete this.host.dataset.vcpSettingsSlot;
        this.host = null;
        this.input = null;
        this.list = null;
        this.rowScopes.forEach(rowScope => void rowScope.dispose?.('mimo-director-slot-released'));
        this.rowScopes.clear();
        if (this.slotScope && this.slotScope !== this.scope && this.slotScope.active) {
            this.slotScope.dispose?.('mimo-director-slot-disposed');
        }
        this.slotScope = null;
    }

    setPrompts(prompts) {
        this.prompts = normalizedPrompts(prompts);
        this.render();
    }

    getPrompts() {
        return [...this.prompts];
    }

    clearDraft() {
        if (!this.input) return;
        this.input.value = '';
        this.setEditing(false);
        this.resize(this.input, false);
    }

    add() {
        const prompt = this.input?.value?.trim() || '';
        if (!prompt) {
            this.notify('请先填写自然语言导演提示词。', 'warning');
            this.input?.focus();
            return;
        }
        this.prompts.push(prompt);
        this.manager?.setTtsDirectorPrompts?.(this.prompts);
        this.input.value = '';
        this.render();
        this.input.focus();
    }

    fillTemplate() {
        if (!this.input) return;
        const template = this.manager?.getTtsDirectorTemplate?.() || DEFAULT_DIRECTOR_TEMPLATE;
        const existing = this.input.value.trim();
        this.input.value = existing ? `${existing}\n\n${template}` : template;
        this.input.focus();
        this.resize(this.input, true);
    }

    remove(index) {
        this.prompts.splice(index, 1);
        this.manager?.setTtsDirectorPrompts?.(this.prompts);
        this.render();
    }

    bindEditor(editor, onInput) {
        if (!editor) return;
        this.scope.listen(editor, 'focus', () => {
            this.setEditing(true, editor);
            this.resize(editor, true);
        }, undefined, 'mimo-director-focus');
        this.scope.listen(editor, 'input', () => {
            onInput?.(editor.value);
            this.resize(editor, true);
        }, undefined, 'mimo-director-input');
        this.scope.listen(editor, 'blur', () => {
            this.setEditing(false, editor);
            this.resize(editor, false);
        }, undefined, 'mimo-director-blur');
    }

    bindRowEditor(editor, index, rowScope) {
        const listen = (target, type, handler, label) => rowScope.listen(target, type, handler, undefined, label);
        listen(editor, 'focus', () => {
            this.setEditing(true, editor);
            this.resize(editor, true);
        }, `mimo-director-row-${index}-focus`);
        listen(editor, 'input', () => {
            const trimmed = String(editor.value || '').trim();
            if (trimmed) this.prompts[index] = trimmed;
            this.manager?.setTtsDirectorPrompts?.(this.prompts);
            this.resize(editor, true);
        }, `mimo-director-row-${index}-input`);
        listen(editor, 'blur', () => {
            this.setEditing(false, editor);
            this.resize(editor, false);
            if (editor.value.trim()) return;
            this.remove(index);
        }, `mimo-director-row-${index}-blur`);
    }

    renderDraftState() {
        const manager = this.manager;
        manager?.setTtsDirectorPrompts?.(this.prompts);
    }

    render() {
        if (!this.list) return;
        const doc = this.list.ownerDocument || document;
        this.rowScopes.forEach(rowScope => void rowScope.dispose('mimo-director-rerender'));
        this.rowScopes.clear();
        this.list.replaceChildren();
        this.prompts.forEach((prompt, index) => {
            const rowScope = this.scope.child(`mimo-director-row-${index}`);
            this.rowScopes.add(rowScope);
            const row = doc.createElement('div');
            row.className = 'tts-director-item';
            const editor = doc.createElement('textarea');
            editor.className = 'tts-director-editor';
            editor.rows = 3;
            editor.value = prompt;
            editor.setAttribute('aria-label', `导演提示词 ${index + 1}`);
            this.bindRowEditor(editor, index, rowScope);
            this.resize(editor, false);
            const remove = doc.createElement('button');
            remove.type = 'button';
            remove.className = 'small-button tts-director-action-button';
            remove.innerHTML = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4L12 12M12 4L4 12"/></svg>';
            remove.title = '删除该导演提示词';
            remove.setAttribute('aria-label', `删除导演提示词 ${index + 1}`);
            rowScope.listen(remove, 'mousedown', event => event.preventDefault(), undefined, `mimo-director-row-${index}-guard`);
            rowScope.listen(remove, 'click', () => this.remove(index), undefined, `mimo-director-row-${index}-remove`);
            row.append(editor, remove);
            this.list.append(row);
        });
    }

    setEditing(editing, editor = this.input) {
        editor?.classList.toggle('is-editing', Boolean(editing));
        editor?.closest('.tts-director-item, .tts-director-composer')?.classList.toggle('is-editing', Boolean(editing));
    }

    resize(editor, expanded) {
        if (!editor) return;
        const baseHeight = 96;
        const maxHeight = 148;

        if (!expanded) {
            editor.style.height = `${baseHeight}px`;
            editor.rows = 3;
            editor.scrollTop = 0;
            return;
        }

        const lines = (editor.value || '').split('\n').length;
        if (lines <= 3 && (editor.value || '').length < 60) {
            editor.style.height = `${baseHeight}px`;
            editor.rows = 3;
            return;
        }

        editor.rows = 4;
        const scrollH = editor.scrollHeight;
        const targetHeight = Math.min(Math.max(scrollH || baseHeight, baseHeight), maxHeight);
        editor.style.height = `${targetHeight}px`;
    }
}

class SequentialSpeakerSlot {
    constructor({ form, scope, renderer = globalThis.window?.GroupRenderer } = {}) {
        this.form = form;
        this.scope = scope;
        this.renderer = renderer;
        this.host = null;
        this.slotScope = null;
    }

    mount() {
        const host = this.form?.querySelector?.('#sequentialSpeakerOrderList');
        if (!host || !this.scope) return null;
        this.host = host;
        const container = host.closest('#sequentialOrderContainer');
        const root = container || host;
        root.dataset.vcpSettingsSlot = 'sequential-speaker';
        this.slotScope = this.scope.child ? this.scope.child('sequential-speaker-slot') : this.scope;
        const externalRelease = this.renderer?.bindSequentialSpeakerSlot?.({ host, form: this.form });
        this.slotScope.own(() => {
            externalRelease?.();
            if (root.dataset.vcpSettingsSlot === 'sequential-speaker') delete root.dataset.vcpSettingsSlot;
            this.host = null;
        }, 'sequential-speaker-slot', 'ui-slot');
        this.release = () => this.dispose();
        if (this.scope !== this.slotScope) {
            this.scope.own(() => this.dispose(), 'sequential-speaker-slot-owner', 'ui-slot');
        }
        return this;
    }

    dispose() {
        if (this.slotScope && this.slotScope !== this.scope && this.slotScope.active) {
            this.slotScope.dispose?.('sequential-speaker-slot-disposed');
        }
        this.slotScope = null;
        this.host = null;
    }
}

export { DEFAULT_DIRECTOR_TEMPLATE, MimoDirectorSlot, SequentialSpeakerSlot };
