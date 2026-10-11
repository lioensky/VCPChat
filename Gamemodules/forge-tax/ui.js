(async () => {
    'use strict';
    const { Engine, ITEMS } = window.ForgeTax;
    const SAVE = 'forge-tax-save-v1', BOARD = 'forge-tax-board-v1';
    const $ = id => document.getElementById(id);
    const scope = new AbortController();
    const on = (node, event, fn) => node.addEventListener(event, fn, { signal: scope.signal });
    let soundEnabled = true;
    try { soundEnabled = localStorage.getItem('forge-tax-sound-v1') !== 'off'; } catch {}
    const sound = new window.ForgeTaxAudio.Sound({ enabled: soundEnabled });
    function updateSoundButton() {
        $('sound-toggle').textContent = sound.enabled ? '音效：开' : '音效：关';
        $('sound-toggle').setAttribute('aria-pressed', String(sound.enabled));
    }
    on(document, 'pointerdown', () => { void sound.unlock(); });
    on(document, 'keydown', () => { void sound.unlock(); });
    on($('sound-toggle'), 'click', () => {
        sound.setEnabled(!sound.enabled);
        try { localStorage.setItem('forge-tax-sound-v1', sound.enabled ? 'on' : 'off'); } catch {}
        updateSoundButton();
        if (sound.enabled) void sound.unlock();
    });
    updateSoundButton();
    const fmt = n => '¥' + Math.round(n).toLocaleString('zh-CN');
    const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const remote = window.forgeTaxRemote;
    let readOnly = false, unsubscribe = null;
    let engine, selected, checked = new Set(), logs = [], persistenceWarning = '';
    try {
        const stored = localStorage.getItem(SAVE);
        engine = stored ? new Engine({ save: JSON.parse(stored) }) : new Engine();
    } catch (error) {
        engine = new Engine();
        persistenceWarning = '存档无法读取，已创建临时新局；旧存档不会在首次操作前覆盖：' + error.message;
    }
    if (remote) {
        try {
            const initial = await remote.getState();
            if (!initial.ok || !initial.state) throw new Error(initial.error || '尚无对局，请由Agent开局');
            readOnly = initial.readOnly;
            let snapshot = initial.state;
            engine = {
                getState: () => snapshot,
                setState: state => { snapshot = state; },
                saleValue: sw => Math.round(sw.value * (snapshot.relics.some(r => r.id === 'scrap') && !sw.broken && sw.level <= 5 ? 1.3 : 1))
            };
        } catch (error) {
            $('notice').textContent = '远程对局加载失败：' + error.message;
            document.querySelectorAll('button').forEach(button => { button.disabled = true; });
            return;
        }
    }
    function persist() {
        if (remote) return;
        try { localStorage.setItem(SAVE, JSON.stringify(engine.exportSave())); persistenceWarning = ''; }
        catch (error) { persistenceWarning = '自动保存失败，本次进度仅存在内存中：' + error.message; }
    }
    function closePanel() { $('info-panel').hidden = true; $('info-body').replaceChildren(); }
    function modal(title, html) {
        $('info-title').textContent = title; $('info-body').innerHTML = html;
        $('info-panel').hidden = false;
    }
    function confirmAction(title, text, action) {
        const revision = engine.getState().revision;
        modal(title, `<p>${escape(text)}</p><button id="confirm-action">确认执行</button> <button id="cancel-action">取消</button>`);
        on($('confirm-action'), 'click', () => act({ ...action, revision }));
        on($('cancel-action'), 'click', closePanel);
    }
    function recordScore() {
        const s = engine.getState();
        if (remote || s.status === 'playing') return;
        try {
            const rows = JSON.parse(localStorage.getItem(BOARD) || '[]');
            if (!Array.isArray(rows)) throw new Error('排行榜格式无效');
            if (rows.some(row => row.runId === s.runId)) return;
            rows.push({ runId: s.runId, player: s.player, income: s.income, day: s.day, maxSword: s.maxSword, status: s.status });
            rows.sort((a, b) => b.income - a.income || b.day - a.day);
            localStorage.setItem(BOARD, JSON.stringify(rows.slice(0, 100)));
        } catch (error) { persistenceWarning = '本机成绩保存失败：' + error.message; }
    }
    const labels = { break: '破碎', damage: '损坏', maintain: '维持', success: '成功', critical: '大成功' };
    function eventText(e) {
        if (e.type === 'hammer') return `${e.safe ? '【专注】' : ''}${labels[e.result]}${e.blocked ? ' · 负面后果已挡下，风险仍累积' : ''}：${fmt(e.before)} → ${fmt(e.after)}${e.result === 'critical' ? ' ★' : ''}`;
        if (e.type === 'evolution') return `进化！${e.name}`;
        if (e.type === 'focus') return `进入专注，追加${e.count}次安全锤！`;
        if (e.type === 'tribute') return `第${e.day}天结算：认定${fmt(e.credited)} / 目标${fmt(e.target)}，到账${fmt(e.paid)} · ${e.passed ? '审查通过' : '不达标，失去一条命'}`;
        if (e.type === 'day') return `第${e.day}天开始，铁剑已发放，遗物机已刷新。`;
        if (e.type === 'end') return e.ending;
        return e.message || (e.type === 'relicPurchase' ? '遗物兑换完成' : e.type === 'purchase' ? `购买完成，花费${fmt(e.price)}` : '操作完成');
    }
    function consume(result, action = {}) {
        if (remote && result.state) engine.setState(result.state);
        if (!result.ok && !result.partial) {
            if (result.state) render();
            $('notice').textContent = result.error || '操作失败'; return result;
        }
        for (const e of result.events) logs.unshift({ text: eventText(e), cls: e.type === 'hammer' ? (e.result === 'break' || e.result === 'damage') && !e.blocked ? 'bad' : e.result === 'critical' || e.result === 'success' ? 'good' : '' : e.type === 'end' ? 'bad' : '' });
        logs = logs.slice(0, 100);
        void sound.playResult({ ...result, ok: true });
        closePanel(); persist(); recordScore(); render();
        if (action.type === 'hammer') $('anvil').querySelector('.blade-icon')?.classList.add('strike');
        if (result.state.status !== 'playing') modal(result.state.status === 'victory' ? '真结局 · 魔王已死' : 'Game Over · 魔王处决', `<p>第 ${result.state.day} 天 · 累计收入 <strong>${fmt(result.state.income)}</strong></p><p>最高单剑价值 ${fmt(result.state.maxSword)}</p><p>成绩已尝试记录到本机排行榜。可以查看背包，或开始新局。</p>`);
        return result;
    }
    async function act(action) {
        if (remote) {
            if (readOnly) { $('notice').textContent = 'AI对局只读观看，请由对应Agent操作。'; return { ok: false }; }
            const commands = { hammer: 'Hammer', use: 'UseItem', buyItem: 'BuyItem', buyRelic: 'BuyRelic', tribute: 'Tribute', watch: 'Watch', slay: 'Slay' };
            const result = await remote.command({
                ...action, command: commands[action.type],
                runId: engine.getState().runId,
                revision: action.revision ?? engine.getState().revision
            });
            // State/events are consumed by the single subscription, not again here.
            if (!result.ok) $('notice').textContent = result.error || '操作失败';
            return result;
        }
        return consume(engine.dispatch({ ...action, revision: action?.revision ?? engine.getState().revision }), action);
    }
    if (remote) unsubscribe = remote.onUpdate(result => consume(result));
    function render() {
        const s = engine.getState(), playing = s.status === 'playing' && !readOnly;
        checked = new Set([...checked].filter(id => s.swords.some(sword => sword.id === id)));
        if (!s.swords.some(sword => sword.id === selected)) selected = s.swords.find(sword => !sword.broken)?.id || s.swords[0]?.id;
        $('stats').innerHTML = [
            ['锻造师', escape(s.player)], ['天数 / 剩余命', `${s.day} / ${'♥'.repeat(Math.max(0, s.lives)) || '×'}`],
            ['今日贡金', fmt(s.target)], ['明日贡金', fmt(s.nextTarget)], ['现金余额', fmt(s.cash)], ['累计收入', fmt(s.income)]
        ].map(([k, v]) => `<div class="stat"><small>${k}</small><strong>${v}</strong></div>`).join('');
        $('notice').textContent = persistenceWarning || (playing ? '锤子免费。碎了，就真的碎了。现金不能代替今日贡品。' : s.status === 'victory' ? '圣剑终结了魔王的审查。' : '累计两天不达标，魔王已结束你的职业生涯。');
        $('bag-count').textContent = `${s.swords.length}把`;
        $('inventory').innerHTML = s.swords.map(sw => `<article class="sword${sw.id === selected ? ' selected' : ''}" data-sword="${sw.id}" tabindex="0" role="button" aria-label="选中${escape(sw.name)}">
            <div class="row"><span>${escape(sw.name)} +${sw.level}</span><label title="勾选上贡"><input aria-label="上贡${escape(sw.name)} ${sw.id}" type="checkbox" data-check="${sw.id}" ${checked.has(sw.id) ? 'checked' : ''} ${!playing ? 'disabled' : ''}></label></div>
            <div class="row"><strong>${fmt(sw.value)}</strong><small>${sw.id}</small></div>
            <small>${sw.broken ? '不可强化 · 不可兑换' : `专注 ${sw.focus}/10 · 裂痕 ${sw.cracks.toFixed(1)} · 已锤 ${sw.hits}次`}</small></article>`).join('') || '<p class="hint">背包空了。可以买剑，或空交结束今天。</p>';
        const sword = s.swords.find(sw => sw.id === selected);
        $('anvil').innerHTML = sword ? `<div class="blade-icon">⚔</div><strong>${escape(sword.name)} +${sword.level}</strong><div class="value">${fmt(sword.value)}</div>
            ${sword.broken ? '<p>残剑不可锻造，可以上贡。</p>' : `<progress aria-label="专注进度" value="${sword.focus}" max="10"></progress><small>专注 ${sword.focus}/10 · 裂痕 ${sword.cracks.toFixed(1)} · 风险积累 ${sword.pressure.toFixed(1)}</small><div class="probabilities">${sword.probabilities.map((p, i) => `<span style="width:${p * 100}%;background:${['#f35e71', '#b97956', '#918494', '#81c6a7', '#ffc86e'][i]}"></span>`).join('')}</div><div class="prob-labels">${sword.probabilities.map((p, i) => `${['破碎', '损坏', '维持', '成功', '大成功'][i]} ${(p * 100).toFixed(1)}%`).join(' · ')}</div><p class="hint">${sword.protection ? '保护已就绪 ' : ''}${sword.blessing ? '祝福已就绪 ' : ''}${sword.surge ? '以损换势已就绪' : ''}</p>`}` : '<div class="blade-icon">⚒</div><p>选择一把剑，或者买一把新的。</p>';
        document.querySelectorAll('[data-hits]').forEach(button => { button.disabled = !playing || !sword || sword.broken; });
        $('items').innerHTML = ITEMS.filter(i => i.id !== 'iron').map(item => `<button data-use="${item.id}" title="${escape(item.description)}" ${!playing || !s.items[item.id] || item.id === 'watch' && !s.canUndo || ['protect', 'bless'].includes(item.id) && (!sword || sword.broken) ? 'disabled' : ''}>${item.name} ×${s.items[item.id]}</button>`).join('');
        $('relics').innerHTML = Array.from({ length: 8 }, (_, i) => {
            const r = s.relics[i];
            return r ? `<div class="relic-slot rarity-${r.rarity}" title="${escape(r.description)}">${r.name}<small>${r.description}</small></div>` : `<div class="relic-slot"><small>空槽 ${i + 1}</small></div>`;
        }).join('');
        $('relic-shop').innerHTML = s.shops.relics.map(r => `<div class="shop-card rarity-${r.rarity}"><strong>${['', '普通', '稀有', '传说'][r.rarity]} · ${r.name}</strong><p>${r.description}</p><button data-relic="${r.id}" ${!playing || r.sold || r.owned ? 'disabled' : ''}>${r.sold ? '已兑换' : r.owned ? '已持有' : `${r.cost}把未锻造铁剑兑换`}</button></div>`).join('');
        $('item-shop').innerHTML = s.shops.items.map(i => `<div class="shop-card"><strong>${i.name}</strong><p>${i.description}</p><button data-buy="${i.id}" ${!playing || i.bought >= 3 || s.cash < i.price ? 'disabled' : ''}>${i.bought >= 3 ? '本轮售罄' : `${fmt(i.price)} · 已买${i.bought}/3`}</button></div>`).join('');
        $('refresh').textContent = `${s.shopRefreshIn}天后刷新；每件本轮限买3个，价格依次1/2/4倍。`;
        $('log').innerHTML = logs.map(l => `<li class="${l.cls}">${escape(l.text)}</li>`).join('');
        const offered = s.swords.filter(sw => checked.has(sw.id));
        const total = offered.reduce((sum, sw) => sum + engine.saleValue(sw), 0);
        const credit = total + (s.relics.some(r => r.id === 'seal') && offered.length ? engine.saleValue(offered[0]) * .2 : 0);
        $('tribute-total').textContent = `已选${offered.length}把 · 认定${fmt(credit)} ${credit >= s.target ? '✓ 达标' : '⚠ 未达标'}`;
        $('tribute').disabled = !playing;
        $('slay').hidden = !playing || !s.swords.some(sw => !sw.broken && sw.level === 99);
    }
    on($('inventory'), 'click', e => {
        const checkbox = e.target.closest('[data-check]');
        if (checkbox) { checkbox.checked ? checked.add(checkbox.dataset.check) : checked.delete(checkbox.dataset.check); render(); return; }
        const card = e.target.closest('[data-sword]');
        if (card) { selected = card.dataset.sword; render(); }
    });
    on($('inventory'), 'keydown', e => {
        if (!e.target.matches('[data-sword]') || !['Enter', ' '].includes(e.key)) return;
        e.preventDefault(); selected = e.target.dataset.sword; render();
    });
    document.querySelectorAll('[data-hits]').forEach(button => on(button, 'click', () => act({ type: 'hammer', swordId: selected, count: Number(button.dataset.hits) })));
    on($('items'), 'click', e => {
        const button = e.target.closest('[data-use]'); if (!button) return;
        const id = button.dataset.use;
        act(id === 'watch' ? { type: 'watch' } : { type: 'use', itemId: id, swordId: selected });
    });
    on($('item-shop'), 'click', e => {
        const button = e.target.closest('[data-buy]');
        if (button) act({ type: 'buyItem', itemId: button.dataset.buy });
    });
    on($('relic-shop'), 'click', e => {
        const button = e.target.closest('[data-relic]'); if (!button) return;
        const s = engine.getState(), r = s.shops.relics.find(r => r.id === button.dataset.relic);
        const ids = s.swords.filter(sw => !sw.broken && sw.type === 'iron' && sw.level === 0 && sw.hits === 0).slice(0, r.cost).map(sw => sw.id);
        if (ids.length < r.cost) { $('notice').textContent = '未敲过的基础铁剑不足，已经敲过的剑不能兑换。'; return; }
        const revision = s.revision;
        const buy = replaceId => {
            if (engine.getState().revision !== revision) { closePanel(); $('notice').textContent = '状态已变化，请重新选择兑换。'; return; }
            const old = s.relics.find(relic => relic.id === replaceId);
            confirmAction('确认兑换遗物', `用 ${ids.join('、')} 兑换「${r.name}」${old ? `，永久卸下「${old.name}」` : ''}。`,
                { type: 'buyRelic', relicId: r.id, swordIds: ids, replaceId });
        };
        if (s.relics.length < 8) buy();
        else {
            modal('八槽已满 · 选择被替换的遗物', `<p>兑换 ${escape(r.name)}；取消不会消耗铁剑。</p>${s.relics.map(old => `<button class="replacement" data-replace="${old.id}">${old.name} — ${old.description}</button>`).join('')}`);
            $('info-body').querySelectorAll('[data-replace]').forEach(node => on(node, 'click', () => buy(node.dataset.replace)));
        }
    });
    on($('tribute'), 'click', () => {
        const s = engine.getState();
        const ids = s.swords.filter(sw => checked.has(sw.id)).map(sw => sw.id);
        confirmAction('确认今日上贡', `${$('tribute-total').textContent}。上贡会失去选中的剑并结束今天。未达标扣命，累计两次死亡。`, { type: 'tribute', swordIds: ids });
    });
    on($('slay'), 'click', () => confirmAction('举剑弑王', '弑杀魔王将结束本局并提交本机成绩。', { type: 'slay' }));
    on($('info-close'), 'click', closePanel);
    on($('new'), 'click', () => {
        modal('新的一局', '<p>开始后覆盖当前自动存档。未结束旧局不提交成绩。</p><label>锻造师名字<input id="player-name" maxlength="32" value="莱恩"></label><p><button id="start-run">确认开局</button></p>');
        $('start-run').addEventListener('click', async () => {
            if (remote) {
                const result = await remote.command({ command: 'StartGame', overwrite: true, player: $('player-name').value.trim() || '莱恩' });
                if (!result.ok) $('notice').textContent = result.error;
                return;
            }
            engine = new Engine({ player: $('player-name').value.trim() || '莱恩' });
            selected = null; checked.clear(); logs = []; persist(); render(); closePanel();
        }, { once: true });
    });
    on($('leaderboard'), 'click', () => {
        let rows = [];
        try { rows = JSON.parse(localStorage.getItem(BOARD) || '[]'); if (!Array.isArray(rows)) rows = []; } catch {}
        modal('累计收入 · 本机排行榜', '<p class="hint">只收录结束的局；本机数据可修改，不是可信公共榜。收入为上贡实际到账金额，花钱不扣分，拾荒奖励不计分。</p><table><thead><tr><th>名字</th><th>收入</th><th>天数</th><th>结局</th></tr></thead><tbody>' + rows.map(r => `<tr><td>${escape(r.player)}</td><td>${fmt(r.income)}</td><td>${r.day}</td><td>${r.status === 'victory' ? '弑王' : '处决'}</td></tr>`).join('') + '</tbody></table>');
    });
    on($('help'), 'click', () => modal('锤子免费，命只有两条', `<p>每日获得3把价值100的铁剑。每锤可能破碎、损坏、维持、成功或大成功。成功增加价值与强化等级，可能进化；大成功+2。任意剑达到+99成为圣剑，可选择弑王取得真结局。</p><p>十格专注自动触发五次安全锤；安全锤不积累专注，也不清除裂痕或破碎率。负面判定照常积累并触发相应遗物，但不执行破碎/损坏。</p><p>勾选剑后上贡：总价达到当日贡金即过关，钱全额到账，旧现金不能补交。累计两天失败即死亡。未上贡的剑跨天保留。</p><p>遗物机每天刷3件，普通/稀有/传说花费1/2/3把从未敲过的铁剑；固定8槽，满槽需替换。道具商店第1、4、7…天刷新。</p><p>怀表只能撤销最近操作末尾的实际损坏/破碎；继续操作后失效，随机状态也回退。批量锻造仍逐锤执行。</p><p>钱与价值最高为JavaScript安全整数。当前数值属于首版，可在规则引擎调参。</p>`));
    // Local adapter only. IPC will authorize identity and own persistence later.
    window.forgeTaxGame = Object.freeze({
        getState: () => engine.getState(),
        dispatch: action => act(action),
        exportSave: () => remote ? null : engine.exportSave()
    });
    window.addEventListener('pagehide', () => { scope.abort(); unsubscribe?.(); sound.dispose(); }, { once: true });
    $('new').disabled = readOnly;
    render(); recordScore();
})();