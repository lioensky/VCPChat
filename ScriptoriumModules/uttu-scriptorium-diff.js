// 两边都改了时“看两边差在哪”。
// .md 顶上出“磁盘上的这份文件被别处改了，你这边也有没存的改动”时，多一个“看两边差在哪”：按行比磁盘上那一版和这边这一版，
// 只列不一样的几段（前后各带两行），“磁盘”行淡红底、“我的”行淡绿底，下面照样是“用磁盘上的 / 保留我的”。
// 比法：先去掉两头相同的行，中间按最长公共子序列；中间太大（超过 4000 × 4000）就不细比，整段列出来。
(() => {
    'use strict';
    const UI = window.UTTUScriptoriumUI;
    if (!UI?.make) return;
    const { make, button, escapeHtml } = UI;

    // 回一串 { type: 'same' | 'disk' | 'mine', text }。
    function diffLines(diskText, mineText) {
        const a = String(diskText).split('\n');
        const b = String(mineText).split('\n');
        let start = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
        let endA = a.length;
        let endB = b.length;
        while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
        const out = a.slice(0, start).map((text) => ({ type: 'same', text }));
        const midA = a.slice(start, endA);
        const midB = b.slice(start, endB);
        if (midA.length * midB.length > 16e6) {
            midA.forEach((text) => out.push({ type: 'disk', text }));
            midB.forEach((text) => out.push({ type: 'mine', text }));
        } else {
            const rows = midA.length + 1;
            const cols = midB.length + 1;
            const table = new Uint32Array(rows * cols);
            for (let i = midA.length - 1; i >= 0; i -= 1) {
                for (let j = midB.length - 1; j >= 0; j -= 1) {
                    table[i * cols + j] = midA[i] === midB[j] ? table[(i + 1) * cols + j + 1] + 1
                        : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
                }
            }
            let i = 0;
            let j = 0;
            while (i < midA.length && j < midB.length) {
                if (midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i += 1; j += 1; }
                else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { out.push({ type: 'disk', text: midA[i] }); i += 1; }
                else { out.push({ type: 'mine', text: midB[j] }); j += 1; }
            }
            while (i < midA.length) out.push({ type: 'disk', text: midA[i++] });
            while (j < midB.length) out.push({ type: 'mine', text: midB[j++] });
        }
        a.slice(endA).forEach((text) => out.push({ type: 'same', text }));
        return out;
    }

    // 只留不一样的几段，前后各 CONTEXT 行；中间省掉的写“相同的 N 行”。
    const CONTEXT = 2;
    function hunks(lines) {
        const keep = new Array(lines.length).fill(false);
        lines.forEach((line, index) => {
            if (line.type === 'same') return;
            for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k += 1) keep[k] = true;
        });
        const out = [];
        let skipped = 0;
        lines.forEach((line, index) => {
            if (keep[index]) {
                if (skipped) out.push({ type: 'gap', text: `相同的 ${skipped} 行` });
                skipped = 0;
                out.push(line);
            } else {
                skipped += 1;
            }
        });
        if (skipped && out.length) out.push({ type: 'gap', text: `相同的 ${skipped} 行` });
        return out;
    }

    let box = null;
    function close() {
        box?.remove();
        box = null;
    }
    // actions：[['用磁盘上的', 'ghost', fn], ...]，点了先关掉面板再做。
    function show(diskText, mineText, actions = []) {
        close();
        const lines = hunks(diffLines(diskText, mineText));
        box = make('div', 'uttu-diffbox');
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', '两边差在哪');
        const head = make('div', 'uttu-diffbox-head', '<b>两边差在哪</b><span><i class="disk"></i>磁盘上的</span><span><i class="mine"></i>我这边的</span>');
        head.append(button('uttu-tb', '关掉', UI.icon('i-x'), close));
        const body = make('div', 'uttu-diffbox-body');
        body.innerHTML = lines.length ? lines.map((line) => `<div class="${line.type}"><b>${{ disk: '磁盘', mine: '我的', same: '', gap: '' }[line.type]}</b><code>${escapeHtml(line.text) || ' '}</code></div>`).join('')
            : '<p class="uttu-left-note">两边一模一样。</p>';
        const foot = make('div', 'uttu-diffbox-foot');
        for (const [label, cls, act] of actions) foot.append(button(`uttu-btn ${cls}`, label, escapeHtml(label), () => { close(); act(); }));
        box.append(head, body, foot);
        document.body.append(box);
    }
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && box) { event.preventDefault(); event.stopPropagation(); close(); }
    }, true);

    window.UTTUScriptoriumDiff = Object.freeze({ diffLines, hunks, show, close });
})();
