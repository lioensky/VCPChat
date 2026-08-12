'use strict';

(() => {
    function createSourceEditorController(context = {}) {
        const core = context.core;
        const hybridCompiler = context.hybridCompiler;
        const notificationPort = context.notificationPort || {};
        let elements = context.elements || {};
        let adapter = null;
        let editor = null;
        let sourceMode = 'html';
        let colorMarks = [];
        let colorTimer = null;
        let disposed = false;

        function setElements(nextElements) {
            elements = nextElements || {};
            return elements;
        }

        function setAdapter(nextAdapter) {
            if (!nextAdapter
                || typeof nextAdapter.currentSource !== 'function'
                || typeof nextAdapter.currentCss !== 'function') {
                throw new TypeError('Source editor requires a document adapter.');
            }
            adapter = nextAdapter;
            configureMode(sourceMode);
            return adapter;
        }

        function currentAdapter() {
            const resolved = adapter || context.getAdapter?.();
            if (!resolved) throw new Error('No document adapter is active.');
            return resolved;
        }

        function getValue() {
            return editor?.getValue()
                ?? elements['source-editor']?.value
                ?? '';
        }

        function setValue(value) {
            const normalized = String(value || '');
            if (editor) editor.setValue(normalized);
            else if (elements['source-editor']) {
                elements['source-editor'].value = normalized;
            }
        }

        function clearColorMarks() {
            colorMarks.forEach((mark) => mark.clear?.());
            colorMarks = [];
        }

        function refreshColorMarks() {
            if (!editor) return;
            clearColorMarks();
            const pattern = /#[0-9a-fA-F]{3,8}\b/g;
            editor.eachLine((lineHandle) => {
                const line = editor.getLineNumber(lineHandle);
                let match;
                while ((match = pattern.exec(lineHandle.text))) {
                    colorMarks.push(editor.markText(
                        { line, ch: match.index },
                        { line, ch: match.index + match[0].length },
                        {
                            className: 'cm-vdoc-color',
                            css: `--cm-color:${match[0]}`,
                        }
                    ));
                }
            });
        }

        function scheduleColorMarks() {
            window.clearTimeout(colorTimer);
            colorTimer = window.setTimeout(refreshColorMarks, 180);
        }

        function validate() {
            const source = getValue();
            const activeAdapter = currentAdapter();
            let valid = true;
            let message = '源码有效';
            if (sourceMode === 'html') {
                if (activeAdapter.kind === 'flow') {
                    const result = hybridCompiler.validate(source);
                    const refuses = result.diagnostics.filter(
                        (item) => item.level === 'refuse'
                    );
                    const warnings = result.diagnostics.filter(
                        (item) => item.level === 'warn'
                    );
                    valid = refuses.length === 0;
                    message = valid
                        ? `混合源码有效 · ${result.islands.length} 个岛${
                            warnings.length ? ` · ${warnings.length} 条提示` : ''
                        }`
                        : `${refuses[0].message}（第 ${refuses[0].line} 行）`;
                } else {
                    const template = document.createElement('template');
                    template.innerHTML = source;
                    const blocked = template.content.querySelector(
                        'iframe,object,embed'
                    );
                    if (blocked) {
                        valid = false;
                        message = `禁止使用 <${
                            blocked.tagName.toLowerCase()
                        }>`;
                    } else if (template.content.querySelector('script')) {
                        message = '源码有效 · 脚本将在应用时接受安全审查';
                    }
                }
            } else {
                const opens = (source.match(/\{/g) || []).length;
                const closes = (source.match(/\}/g) || []).length;
                valid = opens === closes;
                if (!valid) {
                    message = `CSS 花括号不平衡：${opens} / ${closes}`;
                }
            }
            const diagnostics = elements['source-diagnostics'];
            if (diagnostics) {
                diagnostics.textContent = message;
                diagnostics.classList.toggle('valid', valid);
                diagnostics.classList.toggle('invalid', !valid);
            }
            return valid;
        }

        function configureMode(mode) {
            sourceMode = mode === 'css' ? 'css' : 'html';
            const activeAdapter = adapter || context.getAdapter?.();
            editor?.setOption(
                'mode',
                sourceMode === 'css'
                    ? 'css'
                    : activeAdapter?.kind === 'deck'
                        ? 'htmlmixed'
                        : 'markdown'
            );
            return sourceMode;
        }

        function open(mode = 'html') {
            configureMode(mode);
            const activeAdapter = currentAdapter();
            if (elements['source-title']) {
                elements['source-title'].textContent = sourceMode === 'html'
                    ? activeAdapter.kind === 'deck'
                        ? '当前页完整源码'
                        : 'Markdown-first 混合源码'
                    : activeAdapter.kind === 'deck'
                        ? '演示全局 CSS'
                        : '文档全局 CSS';
            }
            setValue(
                sourceMode === 'html'
                    ? activeAdapter.currentSource()
                    : activeAdapter.currentCss()
            );
            window.setTimeout(() => {
                editor?.refresh();
                editor?.focus();
                validate();
                refreshColorMarks();
            }, 0);
            return true;
        }

        function apply(options = {}) {
            if (!validate()) {
                notificationPort.show?.(
                    '源码检查未通过，请修正后再应用。',
                    'error'
                );
                return false;
            }
            const activeAdapter = currentAdapter();
            const changed = sourceMode === 'html'
                ? activeAdapter.replaceCurrentSource(getValue(), {
                    reason: 'human-source-apply',
                })
                : activeAdapter.replaceCurrentCss(getValue(), {
                    reason: 'human-css-apply',
                });
            if (!changed) return true;
            context.historyPort?.capture?.({
                reason: 'source-applied',
            });
            context.renderPort?.invalidate?.('source-applied');
            context.renderPort?.renderEdit?.({ force: true });
            if (options.showSuccess !== false) {
                notificationPort.show?.(
                    '源码已应用到渲染页面',
                    'success'
                );
            }
            return true;
        }

        function format() {
            const source = getValue();
            if (sourceMode === 'html') {
                if (currentAdapter().kind === 'flow') {
                    validate();
                    return false;
                }
                setValue(core.formatHtml(source));
            } else {
                setValue(core.sanitizeCss(source)
                    .replace(/\s*\{\s*/g, ' {\n    ')
                    .replace(/;\s*/g, ';\n    ')
                    .replace(/\s*\}\s*/g, '\n}\n')
                    .replace(/[ \t]+\n/g, '\n'));
            }
            validate();
            refreshColorMarks();
            return true;
        }

        function colorAtCursor() {
            if (!editor) return null;
            const cursor = editor.getCursor();
            const line = editor.getLine(cursor.line);
            const pattern = /#[0-9a-fA-F]{3,8}\b/g;
            let match;
            while ((match = pattern.exec(line))) {
                if (cursor.ch >= match.index
                    && cursor.ch <= match.index + match[0].length) {
                    return {
                        value: match[0],
                        from: { line: cursor.line, ch: match.index },
                        to: {
                            line: cursor.line,
                            ch: match.index + match[0].length,
                        },
                    };
                }
            }
            return null;
        }

        function replaceColor(value) {
            const color = colorAtCursor();
            if (!editor) return false;
            if (color) editor.replaceRange(value, color.from, color.to);
            else editor.replaceSelection(value);
            editor.focus();
            return true;
        }

        function initialize() {
            if (!window.CodeMirror || editor) return editor;
            editor = window.CodeMirror.fromTextArea(
                elements['source-editor'],
                {
                    mode: 'markdown',
                    theme: 'material-darker',
                    lineNumbers: true,
                    lineWrapping: true,
                    indentUnit: 4,
                    tabSize: 4,
                    indentWithTabs: false,
                    autoCloseBrackets: true,
                    autoCloseTags: true,
                    viewportMargin: 20,
                }
            );
            editor.on('change', () => {
                validate();
                scheduleColorMarks();
            });
            return editor;
        }

        function refresh(options = {}) {
            if (!adapter && !context.getAdapter?.()) return false;
            if (!isOpen() && options.force !== true) return false;
            return open(sourceMode);
        }

        function isOpen() {
            return Boolean(
                elements['source-host']
                && elements['source-host'].hidden === false
            );
        }

        function dispose() {
            if (disposed) return;
            window.clearTimeout(colorTimer);
            clearColorMarks();
            adapter = null;
            editor = null;
            disposed = true;
        }

        return Object.freeze({
            setElements,
            setAdapter,
            initialize,
            editor: () => editor,
            getValue,
            setValue,
            configureMode,
            isOpen,
            open,
            apply,
            validate,
            format,
            refresh,
            refreshColorMarks,
            replaceColor,
            dispose,
        });
    }

    window.ScriptoriumSourceEditor = Object.freeze({
        createSourceEditorController,
    });
})();