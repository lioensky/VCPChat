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



export function createCodeViewerDiffView({
    store,
    body,
    computeLineDiff,
    doc,
    newCode,
    oldCode
}) {
    function renderDiffView() {
        body.innerHTML = '';
        const diffShell = doc.createElement('div');
        diffShell.className = 'side-diff-shell';
        if (store.isWrapped) diffShell.classList.add('is-wrapped');

        let diffResult;
        try { diffResult = computeLineDiff(oldCode, newCode ?? store.currentCode); }
        catch (error) { body.textContent = error.message; return; }
        const statsBar = doc.createElement('div');
        statsBar.className = 'side-diff-stats-bar';
        statsBar.innerHTML = `
            <span class="side-diff-badge add">+${diffResult.addedCount}</span>
            <span class="side-diff-badge del">-${diffResult.deletedCount}</span>
            <span class="side-diff-meta">总计 ${diffResult.rows.length} 行对比${diffResult.approximate ? '（大段内容按区块比较，增删数为估算）' : ''}</span>
        `;
        diffShell.appendChild(statsBar);

        const table = doc.createElement('div');
        table.className = 'side-diff-table';

        const appendRow = row => {
            const rowDiv = doc.createElement('div');
            rowDiv.className = `side-diff-row is-${row.type}`;

            const oldNum = doc.createElement('span');
            oldNum.className = 'side-diff-cell side-diff-num old';
            oldNum.textContent = row.oldLine !== null ? String(row.oldLine) : '';

            const newNum = doc.createElement('span');
            newNum.className = 'side-diff-cell side-diff-num new';
            newNum.textContent = row.newLine !== null ? String(row.newLine) : '';

            const sign = doc.createElement('span');
            sign.className = 'side-diff-cell side-diff-sign';
            sign.textContent = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';

            const text = doc.createElement('span');
            text.className = 'side-diff-cell side-diff-text';
            text.textContent = row.text;

            rowDiv.append(oldNum, newNum, sign, text);
            table.appendChild(rowDiv);
        };
        let displayed = 0;
        const more = doc.createElement('button');
        more.type = 'button';
        more.className = 'side-code-action-btn';
        function appendPage() {
            const end = Math.min(displayed + 500, diffResult.rows.length);
            while (displayed < end) appendRow(diffResult.rows[displayed++]);
            more.textContent = '显示更多行（剩余 ' + (diffResult.rows.length - displayed) + ' 行）';
            more.hidden = displayed >= diffResult.rows.length;
        }
        // 按钮每次渲染都重建，监听跟着旧按钮一起丢弃，不必登记
        more.addEventListener('click', appendPage);
        appendPage();
        diffShell.append(table, more);
        body.appendChild(diffShell);
    }

    return Object.freeze({ renderDiffView });
}
