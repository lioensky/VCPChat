(() => {
    'use strict';
    const api = window.utilityAPI || window.electronAPI;
    const scope = new AbortController();
    const status = document.getElementById('game-status');
    const listen = (node, callback) => node?.addEventListener('click', callback, { signal: scope.signal });
    let maximized = false;
    listen(document.getElementById('minimize-btn'), () => api?.minimizeWindow?.());
    listen(document.getElementById('maximize-btn'), () => {
        if (maximized) api?.unmaximizeWindow?.();
        else api?.maximizeWindow?.();
    });
    listen(document.getElementById('close-btn'), () => api?.closeWindow?.());
    const cleanups = [
        api?.onWindowMaximized?.(() => { maximized = true; }),
        api?.onWindowUnmaximized?.(() => { maximized = false; }),
    ];
    document.querySelectorAll('[data-game]').forEach(button => {
        listen(button, async () => {
            if (button.disabled) return;
            button.disabled = true;
            status.textContent = '正在打开游戏…';
            try {
                if (!api?.launchGame) throw new Error('游戏启动接口未连接，请重启 VChat 后重试。');
                const result = await api.launchGame(button.dataset.game);
                if (!result?.success) throw new Error(result?.error || '游戏启动失败。');
                status.textContent = '游戏窗口已打开。再次点击会聚焦现有窗口。';
            } catch (error) {
                status.textContent = error.message;
            } finally {
                button.disabled = false;
            }
        });
    });
    const recordsStatus = document.getElementById('records-status');
    const recordsList = document.getElementById('game-records');
    const detail = document.getElementById('record-detail');
    let recordsToken = 0, detailToken = 0;
    const phaseLabel = record => record.phase === 'finished'
        ? (record.winner === 'landlord' ? '地主胜' : record.winner === 'farmers' ? '农民胜' : '已结束')
        : ({ bidding: '叫分中', playing: '对局中' })[record.phase] || record.phase;
    const title = record => `${new Date(record.createdAt).toLocaleString('zh-CN')} · ${record.players.join(' / ')} · ${phaseLabel(record)}`;
    async function request(name, args) {
        if (!api?.[name]) throw new Error('记录接口未连接，请重启 VChat。');
        const result = await api[name](args);
        if (!result?.success) throw new Error(result?.error || '读取记录失败。');
        return result;
    }
    async function showRecord(matchId) {
        const token = ++detailToken;
        recordsStatus.textContent = '正在读取牌史…';
        try {
            const record = await request('getGameRecord', { matchId });
            if (scope.signal.aborted || token !== detailToken) return;
            document.getElementById('record-title').textContent = title(record);
            document.getElementById('record-events').replaceChildren(...record.events.map(event => {
                const node = document.createElement('div');
                node.className = 'history-event';
                const name = record.players[event.seat] || '游戏系统';
                const action = ({
                    bid: event.bid ? `叫${event.bid}分` : '不叫',
                    play: `出牌 ${(event.cards || []).join(' ')}`, pass: '不出',
                    landlord: '成为地主', redeal: '全员不叫，重新发牌',
                    finished: '对局结束', 'new-match': '新一局开始',
                })[event.type] || event.type;
                node.textContent = `${name}：${action}${event.speech ? `\n“${event.speech}”` : ''}`;
                return node;
            }));
            detail.hidden = false;
            recordsStatus.textContent = record.events.length ? '公开牌史已加载。' : '本局尚无公开动作。';
        } catch (error) {
            if (!scope.signal.aborted && token === detailToken) recordsStatus.textContent = error.message;
        }
    }
    async function refreshRecords() {
        const token = ++recordsToken;
        ++detailToken;
        detail.hidden = true;
        recordsStatus.textContent = '正在读取记录…';
        try {
            const result = await request('listGameRecords');
            if (scope.signal.aborted || token !== recordsToken) return;
            recordsList.replaceChildren(...result.records.map(record => {
                const row = document.createElement('button');
                row.type = 'button'; row.className = 'history-record';
                row.textContent = title(record);
                row.addEventListener('click', () => { void showRecord(record.matchId); });
                return row;
            }));
            recordsStatus.textContent = `${result.records.length ? `共 ${result.records.length} 局，点击查看公开记录。` : '还没有斗地主记录。'}${result.unavailable.length ? ` ${result.unavailable.length} 个存档不可读取，未删除或覆盖。` : ''}`;
        } catch (error) {
            if (!scope.signal.aborted && token === recordsToken) recordsStatus.textContent = error.message;
        }
    }
    listen(document.getElementById('refresh-records'), () => { void refreshRecords(); });
    void refreshRecords();
    api?.windowReady?.('game-hall');
    window.addEventListener('pagehide', () => {
        scope.abort();
        cleanups.forEach(cleanup => { if (typeof cleanup === 'function') cleanup(); });
    }, { once: true });
})();