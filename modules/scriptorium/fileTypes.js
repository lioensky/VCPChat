// 文坊可原位打开的文件类型登记表，页面和主进程共用。新增一种类型只需修改这里。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ScriptoriumFileTypes = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    // 扩展名 → [语言名, CodeMirror 模式脚本, 模式]。没有脚本的按纯文本显示。语言由文件决定。
    const LANGUAGES = Object.freeze({
        '.txt': ['纯文本'],
        '.log': ['纯文本'],
        '.json': ['JSON', 'javascript', { name: 'javascript', json: true }],
        '.jsonc': ['JSON', 'javascript', { name: 'javascript', json: true }],
        '.js': ['JavaScript', 'javascript', 'javascript'],
        '.mjs': ['JavaScript', 'javascript', 'javascript'],
        '.cjs': ['JavaScript', 'javascript', 'javascript'],
        '.jsx': ['JavaScript', 'javascript', 'javascript'],
        '.ts': ['TypeScript', 'javascript', { name: 'javascript', typescript: true }],
        '.tsx': ['TypeScript', 'javascript', { name: 'javascript', typescript: true }],
        '.css': ['CSS', 'css', 'css'],
        '.scss': ['SCSS', 'css', 'text/x-scss'],
        '.less': ['Less', 'css', 'text/x-less'],
        '.xml': ['XML', 'xml', 'xml'],
        '.py': ['Python', 'python', 'python'],
        '.sh': ['Shell', 'shell', 'shell'],
        '.bash': ['Shell', 'shell', 'shell'],
        '.ps1': ['PowerShell', 'powershell', 'powershell'],
        '.bat': ['批处理'],
        '.cmd': ['批处理'],
        '.yaml': ['YAML', 'yaml', 'yaml'],
        '.yml': ['YAML', 'yaml', 'yaml'],
        '.toml': ['TOML', 'toml', 'toml'],
        '.ini': ['配置', 'properties', 'properties'],
        '.cfg': ['配置', 'properties', 'properties'],
        '.conf': ['配置', 'properties', 'properties'],
        '.sql': ['SQL', 'sql', 'text/x-sql'],
        '.java': ['Java', 'clike', 'text/x-java'],
        '.c': ['C', 'clike', 'text/x-csrc'],
        '.h': ['C', 'clike', 'text/x-csrc'],
        '.cpp': ['C++', 'clike', 'text/x-c++src'],
        '.hpp': ['C++', 'clike', 'text/x-c++src'],
        '.cs': ['C#', 'clike', 'text/x-csharp'],
        '.go': ['Go', 'go', 'go'],
        '.rs': ['Rust', 'rust', 'rust'],
        '.rb': ['Ruby', 'ruby', 'ruby'],
        '.lua': ['Lua', 'lua', 'lua'],
        '.jsonl': ['JSON', 'javascript', { name: 'javascript', json: true }],
        '.ndjson': ['JSON', 'javascript', { name: 'javascript', json: true }],
        '.sass': ['Sass', 'sass', 'sass'],
        '.vue': ['Vue', 'xml', 'xml'],
        '.svelte': ['Svelte', 'xml', 'xml'],
        '.xaml': ['XML', 'xml', 'xml'],
        '.csproj': ['XML', 'xml', 'xml'],
        '.kt': ['Kotlin', 'clike', 'text/x-kotlin'],
        '.kts': ['Kotlin', 'clike', 'text/x-kotlin'],
        '.scala': ['Scala', 'clike', 'text/x-scala'],
        '.cc': ['C++', 'clike', 'text/x-c++src'],
        '.cxx': ['C++', 'clike', 'text/x-c++src'],
        '.hh': ['C++', 'clike', 'text/x-c++src'],
        '.m': ['Objective-C', 'clike', 'text/x-objectivec'],
        '.mm': ['Objective-C', 'clike', 'text/x-objectivec'],
        '.dart': ['Dart', ['clike', 'dart'], 'dart'],
        '.swift': ['Swift', 'swift', 'swift'],
        '.php': ['PHP', ['htmlmixed', 'clike', 'php'], 'php'],
        '.pl': ['Perl', 'perl', 'perl'],
        '.pm': ['Perl', 'perl', 'perl'],
        '.r': ['R', 'r', 'r'],
        '.jl': ['Julia', 'julia', 'julia'],
        '.hs': ['Haskell', 'haskell', 'haskell'],
        '.erl': ['Erlang', 'erlang', 'erlang'],
        '.clj': ['Clojure', 'clojure', 'clojure'],
        '.groovy': ['Groovy', 'groovy', 'groovy'],
        '.gradle': ['Groovy', 'groovy', 'groovy'],
        '.vb': ['VB', 'vb', 'vb'],
        '.psm1': ['PowerShell', 'powershell', 'powershell'],
        '.zsh': ['Shell', 'shell', 'shell'],
        '.fish': ['Shell', 'shell', 'shell'],
        '.tex': ['LaTeX', 'stex', 'stex'],
        '.rst': ['reStructuredText', 'rst', 'rst'],
        '.diff': ['Diff', 'diff', 'diff'],
        '.patch': ['Diff', 'diff', 'diff'],
        '.proto': ['Protobuf', 'protobuf', 'protobuf'],
        '.properties': ['配置', 'properties', 'properties'],
        '.env': ['配置', 'properties', 'properties'],
        '.bib': ['纯文本'],
        '.adoc': ['纯文本'],
        '.org': ['纯文本'],
        '.lock': ['纯文本'],
    });

    // 没有扩展名或以点开头的常见文件。
    const NAMED = Object.freeze({
        dockerfile: ['Dockerfile'], makefile: ['Makefile'], license: ['纯文本'], licence: ['纯文本'], readme: ['纯文本'], changelog: ['纯文本'], version: ['纯文本'],
        '.gitignore': ['配置', 'properties', 'properties'], '.gitattributes': ['配置', 'properties', 'properties'], '.dockerignore': ['配置', 'properties', 'properties'],
        '.editorconfig': ['配置', 'properties', 'properties'], '.npmrc': ['配置', 'properties', 'properties'], '.env': ['配置', 'properties', 'properties'],
        '.prettierrc': ['JSON', 'javascript', { name: 'javascript', json: true }], '.eslintrc': ['JSON', 'javascript', { name: 'javascript', json: true }],
    });

    // overlay：在文稿区域上方显示的文件视图（ScriptoriumFileViews.register）。name 是显示给用户和 Agent 的类型名。
    const TYPES = Object.freeze([
        Object.freeze({ kind: 'project', name: '文稿', exts: ['.vdocx', '.vpptx'], overlay: false }),
        Object.freeze({ kind: 'markdown', name: 'Markdown', exts: ['.md', '.markdown'], overlay: false }),
        Object.freeze({ kind: 'web-page', name: '网页', exts: ['.html', '.htm'], overlay: true }),
        Object.freeze({ kind: 'pdf', name: 'PDF', exts: ['.pdf'], overlay: true }),
        Object.freeze({ kind: 'table', name: '表格', exts: ['.csv', '.tsv', '.xlsx', '.xlsm'], overlay: true }),
        Object.freeze({ kind: 'board', name: '白板', exts: ['.excalidraw'], overlay: true }),
        Object.freeze({ kind: 'image', name: '图片', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'], overlay: true }),
        Object.freeze({ kind: 'text', name: '文本', exts: Object.keys(LANGUAGES), overlay: true }),
    ]);
    const TEXT = TYPES.find((type) => type.kind === 'text');

    const baseName = (file) => String(file || '').split(/[\\/]/).pop();
    const extensionOf = (file) => {
        const name = baseName(file);
        const dot = name.lastIndexOf('.');
        return dot > 0 ? name.slice(dot).toLowerCase() : '';
    };
    const namedOf = (file) => {
        const name = baseName(file).toLowerCase();
        return NAMED[name] || (/^\.env(\..+)?$/.test(name) ? NAMED['.env'] : null);
    };
    // 扩展名未登记但内容为文本的文件：主进程检查后记录在这里（asText），本次运行中按文本打开。
    const textFiles = new Set();
    const textKey = (file) => String(file || '').replace(/\\/g, '/').toLowerCase();
    const markText = (file) => { textFiles.add(textKey(file)); };
    const typeOf = (file) => {
        const extension = extensionOf(file);
        return TYPES.find((type) => type.exts.includes(extension))
            || (namedOf(file) || textFiles.has(textKey(file)) ? TEXT : null);
    };
    const kindOf = (file) => typeOf(file)?.kind || null;
    const nameOfKind = (kind) => TYPES.find((type) => type.kind === kind)?.name || '文件';
    const opensInPlace = (file) => Boolean(typeOf(file));
    const isOverlay = (file) => Boolean(typeOf(file)?.overlay);
    const overlayExtensions = () => TYPES.filter((type) => type.overlay).flatMap((type) => type.exts);
    const languageOf = (file) => {
        const [name = '纯文本', script = null, mode = null] = namedOf(file) || LANGUAGES[extensionOf(file)] || [];
        return { name, script, mode };
    };

    return Object.freeze({ TYPES, typeOf, kindOf, nameOfKind, opensInPlace, isOverlay, overlayExtensions, languageOf, extensionOf, markText });
});
