'use strict';

(() => {
    const INLINE_COMMANDS = Object.freeze([
        'bold',
        'italic',
        'underline',
        'strikethrough',
    ]);

    function createFormattingController(context = {}) {
        const elements = context.elements || {};
        const notificationPort = context.notificationPort || {};
        let editorPort = null;
        let syncFrame = null;
        let pendingTarget = null;
        let abortController = null;
        let disposed = false;

        function contextMenu() {
            return elements['text-context-menu'] || null;
        }

        function contextMenuOpen() {
            const menu = contextMenu();
            return Boolean(menu && !menu.hidden);
        }

        function hideContextMenu() {
            const menu = contextMenu();
            if (menu) menu.hidden = true;
            return true;
        }

        function positionContextMenu(menu, x, y) {
            menu.hidden = false;
            menu.style.left = '0px';
            menu.style.top = '0px';
            const rect = menu.getBoundingClientRect();
            const margin = 10;
            const left = Math.max(
                margin,
                Math.min(window.innerWidth - rect.width - margin, Number(x) || 0)
            );
            const top = Math.max(
                margin,
                Math.min(window.innerHeight - rect.height - margin, Number(y) || 0)
            );
            menu.style.left = `${left}px`;
            menu.style.top = `${top}px`;
        }

        function openContextMenu(input = {}) {
            const menu = contextMenu();
            const selection = input.selection || {};
            if (!menu || !selection.text || !selection.range) return false;
            const formatBar = elements['selection-format-bar'];
            if (formatBar) formatBar.hidden = false;
            menu.querySelector('[data-format-separator]')?.removeAttribute(
                'hidden'
            );
            menu.querySelectorAll('[data-requires-selection]').forEach(
                (control) => {
                    control.disabled = false;
                }
            );
            pendingTarget = input.event?.target || null;
            sync(pendingTarget);
            positionContextMenu(
                menu,
                input.event?.clientX,
                input.event?.clientY
            );
            return true;
        }

        function runTextAction(action) {
            const editor = currentEditor();
            if (action === 'copy' || action === 'cut') {
                document.execCommand(action);
                return true;
            }
            if (action === 'select-all') {
                document.execCommand('selectAll');
                editor?.captureSelection?.();
                return true;
            }
            if (action === 'insert-paragraph') {
                return editor?.insertStructure?.('paragraph') ?? false;
            }
            return false;
        }

        function assertActive() {
            if (disposed) throw new Error('Formatting controller has been disposed.');
        }

        function currentEditor() {
            assertActive();
            return editorPort || context.getEditorPort?.() || null;
        }

        function setEditorPort(nextEditorPort) {
            assertActive();
            if (!nextEditorPort
                || typeof nextEditorPort.executeFormatting !== 'function') {
                throw new TypeError(
                    'Formatting controller requires an EditorPort with executeFormatting().'
                );
            }
            editorPort = nextEditorPort;
            scheduleSync();
            return editorPort;
        }

        function execute(command, value, options = {}) {
            const editor = currentEditor();
            if (!editor) return false;
            if (command === 'undo' || command === 'redo') {
                return context.historyPort?.execute?.(command) ?? false;
            }
            if (!editor.canExecute?.(command, options) && editor.canExecute) {
                notificationPort.show?.('当前选区无法执行此格式命令。', 'info');
                return false;
            }
            const result = editor.executeFormatting(command, value, options);
            if (result !== false) scheduleSync(options.target || null);
            return result;
        }

        function normalizeUiState(state = {}) {
            return Object.freeze({
                available: state.available !== false,
                fontFamily: String(state.fontFamily || ''),
                fontSize: String(state.fontSize || ''),
                textColor: String(state.textColor || ''),
                highlightColor: String(state.highlightColor || ''),
                lineHeight: String(state.lineHeight || ''),
                activeCommands: new Set(state.activeCommands || []),
                disabledCommands: new Set(state.disabledCommands || []),
                selectionTarget: state.selectionTarget || 'inline',
            });
        }

        function normalizedFontNames(value) {
            return String(value || '')
                .split(',')
                .map((name) => name.trim()
                    .replace(/^["']|["']$/g, '')
                    .toLocaleLowerCase()
                )
                .filter(Boolean);
        }

        function optionByValue(select, value) {
            if (!select || !value) return null;
            const exact = [...select.options].find((option) =>
                option.value === value
            );
            if (exact) return exact;
            const wantedFonts = normalizedFontNames(value);
            return [...select.options].find((option) => {
                const optionFonts = normalizedFontNames(option.value);
                return optionFonts.some((font) => wantedFonts.includes(font));
            }) || null;
        }

        function cssLengthInPoints(value) {
            const numeric = Number.parseFloat(value);
            if (!Number.isFinite(numeric)) return null;
            const unit = String(value || '').trim().match(
                /[a-z%]+$/i
            )?.[0]?.toLowerCase() || '';
            if (unit === 'px') return numeric * 72 / 96;
            if (unit === 'pt' || !unit) return numeric;
            return null;
        }

        function closestNumericOption(select, value) {
            const numeric = cssLengthInPoints(value);
            if (!select || !Number.isFinite(numeric)) return null;
            return [...select.options]
                .map((option) => ({
                    option,
                    distance: Math.abs(
                        (cssLengthInPoints(option.value) ?? Infinity) - numeric
                    ),
                }))
                .filter((item) => Number.isFinite(item.distance))
                .sort((left, right) => left.distance - right.distance)[0]?.option || null;
        }

        function setSelectValue(select, value, numeric = false) {
            if (!select || !value) return;
            const option = optionByValue(select, value)
                || (numeric ? closestNumericOption(select, value) : null);
            if (option) select.value = option.value;
        }

        function setColorValue(input, value) {
            if (!input || !/^#[0-9a-f]{6}$/i.test(value)) return;
            input.value = value;
        }

        function syncHistoryControls() {
            const history = context.historyPort?.status?.() || {};
            document.querySelectorAll(
                '[data-command="undo"], [data-command="redo"]'
            ).forEach((control) => {
                const command = control.dataset.command;
                control.disabled = command === 'undo'
                    ? history.canUndo !== true
                    : history.canRedo !== true;
                control.setAttribute(
                    'aria-disabled',
                    String(control.disabled)
                );
            });
            return history;
        }

        function present(rawState = {}) {
            const state = normalizeUiState(rawState);
            const controls = [
                ...document.querySelectorAll(
                    '[data-command], [data-selection-command]'
                ),
            ];
            controls.forEach((control) => {
                const command = control.dataset.command
                    || control.dataset.selectionCommand;
                if (!command || command === 'undo' || command === 'redo') {
                    return;
                }
                control.disabled = !state.available
                    || state.disabledCommands.has(command);
                if (INLINE_COMMANDS.includes(command)) {
                    const active = state.activeCommands.has(command);
                    control.classList.toggle('active', active);
                    control.setAttribute('aria-pressed', String(active));
                }
            });
            syncHistoryControls();

            const fontSelects = [
                elements['font-family-select'],
                elements['selection-font-family'],
            ];
            const sizeSelects = [
                elements['font-size-select'],
                elements['selection-font-size'],
            ];
            const textColors = [
                elements['text-color-input'],
                elements['selection-text-color'],
            ];
            const otherControls = [
                elements['highlight-color-input'],
                elements['line-height-select'],
            ];

            [...fontSelects, ...sizeSelects, ...textColors, ...otherControls]
                .filter(Boolean)
                .forEach((control) => {
                    control.disabled = !state.available;
                });

            fontSelects.forEach((select) =>
                setSelectValue(select, state.fontFamily)
            );
            sizeSelects.forEach((select) =>
                setSelectValue(select, state.fontSize, true)
            );
            textColors.forEach((input) =>
                setColorValue(input, state.textColor)
            );
            setColorValue(
                elements['highlight-color-input'],
                state.highlightColor
            );
            setSelectValue(
                elements['line-height-select'],
                state.lineHeight,
                true
            );
            return state;
        }

        function sync(target = null) {
            const editor = currentEditor();
            const state = editor?.formattingState?.(target) || {
                available: false,
            };
            return present(state);
        }

        function scheduleSync(target = null) {
            if (disposed) return;
            pendingTarget = target;
            if (syncFrame !== null) return;
            syncFrame = window.requestAnimationFrame(() => {
                syncFrame = null;
                const targetToSync = pendingTarget;
                pendingTarget = null;
                if (targetToSync?.isConnected === false) return;
                sync(targetToSync);
            });
        }

        function bind() {
            assertActive();
            abortController?.abort();
            abortController = new AbortController();
            const options = { signal: abortController.signal };
            const menu = contextMenu();

            menu?.addEventListener('mousedown', (event) => {
                // 按钮不能夺走正文选区；原生 select/input 必须获得焦点，
                // 否则 Chromium 不会打开字体、字号和颜色选择器。
                if (!event.target.closest?.('select,input,option,label')) {
                    event.preventDefault();
                }
            }, options);
            menu?.addEventListener('click', (event) => {
                const action = event.target.closest?.(
                    '[data-text-action]'
                )?.dataset.textAction;
                if (!action) return;
                runTextAction(action);
                hideContextMenu();
            }, options);
            window.addEventListener('pointerdown', (event) => {
                if (!menu?.contains(event.target)) hideContextMenu();
            }, options);
            window.addEventListener('blur', hideContextMenu, options);

            document.querySelectorAll('[data-command]').forEach((control) => {
                control.addEventListener('mousedown', (event) => {
                    event.preventDefault();
                }, options);
                control.addEventListener('click', () => {
                    execute(
                        control.dataset.command,
                        control.dataset.value,
                        { preferSaved: false }
                    );
                }, options);
            });

            elements['selection-format-bar']
                ?.querySelectorAll('[data-selection-command]')
                .forEach((control) => {
                    control.addEventListener('mousedown', (event) => {
                        event.preventDefault();
                    }, options);
                    control.addEventListener('click', () => {
                        execute(
                            control.dataset.selectionCommand,
                            control.dataset.value,
                            { preferSaved: true }
                        );
                    }, options);
                });

            const bindings = [
                ['font-family-select', 'change', 'font-family', false],
                ['font-size-select', 'change', 'font-size', false],
                ['text-color-input', 'change', 'text-color', false],
                ['highlight-color-input', 'change', 'highlight-color', false],
                ['line-height-select', 'change', 'line-height', false],
                ['selection-font-family', 'change', 'font-family', true],
                ['selection-font-size', 'change', 'font-size', true],
                ['selection-text-color', 'change', 'text-color', true],
            ];
            bindings.forEach(([id, eventName, command, preferSaved]) => {
                elements[id]?.addEventListener(eventName, (event) => {
                    execute(command, event.target.value, { preferSaved });
                }, options);
            });
            return api;
        }

        function dispose() {
            if (disposed) return;
            abortController?.abort();
            abortController = null;
            if (syncFrame !== null) {
                window.cancelAnimationFrame(syncFrame);
                syncFrame = null;
            }
            pendingTarget = null;
            editorPort = null;
            disposed = true;
        }

        const api = Object.freeze({
            setEditorPort,
            execute,
            sync,
            scheduleSync,
            present,
            syncHistoryControls,
            openContextMenu,
            contextMenuOpen,
            hideContextMenu,
            bind,
            dispose,
        });

        return api;
    }

    window.ScriptoriumFormatting = Object.freeze({
        INLINE_COMMANDS,
        createFormattingController,
    });
})();