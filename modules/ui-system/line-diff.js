// Adapted from ZCode packages/ui/src/lib/toolDiffPreview.ts (Apache-2.0).
// Native DOM projection, typed LCS budget, total-work budget and bounded input are VCPChat changes.
export const DIFF_LIMITS = Object.freeze({ textChars: 2 * 1024 * 1024, lines: 20000, lcsCells: 60000, totalCells: 2000000 });

export function computeLineDiff(oldText = '', newText = '') {
    function split(text) {
        if (typeof text !== 'string' || text.length > DIFF_LIMITS.textChars) throw new RangeError('文件过大，无法生成 Diff。');
        let newlines = 0;
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n' && ++newlines > DIFF_LIMITS.lines) throw new RangeError('文件行数过多，无法生成 Diff。');
        }
        const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
        if (lines.length > DIFF_LIMITS.lines) throw new RangeError('文件行数过多，无法生成 Diff。');
        return lines;
    }
    const before = split(oldText), after = split(newText), rows = [];
    let addedCount = 0, deletedCount = 0, approximate = false;
    let cellsLeft = DIFF_LIMITS.totalCells, linesLeft = DIFF_LIMITS.lines * 16;
    function emit(type, i, j) {
        rows.push({ type, oldLine: i === null ? null : i + 1, newLine: j === null ? null : j + 1, text: i === null ? after[j] : before[i] });
        if (type === 'add') addedCount++;
        if (type === 'del') deletedCount++;
    }
    function block(a, ae, b, be) {
        approximate = true;
        for (let i = a; i < ae; i++) emit('del', i, null);
        for (let j = b; j < be; j++) emit('add', null, j);
    }
    function anchors(a, ae, b, be) {
        const left = new Map(), right = new Map();
        for (let i = a; i < ae; i++) left.set(before[i], left.has(before[i]) ? -1 : i);
        for (let j = b; j < be; j++) right.set(after[j], right.has(after[j]) ? -1 : j);
        const matches = [];
        for (const [text, i] of left) { const j = right.get(text); if (i >= 0 && j >= 0) matches.push({ i, j }); }
        const previous = new Int32Array(matches.length).fill(-1), tops = [];
        for (let k = 0; k < matches.length; k++) {
            let low = 0, high = tops.length;
            while (low < high) { const mid = (low + high) >> 1; if (matches[tops[mid]].j < matches[k].j) low = mid + 1; else high = mid; }
            if (low) previous[k] = tops[low - 1];
            tops[low] = k;
        }
        const chain = [];
        for (let k = tops.at(-1) ?? -1; k >= 0; k = previous[k]) chain.push(matches[k]);
        return chain.reverse();
    }
    function segment(a, ae, b, be, depth = 0) {
        while (a < ae && b < be && before[a] === after[b]) emit('same', a++, b++);
        let suffix = 0;
        while (a < ae - suffix && b < be - suffix && before[ae - suffix - 1] === after[be - suffix - 1]) suffix++;
        const endA = ae - suffix, endB = be - suffix;
        const n = endA - a, m = endB - b;
        if (!n || !m) {
            for (let i = a; i < endA; i++) emit('del', i, null);
            for (let j = b; j < endB; j++) emit('add', null, j);
        } else if ((n + 1) * (m + 1) <= DIFF_LIMITS.lcsCells && n * m <= cellsLeft) {
            cellsLeft -= n * m;
            const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
            for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
                dp[i][j] = before[a + i - 1] === after[b + j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
            const reverse = [];let i = n, j = m;
            while (i || j) {
                if (i && j && before[a + i - 1] === after[b + j - 1]) { reverse.push(['same',a + --i,b + --j]); }
                else if (j && (!i || dp[i][j - 1] >= dp[i - 1][j])) reverse.push(['add',null,b + --j]);
                else reverse.push(['del',a + --i,null]);
            }
            for (const row of reverse.reverse()) emit(...row);
        } else {
            // ZCode 用唯一行锚点拆大区间；补上总预算与深度边界，避免只限制单块仍反复计算。
            linesLeft -= n + m;
            const chain = depth < 32 && linesLeft >= 0 ? anchors(a, endA, b, endB) : [];
            if (!chain.length) block(a, endA, b, endB);
            else {
                let i = a, j = b;
                for (const anchor of chain) { segment(i,anchor.i,j,anchor.j,depth + 1);emit('same',anchor.i,anchor.j);i=anchor.i+1;j=anchor.j+1; }
                segment(i,endA,j,endB,depth + 1);
            }
        }
        for (let k = 0; k < suffix; k++) emit('same',endA + k,endB + k);
    }
    segment(0,before.length,0,after.length);
    return { rows, addedCount, deletedCount, approximate };
}
