/* Next assistant/group creation surface and async ownership. */
(function installCreationController(globalObject, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (globalObject) {
        const namespace = globalObject.VCPNextShell || {};
        globalObject.VCPNextShell = Object.freeze({ ...namespace, ...api });
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCreationControllerApi() {
    'use strict';

    function normalizeModelOptions(payload) {
        let models = payload;
        if (!Array.isArray(models)) models = payload?.data || payload?.models || (payload?.id ? [payload] : []);
        if (!Array.isArray(models)) return [];
        const seen = new Set();
        return models.reduce((options, item) => {
            const id = typeof item === 'string' ? item : item?.id;
            if (!id || seen.has(id)) return options;
            seen.add(id);
            options.push({ value: id, label: typeof item === 'string' ? item : item.name || item.displayName || id });
            return options;
        }, []);
    }

    class CreationController {
        constructor(options = {}) {
            this.window = options.window || globalThis.window;
            this.document = options.document || this.window.document;
            this.getUi = options.getUi || (() => this.window.VCPUI);
            this.getApi = options.getApi || (() => this.window.chatAPI || this.window.electronAPI);
            this.getTasks = options.getTasks || (() => this.window.VCPTasks);
            this.commands = options.commands || (() => this.window.MainChatCommands);
            this.getDensity = options.getDensity || (() => 'comfortable');
            this.acquireOverlay = options.acquireOverlay || (() => Promise.resolve());
            this.releaseOverlay = options.releaseOverlay || (() => {});
            this.showUnavailable = options.showUnavailable || (() => {});
            this.scope = null;
            this.activeModal = null;
            this.mounted = false;
            this.generation = 0;
        }

        mount(scope = null) {
            if (this.mounted) return;
            this.mounted = true;
            this.scope = scope;
            this.generation += 1;
            if (scope) scope.own(() => this.dispose(), 'creation-controller', 'controller');
        }

        close() { this.activeModal?.close(null); }

        async open() {
            if (!this.mounted) return;
            if (this.activeModal?.element?.isConnected) return void this.activeModal.focus();
            const ui = this.getUi();
            const api = this.getApi();
            const commands = this.commands();
            const generation = this.generation;
            if (!ui || !commands?.createAgent || !commands?.createGroup) {
                this.showUnavailable();
                return;
            }

            const host = this.document.createElement('div');
            host.className = 'next-ui-create-dialog-host vcp-ui-scope';
            host.dataset.density = this.getDensity();
            const form = this.document.createElement('form');
            form.className = 'next-ui-create-dialog-form';
            const typeControl = ui.create('SegmentedControl', {
                label: '创建类型', value: 'agent',
                items: [{ value: 'agent', label: '助手', icon: 'person' }, { value: 'group', label: '群组', icon: 'group' }]
            });
            const typeField = ui.create('Field', { label: '类型', required: true, helper: '创建一个可以独立对话的助手。', control: typeControl });
            typeField.element.classList.add('next-ui-create-dialog-type');
            const nameControl = ui.create('Input', { placeholder: '例如：旅行助手', leadingIcon: 'edit', required: true });
            const nameField = ui.create('Field', { label: '名称', required: true, helper: '创建后仍可在设置中修改名称和详细配置。', control: nameControl });
            const nameInput = nameControl.control;
            const modelControl = ui.create('Select', { value: '', disabled: true, options: [{ value: '', label: '使用默认模型' }] });
            const modelField = ui.create('Field', { label: '模型', helper: '正在读取可用模型…', control: modelControl });
            const error = this.document.createElement('div');
            error.className = 'next-ui-create-dialog-error';
            error.setAttribute('role', 'alert');
            error.setAttribute('aria-live', 'polite');
            form.append(typeField.element, nameField.element, modelField.element, error);
            const cancelButton = ui.create('Button', { label: '取消', variant: 'ghost' });
            const createButton = ui.create('Button', { label: '创建', variant: 'primary', type: 'submit' });
            const controls = [typeControl, typeField, nameControl, nameField, modelControl, modelField, cancelButton, createButton];
            const SurfaceController = this.window.VCPUISurface?.SurfaceController;
            const surface = SurfaceController ? new SurfaceController({
                window: this.window,
                document: this.document,
                label: 'next:create-item-modal',
                ownerScope: this.scope,
                getUi: this.getUi,
            }) : null;
            if (surface) {
                await surface.mount(host, context => {
                    controls.forEach((control, index) => context.own(control, `create-control:${index}`, 'ui-registration'));
                });
            }
            const dialogScope = surface?.scope || this.scope?.child('next:create-item-modal') || null;
            if (!surface) {
                dialogScope?.own(() => host.remove(), 'create-modal-host', 'dom');
                controls.forEach((control, index) => dialogScope?.own(() => control.destroy(), `create-control:${index}`, 'ui-registration'));
            }
            const disposeDialog = reason => surface?.dispose(reason) || dialogScope?.dispose(reason) || Promise.resolve();
            let kind = 'agent';
            let submitting = false;
            let cleaned = false;
            let modal;
            const overlayOwner = Symbol('create-item-modal-overlay');
            try {
                await this.acquireOverlay(overlayOwner);
            } catch (overlayError) {
                if (surface || dialogScope) await disposeDialog('create-overlay-failed');
                else controls.forEach(control => control.destroy());
                throw overlayError;
            }
            if (dialogScope && !dialogScope.active) {
                this.releaseOverlay(overlayOwner);
                return;
            }
            dialogScope?.own(() => this.releaseOverlay(overlayOwner), 'create-overlay-lease', 'overlay');
            if (!this.mounted || generation !== this.generation || this.document.documentElement.dataset.uiMode !== 'next') {
                if (surface || dialogScope) await disposeDialog('create-open-cancelled');
                else {
                    this.releaseOverlay(overlayOwner);
                    controls.forEach(control => control.destroy());
                }
                return;
            }
            const cleanup = () => {
                if (cleaned) return;
                cleaned = true;
                if (this.activeModal === modal) this.activeModal = null;
                if (surface || dialogScope) void disposeDialog('create-modal-closed').catch(reason => console.error('[NextUI] Failed to dispose create dialog:', reason));
                else {
                    this.releaseOverlay(overlayOwner);
                    controls.forEach(control => control.destroy());
                    host.remove();
                }
            };
            try {
                modal = ui.create('Modal', { title: '创建助手或群组', size: 'sm', content: form, actions: [cancelButton, createButton], onClose: cleanup });
            } catch (modalError) {
                if (surface || dialogScope) await disposeDialog('create-modal-failed');
                else {
                    this.releaseOverlay(overlayOwner);
                    controls.forEach(control => control.destroy());
                }
                throw modalError;
            }
            surface?.own(modal, 'create-modal', 'ui-registration');
            this.activeModal = modal;
            host.append(modal.element);
            this.document.body.append(host);

            const syncType = () => {
                const checked = typeControl.element.querySelector('[role="radio"][aria-checked="true"]');
                kind = checked?.dataset.value === 'group' ? 'group' : 'agent';
                typeField.update({ helper: kind === 'group' ? '创建一个由多个助手参与的群组会话。' : '创建一个可以独立对话的助手。' });
                nameInput.placeholder = kind === 'group' ? '例如：项目讨论组' : '例如：旅行助手';
                modelField.update({ helper: kind === 'group' ? '选中的模型将作为群组统一模型；也可以沿用默认设置。' : '选择助手的初始模型；也可以使用系统默认模型。' });
            };
            const submit = async () => {
                if (submitting) return;
                const name = nameInput.value.trim();
                if (!name) {
                    nameField.update({ error: '请输入名称。' });
                    nameInput.focus();
                    return;
                }
                submitting = true;
                error.textContent = '';
                nameField.update({ error: '' });
                createButton.update({ label: '创建中', loading: true });
                cancelButton.update({ disabled: true });
                const model = modelControl.getValue();
                try {
                    const tasks = this.getTasks();
                    const taskId = tasks?.createTaskId?.(`create-${kind}`) || `create-${kind}:${Date.now()}`;
                    const task = tasks?.createTask?.({
                        id: taskId,
                        start: (_id, signal) => kind === 'group'
                            ? commands.createGroup({ name, model, signal })
                            : commands.createAgent({ name, model, signal }),
                    });
                    const request = task?.promise || (kind === 'group'
                        ? commands.createGroup({ name, model })
                        : commands.createAgent({ name, model }));
                    const result = task && dialogScope
                        ? await task.own(dialogScope, `create-${kind}`)
                        : dialogScope
                            ? await dialogScope.track(request, `create-${kind}`)
                            : await request;
                    if ((dialogScope && !dialogScope.active) || this.activeModal !== modal || !modal.element.isConnected) return;
                    if (!result?.success) throw new Error(result?.error || '创建失败，请稍后重试。');
                    ui.feedback?.toast(
                        result.navigationSuccess === false
                            ? `${kind === 'group' ? '群组' : '助手'}“${name}”已创建，请刷新列表查看`
                            : `${kind === 'group' ? '群组' : '助手'}“${name}”已创建`,
                        { variant: result.navigationSuccess === false ? 'warning' : 'success' }
                    );
                    if (modal.element.isConnected) modal.close(true);
                } catch (creationError) {
                    console.error('[NextUI] Failed to create item:', creationError);
                    if (modal.element.isConnected) {
                        error.textContent = creationError.message || '创建失败，请稍后重试。';
                        createButton.update({ label: '创建', loading: false });
                        cancelButton.update({ disabled: false });
                        submitting = false;
                    } else ui.feedback?.toast(creationError.message || '创建失败，请稍后重试。', { variant: 'error' });
                }
            };
            const listen = (target, type, handler, options) => dialogScope
                ? dialogScope.listen(target, type, handler, options, `create-modal:${type}`)
                : target.addEventListener(type, handler, options);
            listen(typeControl.element, 'change', syncType);
            listen(nameInput, 'input', () => {
                if (nameField.element.dataset.state === 'error') nameField.update({ error: '' });
            });
            listen(cancelButton.element, 'click', () => modal.close(null));
            listen(createButton.element, 'click', submit);
            listen(form, 'submit', event => { event.preventDefault(); submit(); });
            if (dialogScope) dialogScope.animationFrame(() => nameInput.focus(), 'focus-create-name');
            else this.window.requestAnimationFrame(() => nameInput.focus());
            try {
                const tasks = this.getTasks();
                const modelTask = api?.getCachedModels && tasks?.createTask?.({
                    id: tasks.createTaskId?.('create-models') || `create-models:${Date.now()}`,
                    start: () => api.getCachedModels(),
                });
                const modelRequest = modelTask?.promise || api?.getCachedModels?.();
                const payload = modelTask && dialogScope
                    ? await modelTask.own(dialogScope, 'load-create-models')
                    : dialogScope && modelRequest
                        ? await dialogScope.track(modelRequest, 'load-create-models')
                        : await modelRequest;
                const options = normalizeModelOptions(payload);
                if (this.activeModal !== modal || !modal.element.isConnected) return;
                modelControl.update({ disabled: false, options: [{ value: '', label: '使用默认模型' }, ...options] });
                syncType();
            } catch (modelError) {
                console.warn('[NextUI] Failed to load cached models:', modelError);
                if (this.activeModal !== modal || !modal.element.isConnected) return;
                modelControl.update({ disabled: false, options: [{ value: '', label: '使用默认模型' }] });
                modelField.update({ helper: '模型列表暂不可用，将使用系统默认模型。' });
            }
        }

        dispose() {
            if (!this.mounted) return;
            this.mounted = false;
            this.generation += 1;
            this.close();
            this.scope = null;
        }
    }

    return { CreationController, normalizeModelOptions };
});
