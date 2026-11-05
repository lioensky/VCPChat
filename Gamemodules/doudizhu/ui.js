(() => {
    'use strict';
    const api = window.utilityAPI;
    const $ = id => document.getElementById(id);
    const scope = new AbortController();
    const listen = (node, callback, eventName = 'click') => {
        if (node) node.addEventListener(eventName, callback, { signal: scope.signal });
    };
    const SAVE = 'vgame-doudizhu-last-match';
    const PENDING_SAVE = 'vgame-doudizhu-pending';
    const CUSTOM_MODEL_VALUE = '__custom__';

    let matchId = null, observation = null, selected = new Set(), busy = false;
    let pending = null, timer = null, disposed = false, painted = '';
    let runtimeRunning = false;
    let settingsSaving = false;
    let setupMode = 'spectate'; // 'spectate' (3 AI) | 'human' (1 human + 2 AI)
    let activeSpectatorMatch = true;
    let currentSeats = [];
    let revealHands = true;
    let catalog = { agents: [], models: [], favoriteModels: [], hotModels: [] };

    const fallbackStore = new Map();
    const readStore = key => {
        try { return localStorage.getItem(key); }
        catch { return fallbackStore.get(key) ?? null; }
    };
    const writeStore = (key, value) => {
        fallbackStore.set(key, String(value));
        try { localStorage.setItem(key, String(value)); } catch { /* opaque origin fallback */ }
    };
    const removeStore = key => {
        fallbackStore.delete(key);
        try { localStorage.removeItem(key); } catch { /* opaque origin fallback */ }
    };

    function rememberPending() {
        if (pending) writeStore(PENDING_SAVE, JSON.stringify(pending));
        else removeStore(PENDING_SAVE);
    }
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

    function makeMiniCard(card) {
        const span = document.createElement('span');
        const isJoker = card === 'BJ' || card === 'RJ';
        const isRed = card === 'RJ' || /^[HD]/.test(card);
        span.className = 'mini-card' + (isRed ? ' red' : '') + (isJoker ? ' joker' : '');
        span.textContent = label(card);
        return span;
    }

    function syncModeUI() {
        const spectate = setupMode === 'spectate';
        $('mode-spectate').classList.toggle('active', spectate);
        $('mode-human').classList.toggle('active', !spectate);
        $('slot-zero-card').hidden = !spectate;
        $('human-name-wrap').hidden = spectate;
        $('slot-one-title').textContent = spectate ? '二号位 AI' : '伙伴一';
        $('slot-two-title').textContent = spectate ? '三号位 AI' : '伙伴二';

        if (!matchId) {
            $('spectator-banner').hidden = !spectate;
            $('human-zone').hidden = spectate;
            $('target').textContent = spectate
                ? '选好三位 AI 与各自本局模型，点击「开新桌」即可坐山观虎斗。'
                : '选好两位伙伴与模型，点击「开新桌」亲自上阵。';
        }
        controls();
    }

    function syncRevealButton() {
        const btn = $('toggle-reveal');
        btn.hidden = !(matchId && activeSpectatorMatch);
        btn.textContent = revealHands ? '👁 上帝明牌：开' : '🂠 上帝明牌：关';
    }

    function populateModelSelect(slotKey, preserveSelection = true) {
        const agentSelect = $(`agent-${slotKey}`);
        const modelSelect = $(`model-${slotKey}`);
        const customInput = $(`custom-model-${slotKey}`);
        const previousValue = preserveSelection ? modelSelect.value : '';
        const agent = catalog.agents.find(item => item.id === agentSelect.value);
        const defaultModel = agent?.model || '';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = defaultModel
            ? `跟随角色默认 (${defaultModel})`
            : '跟随角色默认';

        const seen = new Set();
        const buildGroup = (title, items) => {
            const list = (items || []).filter(id => id && !seen.has(id));
            if (!list.length) return null;
            const group = document.createElement('optgroup');
            group.label = title;
            for (const id of list) {
                seen.add(id);
                const opt = document.createElement('option');
                opt.value = id;
                opt.textContent = id;
                group.append(opt);
            }
            return group;
        };

        const favGroup = buildGroup('⭐ 收藏模型', catalog.favoriteModels);
        const hotGroup = buildGroup('🔥 常用模型', catalog.hotModels);
        const allGroup = buildGroup('🌐 可用模型', catalog.models);

        const customOption = document.createElement('option');
        customOption.value = CUSTOM_MODEL_VALUE;
        customOption.textContent = '✏️ 手动输入模型 ID…';

        const children = [defaultOption, favGroup, hotGroup, allGroup, customOption].filter(Boolean);
        modelSelect.replaceChildren(...children);

        if (previousValue && (previousValue === CUSTOM_MODEL_VALUE || seen.has(previousValue))) {
            modelSelect.value = previousValue;
        } else {
            modelSelect.value = '';
        }
        customInput.hidden = modelSelect.value !== CUSTOM_MODEL_VALUE;
    }

    function readChosenModel(slotKey) {
        const modelSelect = $(`model-${slotKey}`);
        const customInput = $(`custom-model-${slotKey}`);
        if (modelSelect.value === CUSTOM_MODEL_VALUE) {
            const val = customInput.value.trim();
            if (!val) throw new Error('请填写手动输入的模型 ID，或切回下拉列表模型。');
            return val;
        }
        return modelSelect.value.trim();
    }

    function collectSeatModelPayload(spectate = setupMode === 'spectate') {
        const slotKeys = spectate ? ['zero', 'one', 'two'] : ['one', 'two'];
        return {
            agentIds: slotKeys.map(key => $(`agent-${key}`).value),
            agentModels: slotKeys.map(key => readChosenModel(key)),
        };
    }

    function uiMatchesCurrentRoster() {
        if (!matchId || !Array.isArray(currentSeats) || !currentSeats.length) return false;
        const matchSpectate = currentSeats.every(seat => seat?.kind === 'agent');
        if ((setupMode === 'spectate') !== matchSpectate) return false;
        const slotKeys = matchSpectate ? ['zero', 'one', 'two'] : ['one', 'two'];
        const matchAgentIds = currentSeats.filter(seat => seat?.kind === 'agent').map(seat => seat.agentId);
        return slotKeys.length === matchAgentIds.length
            && slotKeys.every((key, idx) => $(`agent-${key}`).value === matchAgentIds[idx]);
    }

    function syncControlsFromSeats(seats) {
        if (!Array.isArray(seats) || !seats.length) return;
        const spectate = seats.every(seat => seat?.kind === 'agent');
        setupMode = spectate ? 'spectate' : 'human';
        syncModeUI();
        if (!spectate && seats[0]?.name) $('user-name').value = seats[0].name;
        const slotKeys = spectate ? ['zero', 'one', 'two'] : ['one', 'two'];
        const agentSeats = seats.filter(seat => seat?.kind === 'agent');
        slotKeys.forEach((key, idx) => {
            const seat = agentSeats[idx];
            if (!seat) return;
            const agentSelect = $(`agent-${key}`);
            if ([...agentSelect.options].some(opt => opt.value === seat.agentId)) {
                agentSelect.value = seat.agentId;
            }
            populateModelSelect(key, false);
            const modelSelect = $(`model-${key}`);
            const customInput = $(`custom-model-${key}`);
            const override = typeof seat.model === 'string' ? seat.model.trim() : '';
            if (!override) {
                modelSelect.value = '';
                customInput.value = '';
                customInput.hidden = true;
            } else if ([...modelSelect.options].some(opt => opt.value === override)) {
                modelSelect.value = override;
                customInput.value = '';
                customInput.hidden = true;
            } else {
                modelSelect.value = CUSTOM_MODEL_VALUE;
                customInput.value = override;
                customInput.hidden = false;
            }
        });
    }

    async function syncActiveMatchModels() {
        if (!matchId || busy || disposed) return;
        if (!uiMatchesCurrentRoster()) {
            status('已修改角色或模式设置，请点击「开新桌」开启新牌局。');
            return;
        }
        try {
            const requestedMatch = matchId;
            const payload = collectSeatModelPayload(activeSpectatorMatch);
            const result = await call('observeGameTable', { matchId: requestedMatch, ...payload });
            if (!disposed && matchId === requestedMatch) {
                painted = '';
                paint(result);
                status('本局座位模型已实时切换，下一回合与「再来一局」立即生效。');
            }
        } catch (error) { status(error.message); }
    }

    function selectDefaultAgents(agents) {
        if (!agents.length) return;
        for (const [index, key] of ['zero', 'one', 'two'].entries()) {
            $(`agent-${key}`).value = agents[index % agents.length].id;
        }
    }

    async function loadCatalog(refreshModels = false) {
        const previousAgents = ['zero', 'one', 'two'].map(k => $(`agent-${k}`).value);
        const result = await call('listGameAgents', refreshModels ? { refreshModels: true } : {});
        catalog = {
            agents: Array.isArray(result.agents) ? result.agents : [],
            models: Array.isArray(result.models) ? result.models : [],
            favoriteModels: Array.isArray(result.favoriteModels) ? result.favoriteModels : [],
            hotModels: Array.isArray(result.hotModels) ? result.hotModels : [],
        };
        for (const [idx, key] of ['zero', 'one', 'two'].entries()) {
            const select = $(`agent-${key}`);
            select.replaceChildren(...catalog.agents.map(agent => {
                const option = document.createElement('option');
                option.value = agent.id;
                option.textContent = agent.model ? `${agent.name} (${agent.model})` : agent.name;
                return option;
            }));
            if (previousAgents[idx] && catalog.agents.some(a => a.id === previousAgents[idx])) {
                select.value = previousAgents[idx];
            }
        }
        if (!previousAgents.some(Boolean)) {
            selectDefaultAgents(catalog.agents);
        }
        for (const key of ['zero', 'one', 'two']) {
            populateModelSelect(key, Boolean(previousAgents[0] || refreshModels));
        }
    }

    function controls() {
        $('auto-pass').disabled = busy || pending !== null || settingsSaving;
        const humanTurn = !activeSpectatorMatch && observation?.turn === 0 && !busy && !pending;
        document.querySelectorAll('[data-bid]').forEach(button => {
            const bid = Number(button.dataset.bid);
            button.disabled = !humanTurn || observation?.phase !== 'bidding'
                || (bid > 0 && bid <= observation.highestBid);
        });
        $('play').disabled = !humanTurn || observation?.phase !== 'playing' || selected.size === 0;
        $('pass').disabled = !humanTurn || !observation?.canPass;
        $('create').disabled = busy || pending !== null || runtimeRunning || settingsSaving;
        $('next').disabled = busy || pending !== null || !observation
            || observation.phase !== 'finished' || runtimeRunning || settingsSaving;
        $('retry').hidden = pending === null;
        $('retry').disabled = busy;
        syncRevealButton();
    }

    function paint(result) {
        observation = result.observation;
        if (!settingsSaving) $('auto-pass').checked = observation.autoPass !== false;
        runtimeRunning = result.runtime.running === true;
        currentSeats = Array.isArray(result.seats) ? result.seats : [];
        activeSpectatorMatch = result.isSpectator === true
            || (currentSeats.length > 0 && currentSeats.every(seat => seat?.kind === 'agent'));
        $('spectator-banner').hidden = !activeSpectatorMatch;
        $('human-zone').hidden = activeSpectatorMatch;

        const key = JSON.stringify([
            observation.revision, result.runtime, result.seats,
            activeSpectatorMatch, revealHands, result.spectator,
        ]);
        if (key !== painted) {
            painted = key;
            selected = new Set([...selected].filter(card => observation.hand.includes(card)));

            $('seats').replaceChildren(...result.seats.map((seat, index) => {
                const node = document.createElement('div');
                node.className = 'seat' + (observation.turn === index ? ' active' : '');

                const head = document.createElement('div');
                head.className = 'seat-head';
                const nameSpan = document.createElement('span');
                nameSpan.className = 'seat-name';
                nameSpan.textContent = `${index + 1}号 · ${seat.name || `座位${index + 1}`}`;

                const badge = document.createElement('span');
                const isLandlord = observation.landlord === index;
                const decided = observation.landlord !== null && observation.landlord !== undefined;
                badge.className = 'role-badge' + (isLandlord ? ' landlord' : decided ? ' farmer' : '');
                badge.textContent = isLandlord ? '👑 地主' : decided ? '🌾 农民' : '🎲 待定';
                head.append(nameSpan, badge);
                node.append(head);

                const meta = document.createElement('div');
                meta.className = 'seat-meta';
                const chip = document.createElement('span');
                if (seat.kind === 'agent') {
                    const modelLabel = seat.model || seat.effectiveModel || '默认模型';
                    chip.className = 'model-chip' + (seat.model ? ' override' : '');
                    chip.textContent = `🧠 ${modelLabel}`;
                    chip.title = seat.model ? `本局指定模型：${seat.model}` : `角色默认模型：${modelLabel}`;
                } else {
                    chip.className = 'model-chip';
                    chip.textContent = '👤 人类本尊';
                }
                const remain = document.createElement('strong');
                remain.textContent = `剩 ${observation.remaining[index]} 张`;
                meta.append(chip, remain);

                if (observation.turn === index && observation.phase !== 'finished') {
                    const thinking = document.createElement('span');
                    thinking.className = 'thinking-tag';
                    thinking.textContent = result.runtime.status === 'requesting' ? '⚡ 思考出牌中…' : '👈 当前回合';
                    meta.append(thinking);
                }
                node.append(meta);

                if (activeSpectatorMatch) {
                    const handBox = document.createElement('div');
                    handBox.className = 'seat-hand';
                    const cards = result.spectator?.hands?.[index];
                    if (revealHands && Array.isArray(cards)) {
                        if (cards.length === 0) {
                            const empty = document.createElement('span');
                            empty.className = 'hidden-hand-hint';
                            empty.textContent = '✨ 已出完手牌！';
                            handBox.append(empty);
                        } else {
                            handBox.append(...cards.map(makeMiniCard));
                        }
                    } else {
                        const hiddenHint = document.createElement('span');
                        hiddenHint.className = 'hidden-hand-hint';
                        hiddenHint.textContent = `🂠 暗牌盲猜中（剩余 ${observation.remaining[index]} 张）`;
                        handBox.append(hiddenHint);
                    }
                    node.append(handBox);
                }
                return node;
            }));

            const targetNode = $('target');
            targetNode.replaceChildren();
            if (observation.phase === 'finished') {
                const landlordName = result.seats[observation.landlord]?.name || '地主';
                const winText = observation.winner === 'landlord'
                    ? `🏆 地主获胜！（${landlordName} 独赢全场）`
                    : `🏆 农民阵营联手获胜！（成功击败地主 ${landlordName}）`;
                targetNode.textContent = winText;
            } else if (observation.phase === 'bidding') {
                targetNode.textContent = `🎲 叫分抢地主阶段 · 当前最高 ${observation.highestBid} 分（第 ${observation.dealNumber} 次发牌）`;
            } else if (observation.target) {
                const caption = document.createElement('div');
                const ownerName = result.seats[observation.target.seat]?.name || `座位${observation.target.seat + 1}`;
                caption.textContent = `桌面有效牌（${ownerName}）：`;
                const row = document.createElement('div');
                row.className = 'target-cards';
                row.append(...observation.target.cards.map(makeMiniCard));
                targetNode.append(caption, row);
            } else {
                const turnName = result.seats[observation.turn]?.name || '当前座位';
                targetNode.textContent = `✨ 新一轮首出 · 轮到 ${turnName} 领出任意牌型`;
            }

            const bottomNode = $('bottom');
            bottomNode.replaceChildren();
            if (observation.bottom.length) {
                const prefix = document.createElement('span');
                prefix.textContent = '地主三张底牌：';
                bottomNode.append(prefix, ...observation.bottom.map(makeMiniCard));
            } else if (activeSpectatorMatch && revealHands && result.spectator?.bottom?.length) {
                const prefix = document.createElement('span');
                prefix.textContent = '底牌（上帝透视 · 叫分后归地主）：';
                bottomNode.append(prefix, ...result.spectator.bottom.map(makeMiniCard));
            } else {
                bottomNode.textContent = '底牌未揭示（3 张暗扣）';
            }

            const eventsBox = $('events');
            const wasNearBottom = eventsBox.scrollHeight - eventsBox.scrollTop - eventsBox.clientHeight < 60;
            eventsBox.replaceChildren(...observation.events.map(event => {
                const node = document.createElement('div');
                node.className = 'event';
                const name = result.seats[event.seat]?.name || '游戏系统';
                const summary = ({
                    bid: event.bid ? `叫 ${event.bid} 分` : '不叫',
                    pass: '不出',
                    play: `出牌 ${(event.cards || []).map(label).join(' ')}（剩 ${event.remaining} 张）`,
                    landlord: `成为地主（底牌 ${(event.bottom || []).map(label).join(' ')}）`,
                    redeal: `全员不叫，重新洗牌发牌（第 ${event.dealNumber} 副）`,
                    finished: `对局结束 · ${event.winner === 'landlord' ? '地主' : '农民'}获胜`,
                    'new-match': '新一局开始，保留原桌交流上下文',
                })[event.type] || event.type;
                node.append(document.createTextNode(`${event.id} · ${name}：${summary}`));
                if (event.speech) {
                    const quote = document.createElement('span');
                    quote.className = 'event-speech';
                    quote.textContent = `“${event.speech}”`;
                    node.append(quote);
                }
                if (event.emoteUrl) {
                    const image = document.createElement('img');
                    image.src = event.emoteUrl;
                    image.alt = '玩家表情';
                    image.referrerPolicy = 'no-referrer';
                    node.append(image);
                }
                return node;
            }));
            if (wasNearBottom) eventsBox.scrollTop = eventsBox.scrollHeight;

            const activeSeatName = Number.isInteger(result.runtime.seat)
                ? (result.seats[result.runtime.seat]?.name || `座位${result.runtime.seat + 1}`)
                : '';
            status(
                `模式：${activeSpectatorMatch ? '三AI斗蛐蛐观战' : '亲自参战'} · 阶段：${observation.phase} · 后台：${result.runtime.status}`
                + (activeSeatName ? `（正在邀请 ${activeSeatName}）` : '')
                + (result.runtime.reason ? ` [${result.runtime.reason}]` : '')
                + (result.runtime.status === 'paused' && observation.phase !== 'finished' ? ' · 可点上方「继续推进」接着打' : '')
            );
        }

        if (!activeSpectatorMatch) {
            $('hand').replaceChildren(...observation.hand.map(card => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `card${/^[HD]/.test(card) ? ' red' : ''}${selected.has(card) ? ' selected' : ''}`;
                button.textContent = label(card);
                button.disabled = busy || pending !== null || observation.turn !== 0;
                button.addEventListener('click', () => {
                    if (selected.has(card)) selected.delete(card); else selected.add(card);
                    button.classList.toggle('selected', selected.has(card));
                    controls();
                });
                return button;
            }));
        } else {
            $('hand').replaceChildren();
        }
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
            if (error.code) {
                pending = null;
                try { rememberPending(); } catch {}
            }
            status(error.message);
        } finally { busy = false; controls(); }
    }

    function submit(action) {
        if (activeSpectatorMatch || busy || pending || observation?.turn !== 0) return;
        pending = {
            matchId, decisionId: observation.decisionId, revision: observation.revision,
            submissionId: (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            action: { ...action, speech: $('speech').value, emoteUrl: $('emote').value.trim() },
        };
        void sendPending();
    }

    listen($('auto-pass'), async () => {
        if (!matchId || settingsSaving) return;
        const requestedMatch = matchId;
        const autoPass = $('auto-pass').checked;
        settingsSaving = true; controls();
        try {
            await call('updateGameSettings', { matchId: requestedMatch, autoPass });
            if (!disposed && matchId === requestedMatch) {
                status(autoPass ? '自动过牌已开启，下一次行动结算生效。' : '自动过牌已关闭，保留所有行动与聊天回合。');
            }
        } catch (error) {
            if (matchId === requestedMatch) $('auto-pass').checked = observation?.autoPass !== false;
            status(error.message);
        } finally {
            settingsSaving = false;
            controls();
            if (!disposed && matchId === requestedMatch) void refresh().catch(error => status(error.message));
        }
    }, 'change');
    listen($('mode-spectate'), () => { setupMode = 'spectate'; syncModeUI(); });
    listen($('mode-human'), () => { setupMode = 'human'; syncModeUI(); });
    listen($('toggle-reveal'), () => {
        revealHands = !revealHands;
        painted = '';
        syncRevealButton();
        if (matchId) void refresh().catch(error => status(error.message));
    });
    listen($('refresh-models'), async () => {
        try {
            status('正在刷新可用 AI 模型列表…');
            await loadCatalog(true);
            status(`模型列表已更新（共 ${catalog.models.length} 个候选模型）。`);
        } catch (error) { status(error.message); }
    });

    for (const key of ['zero', 'one', 'two']) {
        listen($(`agent-${key}`), () => populateModelSelect(key, true), 'change');
        listen($(`model-${key}`), () => {
            const customInput = $(`custom-model-${key}`);
            customInput.hidden = $(`model-${key}`).value !== CUSTOM_MODEL_VALUE;
            if (!customInput.hidden) {
                customInput.focus();
                if (customInput.value.trim()) void syncActiveMatchModels();
            } else {
                void syncActiveMatchModels();
            }
        }, 'change');
        listen($(`custom-model-${key}`), () => {
            if ($(`model-${key}`).value === CUSTOM_MODEL_VALUE && $(`custom-model-${key}`).value.trim()) {
                void syncActiveMatchModels();
            }
        }, 'change');
        listen($(`custom-model-${key}`), event => {
            if (event.key === 'Enter' && $(`model-${key}`).value === CUSTOM_MODEL_VALUE && $(`custom-model-${key}`).value.trim()) {
                event.preventDefault();
                void syncActiveMatchModels();
            }
        }, 'keydown');
    }

    listen($('create'), async () => {
        if (busy || pending || runtimeRunning) return;
        busy = true; controls();
        try {
            const spectate = setupMode === 'spectate';
            const { agentIds, agentModels } = collectSeatModelPayload(spectate);
            const result = await call('createGameTable', {
                mode: spectate ? 'spectate' : 'human',
                agentIds,
                agentModels,
                userName: $('user-name').value,
                autoPass: $('auto-pass').checked,
                contextMessageWindowSize: Number($('context-size').value),
            });
            matchId = result.matchId; painted = ''; selected.clear();
            activeSpectatorMatch = spectate;
            writeStore(SAVE, matchId);
            await refresh();
        } catch (error) { status(error.message); }
        finally { busy = false; controls(); }
    });

    listen($('next'), async () => {
        if (busy || pending || observation?.phase !== 'finished' || runtimeRunning) return;
        busy = true; controls();
        try {
            const payload = collectSeatModelPayload(setupMode === 'spectate');
            const table = await call('nextGameTable', { matchId, ...payload });
            matchId = table.matchId; painted = ''; selected.clear();
            $('speech').value = ''; $('emote').value = '';
            writeStore(SAVE, matchId);
            await refresh();
        } catch (error) { status(error.message); }
        finally { busy = false; controls(); }
    });

    listen($('resume'), async () => {
        if (busy || pending) return;
        try {
            const saved = readStore(SAVE);
            if (!saved) throw new Error('没有上次牌桌记录。');
            const storedPending = readStore(PENDING_SAVE);
            const restored = storedPending ? JSON.parse(storedPending) : null;
            pending = restored?.matchId === saved ? restored : null;
            matchId = saved; painted = '';
            const result = await call('observeGameTable', { matchId: saved });
            if (!disposed && matchId === saved) {
                syncControlsFromSeats(result.seats);
                paint(result);
            }
        } catch (error) { status(error.message); }
    });

    listen($('continue'), async () => {
        try {
            if (!matchId) return;
            const extra = uiMatchesCurrentRoster() ? collectSeatModelPayload(activeSpectatorMatch) : {};
            await call('continueGameTable', { matchId, ...extra });
            await refresh();
        } catch (error) { status(error.message); }
    });

    listen($('stop'), async () => {
        try { if (matchId) { await call('stopGameTable', { matchId }); await refresh(); } }
        catch (error) { status(error.message); }
    });

    document.querySelectorAll('[data-bid]').forEach(button => listen(button, () => submit({ type: 'bid', bid: Number(button.dataset.bid) })));
    listen($('play'), () => submit({ type: 'play', cards: [...selected] }));
    listen($('pass'), () => submit({ type: 'pass' }));
    listen($('clear'), () => { selected.clear(); painted = ''; void refresh().catch(error => status(error.message)); });
    listen($('retry'), () => { if (pending && !busy) void sendPending(); });

    syncModeUI();
    loadCatalog(false).then(() => {
        status('就绪：已预选三位 AI，可为每个席位单独指定模型后点击「开新桌」观战。');
        controls();
    }).catch(error => status(error.message));

    void poll();
    window.addEventListener('pagehide', () => {
        disposed = true; clearTimeout(timer); scope.abort();
    }, { once: true });
})();