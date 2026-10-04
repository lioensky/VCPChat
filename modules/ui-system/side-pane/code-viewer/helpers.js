/**
 * modules/ui-system/side-pane/codeViewerSideProvider.js
 * VCPChat Universal Sub-screen - Code & Diff Viewer Provider
 *
 * Implements the universal sub-screen Code & Diff Viewer supporting:
 * 1. Single file / snippet viewing with line numbers and syntax highlighting
 * 2. Side-by-side or unified line diff comparison (additions, deletions, stats)
 * 3. Deep integration with chat: Copy code, wrap lines, insert into chat composer,
 *    and open in external editor / IDE.
 */

'use strict';

const EXTENSION_MAP = Object.freeze({
    js: { lang: 'javascript', tag: 'JS' },
    mjs: { lang: 'javascript', tag: 'JS' },
    cjs: { lang: 'javascript', tag: 'JS' },
    ts: { lang: 'typescript', tag: 'TS' },
    tsx: { lang: 'typescript', tag: 'TSX' },
    jsx: { lang: 'javascript', tag: 'JSX' },
    py: { lang: 'python', tag: 'PY' },
    rs: { lang: 'rust', tag: 'RUST' },
    go: { lang: 'go', tag: 'GO' },
    java: { lang: 'java', tag: 'JAVA' },
    c: { lang: 'c', tag: 'C' },
    cpp: { lang: 'cpp', tag: 'C++' },
    h: { lang: 'c', tag: 'H' },
    hpp: { lang: 'cpp', tag: 'H++' },
    html: { lang: 'html', tag: 'HTML' },
    htm: { lang: 'html', tag: 'HTML' },
    css: { lang: 'css', tag: 'CSS' },
    scss: { lang: 'scss', tag: 'SCSS' },
    json: { lang: 'json', tag: 'JSON' },
    xml: { lang: 'xml', tag: 'XML' },
    md: { lang: 'markdown', tag: 'MD' },
    sh: { lang: 'bash', tag: 'SH' },
    bash: { lang: 'bash', tag: 'BASH' },
    zsh: { lang: 'bash', tag: 'ZSH' },
    ps1: { lang: 'powershell', tag: 'PS1' },
    sql: { lang: 'sql', tag: 'SQL' },
    yaml: { lang: 'yaml', tag: 'YAML' },
    yml: { lang: 'yaml', tag: 'YAML' },
    toml: { lang: 'toml', tag: 'TOML' },
    ini: { lang: 'ini', tag: 'INI' },
    diff: { lang: 'diff', tag: 'DIFF' },
    patch: { lang: 'diff', tag: 'PATCH' }
});

export function detectLanguage(filePathOrName, fallback = 'plaintext') {
    if (!filePathOrName || typeof filePathOrName !== 'string') {
        return { lang: fallback, tag: fallback.toUpperCase() };
    }
    const dotIndex = filePathOrName.lastIndexOf('.');
    if (dotIndex === -1) {
        return { lang: fallback, tag: fallback.toUpperCase() };
    }
    const ext = filePathOrName.slice(dotIndex + 1).toLowerCase();
    return EXTENSION_MAP[ext] || { lang: ext, tag: ext.toUpperCase() };
}
