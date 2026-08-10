'use strict';

(() => {
    function createSourceEditorController(context) {
        const {
            state,
            elements,
            core,
            getCurrentHtml,
            getCurrentCss,
        } = context;

        function getValue() {
            return state.sourceEditor?.getValue() ?? elements['source-editor'].value;
        }

        function setValue(value) {
            const normalized = String(value || '');
            if (state.sourceEditor) state.sourceEditor.setValue(normalized);
            else elements['source-editor'].value = normalized;
        }

        function validate() {
            const source = getValue();
            let valid = true;
            let message = '源码有效';
            if (state.sourceMode === 'html') {
                const template = document.createElement('template');
                template.innerHTML = source;
                const blocked = template.content.querySelector('iframe,object,embed');
                if (blocked) {
                    valid = false;
                    message = `禁止使用 <${blocked.tagName.toLowerCase()}>`;
                } else if (template.content.querySelector('script')) {
                    message = '源码有效 · 脚本将在应用时执行依赖本地化与安全审查';
                }
            } else {
                const opens = (source.match(/\{/g) || []).length;
                const closes = (source.match(/\}/g) || []).length;
                if (opens !== closes) {
                    valid = false;
                    message = `CSS 花括号不平衡：${opens} / ${closes}`;
                }
            }
            elements['source-diagnostics'].textContent = message;
            elements['source-diagnostics'].classList.toggle('valid', valid);
            elements['source-diagnostics'].classList.toggle('invalid', !valid);
            return valid;
        }

        function clearColorMarks() {
            state.sourceColorMarks.forEach((mark) => mark.clear());
            state.sourceColorMarks = [];
        }

        function refreshColorMarks() {
            if (!state.sourceEditor) return;
            clearColorMarks();
            const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
            state.sourceEditor.eachLine((lineHandle) => {
                const line = state.sourceEditor.getLineNumber(lineHandle);
                let match;
                while ((match = hexPattern.exec(lineHandle.text))) {
                    const mark = state.sourceEditor.markText(
                        { line, ch: match.index },
                        { line, ch: match.index + match[0].length },
                        { className: 'cm-vdoc-color', css: `--cm-color:${match[0]}` }
                    );
                    state.sourceColorMarks.push(mark);
                }
            });
        }

        function colorAtCursor() {
            if (!state.sourceEditor) return null;
            const cursor = state.sourceEditor.getCursor();
            const line = state.sourceEditor.getLine(cursor.line);
            const pattern = /#[0-9a-fA-F]{3,8}\b/g;
            let match;
            while ((match = pattern.exec(line))) {
                if (cursor.ch >= match.index && cursor.ch <= match.index + match[0].length) {
                    return {
                        value: match[0],
                        from: { line: cursor.line, ch: match.index },
                        to: { line: cursor.line, ch: match.index + match[0].length },
                    };
                }
            }
            return null;
        }

        function syncColorTool() {
            const color = colorAtCursor();
            if (!color || !/^#[0-9a-fA-F]{6}$/.test(color.value)) return;
            elements['source-color-input'].value = color.value;
            elements['source-color-swatch'].style.background = color.value;
        }

        function replaceColor(value) {
            if (!state.sourceEditor) return;
            const color = colorAtCursor();
            if (color) state.sourceEditor.replaceRange(value, color.from, color.to);
            else state.sourceEditor.replaceSelection(value);
            elements['source-color-swatch'].style.background = value;
            state.sourceEditor.focus();
        }

        function format() {
            const source = getValue();
            if (state.sourceMode === 'html') {
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
        }

        function scheduleColorMarks(delay = 180) {
            window.clearTimeout(state.sourceEditorTimer);
            state.sourceEditorTimer = window.setTimeout(refreshColorMarks, delay);
        }

        function initialize() {
            if (!window.CodeMirror || state.sourceEditor) return state.sourceEditor;
            state.sourceEditor = window.CodeMirror.fromTextArea(elements['source-editor'], {
                mode: 'htmlmixed',
                theme: 'material-darker',
                lineNumbers: true,
                lineWrapping: true,
                indentUnit: 4,
                tabSize: 4,
                indentWithTabs: false,
                autoCloseBrackets: true,
                autoCloseTags: true,
                viewportMargin: 20,
            });
            state.sourceEditor.on('change', () => {
                validate();
                scheduleColorMarks();
            });
            state.sourceEditor.on('cursorActivity', syncColorTool);
            return state.sourceEditor;
        }

        function configureMode(mode) {
            state.sourceMode = mode;
            state.sourceEditor?.setOption('mode', mode === 'html' ? 'htmlmixed' : 'css');
        }

        function refresh(options = {}) {
            if (state.mode !== 'html' && state.mode !== 'css' && !options.force) return;
            const value = state.sourceMode === 'html'
                ? getCurrentHtml()
                : getCurrentCss();
            setValue(value);
            window.clearTimeout(state.sourceEditorTimer);
            window.setTimeout(() => {
                state.sourceEditor?.refresh();
                if (options.focus) state.sourceEditor?.focus();
                validate();
                refreshColorMarks();
            }, 0);
        }

        function setLineWrapping(enabled) {
            state.sourceEditor?.setOption('lineWrapping', Boolean(enabled));
            state.sourceEditor?.refresh();
        }

        function dispose() {
            window.clearTimeout(state.sourceEditorTimer);
            state.sourceEditorTimer = null;
            clearColorMarks();
        }

        return Object.freeze({
            colorAtCursor,
            configureMode,
            dispose,
            format,
            getValue,
            initialize,
            refresh,
            refreshColorMarks,
            replaceColor,
            setLineWrapping,
            setValue,
            syncColorTool,
            validate,
        });
    }

    window.ScriptoriumSourceEditor = Object.freeze({
        createSourceEditorController,
    });
})();