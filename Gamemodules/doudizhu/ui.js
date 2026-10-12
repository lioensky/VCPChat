(() => {
    'use strict';
    const api = window.utilityAPI;
    const $ = id => document.getElementById(id);
    const scope = new AbortController();
    const listen = (node, callback) => node.addEventListener('click', callback, { signal: scope.signal });
    const SAVE = 'vgame-doudizhu-last-match';
    const PENDING_SAVE = 'vgame-doudizhu-pending';
    function rememberPending() {
        if (pending) localStorage.setItem(PENDING_SAVE, JSON.stringify(pending));
        else localStorage.removeItem(PENDING_SAVE);
    }
    let matchId = null, observation = null, selected = new Set(), busy = false;
    let pending = null, timer = null, disposed = false, painted = '';
    let runtimeRunning = false;
    const status = text => { $('status').textContent = text; };
    async function call(name, request) {
        if (!api?.[name]) throw new Error('牌桌接口未连接，请重启VChat。');
        const result = await api[name](request);
        if (!result?.success) throw Object.assign(new Error(result?.error || '游戏请求失败。'), { code: result?.code });
        return result;
    }
    function label(card) {
        if (card === 'BJ') return '小王';
        if (card === 'RJ') return '大王';
        return ({ S: '♠', H: '♥', D: '♦', C: '♣' })[card[0]] + card.slice(1);
    }
    function controls() {
        const turn = observation?.turn === 0 && !busy && !pending;
        document.querySelectorAll('[data-bid]').forEach(button => {
            const bid = Number(button.dataset.bid);
            button.disabled = !turn || observation.phase !== 'bidding'
                || (bid > 0 && bid <= observation.highestBid);
        });
        $('play').disabled = !turn || observation.phase !== 'playing' || selected.size === 0;
        $('pass').disabled = !turn || !observation.canPass;
        $('create').disabled = busy || pending !== null || (observation && observation.phase !== 'finished');
        $('next').disabled = busy || pending !== null || !observation
            || observation.phase !== 'finished' || runtimeRunning;
        $('retry').hidden = pending === null;
        $('retry').disabled = busy;
    }
    function paint(result) {
        observation = result.observation;
        runtimeRunning = result.runtime.running === true;
        const key = JSON.stringify([observation.revision, result.runtime, result.seats]);
        if (key !== painted) {
            painted = key;
            selected = new Set([...selected].filter(card => observation.hand.includes(card)));
            $('seats').replaceChildren(...result.seats.map((seat, index) => {
                const node = document.createElement('div');
                node.className = 'seat' + (observation.turn === index ? ' active' : '');
                node.textContent = `${seat.name} · ${observation.landlord === index ? '地主' : '农民/待定'} · ${observation.remaining[index]}张`;
                return node;
            }));
            $('target').textContent = observation.phase === 'finished'
                ? `${observation.winner === 'landlord' ? '地主' : '农民'}获胜`
                : observation.phase === 'bidding' ? `叫分阶段 · 最高${observation.highestBid}分`
                    : observation.target ? `需压过：${observation.target.cards.map(label).join(' ')}`
                        : '新一轮首出';
            $('bottom').textContent = observation.bottom.length ? `底牌：${observation.bottom.map(label).join(' ')}` : '底牌未揭示';
            $('events').replaceChildren(...observation.events.map(event => {
                const node = document.createElement('div');
                node.className = 'event';
                const name = result.seats[event.seat]?.name || '游戏系统';
                node.textContent = `${event.id} · ${name}：` + ({
                    bid: event.bid ? `叫${event.bid}分` : '不叫',
                    pass: '不出', play: `出牌 ${(event.cards || []).map(label).join(' ')}`,
                    landlord: '成为地主', redeal: '全员不叫，重新发牌',
                    finished: '对局结束', 'new-match': '新一局开始，保留原桌交流上下文',
                })[event.type] + (event.speech ? `\n“${event.speech}”` : '');
                if (event.emoteUrl) {
                    const image = document.createElement('img');
                    image.src = event.emoteUrl; image.alt = '玩家表情'; image.referrerPolicy = 'no-referrer';
                    node.append(image);
                }
                return node;
            }));
            status(`阶段：${observation.phase} · 后台：${result.runtime.status}${result.runtime.reason ? ` (${result.runtime.reason})` : ''}`);
        }
        $('hand').replaceChildren(...observation.hand.map(card => {
            const button = document.createElement('button');
            button.className = `card${/^[HD]/.test(card) ? ' red' : ''}${selected.has(card) ? ' selected' : ''}`;
            button.textContent = label(card);
            button.disabled = busy || pending !== null || observation.turn !== 0;
            button.addEventListener('click', () => {
                if (selected.has(card)) selected.delete(card); else selected.add(card);
                button.classList.toggle('selected', selected.has(card)); controls();
            });
            return button;
        }));
        controls();
    }
    async function refresh() {
        if (matchId) {
            const requestedMatch = matchId;
            const result = await call('observeGameTable', { matchId: requestedMatch });
            if (!disposed && matchId === requestedMatch) paint(result);
        }
    }
    async function poll() {
        try { if (!busy && matchId) await refresh(); }
        catch (error) { status(error.message); }
        finally { if (!disposed) timer = setTimeout(poll, 1200); }
    }
    async function sendPending() {
        busy = true; controls();
        try {
            rememberPending();
            await call('submitGameAction', pending);
            pending = null;
            rememberPending();
            selected.clear(); $('speech').value = ''; $('emote').value = '';
            await refresh();
        } catch (error) {
            // Business rejection is known not to have committed; transport failure retains original ID.
            if (error.code) {
                pending = null;
                try { rememberPending(); } catch {}
            }
            status(error.message);
        } finally { busy = false; controls(); }
    }
    function submit(action) {
        if (busy || pending || observation?.turn !== 0) return;
        pending = {
            matchId, decisionId: observation.decisionId, revision: observation.revision,
            submissionId: crypto.randomUUID(),
            action: { ...action, speech: $('speech').value, emoteUrl: $('emote').value.trim() },
        };
        void sendPending();
    }
    listen($('create'), async () => {
        busy = true; controls();
        try {
            const result = await call('createGameTable', {
                agentIds: [$('agent-one').value, $('agent-two').value],
                userName: $('user-name').value,
                contextMessageWindowSize: Number($('context-size').value),
            });
            matchId = result.matchId; painted = '';
            try { localStorage.setItem(SAVE, matchId); } catch {}
            await refresh();
        } catch (error) { status(error.message); }
        finally { busy = false; controls(); }
    });
    listen($('next'), async () => {
        if (busy || pending || observation?.phase !== 'finished' || runtimeRunning) return;
        busy = true; controls();
        try {
            const table = await call('nextGameTable', { matchId });
            matchId = table.matchId; painted = ''; selected.clear();
            $('speech').value = ''; $('emote').value = '';
            try { localStorage.setItem(SAVE, matchId); } catch {}
            await refresh();
        } catch (error) { status(error.message); }
        finally { busy = false; controls(); }
    });
    listen($('resume'), async () => {
        if (busy || pending) return;
        try {
            const saved = localStorage.getItem(SAVE);
            if (!saved) throw new Error('没有上次牌桌记录。');
            const storedPending = localStorage.getItem(PENDING_SAVE);
            const restored = storedPending ? JSON.parse(storedPending) : null;
            pending = restored?.matchId === saved ? restored : null;
            matchId = saved; painted = ''; await refresh();
        } catch (error) { status(error.message); }
    });
    for (const [id, method] of [['continue', 'continueGameTable'], ['stop', 'stopGameTable']]) {
        listen($(id), async () => {
            try { if (matchId) { await call(method, { matchId }); await refresh(); } }
            catch (error) { status(error.message); }
        });
    }
    document.querySelectorAll('[data-bid]').forEach(button => listen(button, () => submit({ type: 'bid', bid: Number(button.dataset.bid) })));
    listen($('play'), () => submit({ type: 'play', cards: [...selected] }));
    listen($('pass'), () => submit({ type: 'pass' }));
    listen($('clear'), () => { selected.clear(); painted = ''; void refresh().catch(error => status(error.message)); });
    listen($('retry'), () => { if (pending && !busy) void sendPending(); });
    call('listGameAgents').then(result => {
        for (const id of ['agent-one', 'agent-two']) {
            $(id).replaceChildren(...result.agents.map(agent => {
                const option = document.createElement('option');
                option.value = agent.id; option.textContent = agent.name; return option;
            }));
        }
        $('agent-two').selectedIndex = result.agents.length > 1 ? 1 : 0;
        status('选择两位伙伴，开一桌。'); controls();
    }).catch(error => status(error.message));
    void poll();
    window.addEventListener('pagehide', () => {
        disposed = true; clearTimeout(timer); scope.abort();
    }, { once: true });
})();