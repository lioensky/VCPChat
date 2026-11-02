// VCP : YAML 属性段（front matter）。
// .md 开头 --- 到 ---（或 ...）之间那段（Jekyll、Hugo、Obsidian 都这么写）。按 Markdown 的规矩，收尾那行 --- 会把上一行变成
// 二级标题，开头那行变成一道横线；混合编译器（vdoc-hybrid-compiler.js 里几行调这里）把整段当一块受保护的内容，画成一张属性小表。
// 改值、加一项、删一项写回 YAML（uttu-scriptorium-properties.js）。只认平的一层：名字: 值、[a, b]、下一行起 - 开头的列表；
// 看不懂的（嵌套、多行字符串）整段原样显示，不能在表里改。写回时保留原来的写法（行内列表还是分行列表、原来的引号）。
(function (global) {
    'use strict';

    const OPENING = /^---[ \t]*\r?\n/;
    const WHOLE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
    const KEY_LINE = /^([^\s#:\-?][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
    const LIST_LINE = /^(\s+)-[ \t]+(.*?)[ \t]*$/;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    }

    // The front matter at the very start of the source, or null. yamlStart / yamlEnd: the YAML text between the lines.
    function scan(source) {
        const text = String(source || '');
        const opening = OPENING.exec(text);
        if (!opening) return null;
        // An empty one is "---" right after the opening line.
        if (/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.test(text.slice(opening[0].length))) {
            const end = opening[0].length + /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text.slice(opening[0].length))[0].length;
            return { type: 'frontmatter', start: 0, end, source: text.slice(0, end), yaml: '', yamlStart: opening[0].length, yamlEnd: opening[0].length, closed: true };
        }
        const match = WHOLE.exec(text);
        if (!match || match[1].split('\n').length > 400) return null;
        const yamlStart = opening[0].length;
        return {
            type: 'frontmatter', start: 0, end: match[0].length, source: match[0], yaml: match[1],
            yamlStart, yamlEnd: yamlStart + match[1].length, closed: true,
        };
    }

    function unquote(raw) {
        const value = String(raw ?? '').trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            return value.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c) => ({ n: '\n', t: '\t' }[c] || c));
        }
        if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
        return value;
    }
    const quoteOf = (raw) => { const value = String(raw ?? '').trim(); return value[0] === '"' || value[0] === "'" ? value[0] : ''; };

    function splitInline(inner) {
        const items = [];
        let current = '';
        let quote = '';
        for (const character of inner) {
            if (quote) { current += character; if (character === quote) quote = ''; continue; }
            if (character === '"' || character === "'") { quote = character; current += character; continue; }
            if (character === ',') { items.push(current); current = ''; continue; }
            current += character;
        }
        if (current.trim() || items.length) items.push(current);
        return items.map((item) => item.trim()).filter((item) => item !== '');
    }

    // The flat entries of the YAML; simple is false when there is something they cannot show (nested, multi-line).
    function entries(yaml) {
        const lines = String(yaml || '').split(/\r?\n/);
        const list = [];
        let simple = true;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            if (!line.trim() || /^\s*#/.test(line)) continue;
            const match = KEY_LINE.exec(line);
            if (!match) { simple = false; continue; }
            const raw = match[2] ?? '';
            const entry = { key: match[1], line: index, lines: 1, style: 'scalar', quote: quoteOf(raw), value: unquote(raw), indent: '  ' };
            if (!raw) {
                const items = [];
                while (index + 1 < lines.length && LIST_LINE.test(lines[index + 1])) {
                    index += 1;
                    const item = LIST_LINE.exec(lines[index]);
                    entry.indent = item[1];
                    items.push(unquote(item[2]));
                }
                if (items.length) {
                    Object.assign(entry, { style: 'block', value: items, lines: 1 + items.length });
                } else if (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
                    simple = false; // a nested map
                }
            } else if (/^\[.*\]$/.test(raw)) {
                Object.assign(entry, { style: 'inline', value: splitInline(raw.slice(1, -1)).map(unquote) });
            } else if (/^[|>]/.test(raw) || /^\{/.test(raw)) {
                simple = false;
            }
            list.push(entry);
        }
        return { simple, list };
    }

    function valueHtml(value) {
        if (Array.isArray(value)) return value.map((item) => `<span class="vdoc-frontmatter-item">${escapeHtml(item)}</span>`).join(' ');
        return escapeHtml(value);
    }

    // What the compiler puts in place of the front matter.
    function markup(region) {
        const parsed = entries(region?.yaml);
        if (!parsed.list.length && !String(region?.yaml || '').trim()) return '';
        if (!parsed.simple || !parsed.list.length) {
            return `<pre class="vdoc-frontmatter-raw" data-vdoc-frontmatter="raw">${escapeHtml(region.yaml)}</pre>`;
        }
        const rows = parsed.list.map((entry, index) => `<tr data-vdoc-frontmatter-index="${index}"><th>${escapeHtml(entry.key)}</th>`
            + `<td>${valueHtml(entry.value)}</td></tr>`).join('');
        return `<table class="vdoc-frontmatter" data-vdoc-frontmatter="table"><tbody>${rows}</tbody></table>`;
    }

    // ---------- 写回 ----------
    const NEEDS_QUOTES = /^[\s!&*%@`#|>'"{}[\],?-]|^-|: |\s#|\s$|^(?:true|false|null|yes|no|on|off|~)$/i;
    function formatScalar(value, quote = '') {
        const text = String(value ?? '');
        if (!text) return '';
        if (quote === "'") return `'${text.replace(/'/g, "''")}'`;
        if (quote === '"' || NEEDS_QUOTES.test(text) || /\n/.test(text)) {
            return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
        }
        return text;
    }
    const formatItem = (item) => (/[,[\]]/.test(item) ? formatScalar(item, '"') : formatScalar(item));

    function linesFor(entry, value) {
        // 原来就是没加引号的真假值，改成另一个真假值时还是真假值，不写成带引号的文字。
        if (entry.style === 'scalar' && !entry.quote && /^(true|false)$/i.test(String(value)) && /^(true|false)$/i.test(String(entry.value))) return [`${entry.key}: ${value}`];
        if (entry.style === 'scalar') return [`${entry.key}:${String(value ?? '') ? ` ${formatScalar(value, entry.quote)}` : ''}`];
        const items = Array.isArray(value) ? value : splitInline(String(value ?? '')).map(unquote);
        if (entry.style === 'inline') return [`${entry.key}: [${items.map(formatItem).join(', ')}]`];
        if (!items.length) return [`${entry.key}:`];
        return [`${entry.key}:`, ...items.map((item) => `${entry.indent}- ${formatScalar(item)}`)];
    }

    function rewrite(source, change) {
        const text = String(source || '');
        const region = scan(text);
        if (!region) return text;
        const lines = region.yaml ? region.yaml.split(/\r?\n/) : [];
        change(lines, entries(region.yaml));
        const yaml = lines.join('\n');
        const body = text.slice(region.yamlEnd);
        return `${text.slice(0, region.yamlStart)}${yaml}${yaml && !/^\r?\n/.test(body) ? '\n' : ''}${body}`;
    }

    // Set entry number `index` (as listed by entries) to `value`: text for a single value, a list (or "a, b") for a list.
    function setValue(source, index, value) {
        return rewrite(source, (lines, parsed) => {
            const entry = parsed.list[index];
            if (entry) lines.splice(entry.line, entry.lines, ...linesFor(entry, value));
        });
    }
    function removeEntry(source, index) {
        return rewrite(source, (lines, parsed) => {
            const entry = parsed.list[index];
            if (entry) lines.splice(entry.line, entry.lines);
        });
    }
    function keyName(key) {
        const name = String(key || '').trim().replace(/:\s*$/, '');
        if (!name || !KEY_LINE.test(`${name}: x`)) throw new Error('属性名不能空着，也不能以 - # : 开头。');
        return name;
    }
    function addEntry(source, key, value) {
        const name = keyName(key);
        return rewrite(source, (lines) => {
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
            lines.push(...linesFor({ key: name, style: 'scalar', quote: '' }, value));
        });
    }
    // 只换这一项的名字，值和写法不动。
    function setKey(source, index, key) {
        const name = keyName(key);
        return rewrite(source, (lines, parsed) => {
            const entry = parsed.list[index];
            if (entry) lines[entry.line] = `${name}${lines[entry.line].slice(lines[entry.line].indexOf(':'))}`;
        });
    }

    global.UTTUFrontmatter = Object.freeze({ scan, entries, markup, setValue, setKey, removeEntry, addEntry });
    if (typeof module !== 'undefined' && module.exports) module.exports = global.UTTUFrontmatter;
})(typeof window !== 'undefined' ? window : globalThis);
