/* ForgeTax rules v1. Local prototype; no trusted identity or remote leaderboard. */
(function (root) {
    'use strict';
    const VERSION = 1;
    const clone = value => JSON.parse(JSON.stringify(value));
    const RELICS = [
        ['start', '起手式', 1, '新剑第一锤额外获得2格专注。'],
        ['rhythm', '双拍节奏', 1, '连续两次维持后，下一普通锤必定成功。'],
        ['goggles', '护目镜', 1, '损坏权重降低20%。'],
        ['cloth', '打磨布', 1, '每次实际损坏的价值损失减半。'],
        ['tongs', '稳固钳', 1, '损坏判定的裂痕增量降低35%。'],
        ['notes', '学徒笔记', 1, '强化等级低于5时，成功增值提高30%。'],
        ['bellows', '旧风箱', 1, '强化等级低于5时，成功权重提高25%。'],
        ['wax', '交货封蜡', 1, '上贡额外支付5%现金，不计入达标价值。'],
        ['scrap', '清仓木牌', 1, '强化等级不超过+5的非残剑，上贡价值提高30%。'],
        ['magnet', '拾荒磁铁', 1, '每次实际破碎获得破碎前价值15%的现金，最低100；不计收入。'],
        ['salvage', '残刃契约', 2, '实际破碎留下33%价值残剑，不可强化或换遗物。'],
        ['quench', '冷淬水槽', 2, '大成功减少1层裂痕，不清除强化风险。'],
        ['spark', '游走火星', 2, '普通锤有25%概率额外获得1格专注。'],
        ['warm', '余温锤柄', 2, '专注结束保留2格专注。'],
        ['compass', '分岔罗盘', 2, '成功时进化机会翻倍。'],
        ['gloves', '赌徒手套', 2, '大成功权重×1.8，破碎权重×1.5。'],
        ['anvil', '细工砧', 2, '普通成功增值×1.5，大成功增值×0.8。'],
        ['loss', '以损换势', 2, '损坏判定后，下一成功增值×1.8，不叠加。'],
        ['tax', '税务夹页', 2, '上贡达到目标150%时获得一枚保护石。'],
        ['ember', '不灭余烬', 3, '每日首次破碎判定改为损坏。'],
        ['chain', '星火连锤', 3, '专注奖励由5锤增加至7锤。'],
        ['seal', '魔王御印', 3, '上贡首把剑按120%计入目标，支付金额不变。'],
        ['twin', '双生剑胚', 3, '每天额外领取一把铁剑。'],
        ['crit', '终极赌徒', 3, '大成功本次增值×4；裂痕增量×1.8、破碎权重×1.8。'],
        ['brace', '镇裂铁箍', 1, '破碎权重降低25%，大成功增值降低10%。'],
        ['patience', '耐心刻刀', 1, '维持后下一次成功增值×1.4；不叠加。'],
        ['focusGain', '心流砧台', 2, '专注安全锤的成功增值×1.6。'],
        ['damageFocus', '逆境呼吸', 2, '普通锤损坏判定额外获得2格专注；被保护挡下也触发。'],
        ['highRoll', '血契红锤', 2, '大成功增值×2，普通成功增值×0.8，破碎权重×1.3。'],
        ['allIn', '孤注一掷', 3, '背包仅剩一把可强化剑时，成功增值×2，破碎权重×1.5。']
    ].map(([id, name, rarity, description]) => ({ id, name, rarity, description, cost: rarity }));
    const TYPES = {
        iron: { name: '铁剑', gain: 1, success: 1, critical: 1, risk: 1 },
        knight: { name: '骑士剑', gain: 1.15, success: 1.15, critical: 0.9, risk: 0.85 },
        rapier: { name: '迅捷细剑', gain: 0.85, success: 1.55, critical: 0.8, risk: 0.9 },
        heavy: { name: '巨刃', gain: 1.8, success: 0.7, critical: 1.1, risk: 1.15 },
        ritual: { name: '仪式剑', gain: 1.25, success: 0.85, critical: 1.2, risk: 1 },
        berserk: { name: '狂战剑', gain: 1.5, success: 1, critical: 1.5, risk: 1.25 },
        crystal: { name: '晶铸剑', gain: 1.35, success: 0.9, critical: 2, risk: 1.4 }
    };
    const ITEMS = [
        { id: 'iron', name: '铁剑', base: 300, description: '立即获得一把价值100的基础铁剑。' },
        { id: 'watch', name: '后悔怀表', base: 900, description: '撤销最近操作末尾的损坏/破碎；继续操作后窗口关闭。重敲不会重抽命运。' },
        { id: 'protect', name: '强化保护石', base: 500, description: '当前剑下一普通锤不发生实际破碎/损坏，风险仍累积。' },
        { id: 'bless', name: '祝福石', base: 400, description: '当前剑下一普通锤成功、大成功权重翻倍。' },
        { id: 'trade', name: '交易卷', base: 700, description: '下一天额外领取两把铁剑。' }
    ];
    const money = n => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(n)));
    class Engine {
        constructor(options = {}) {
            if (options.save) {
                const s = options.save;
                if (s.version !== VERSION || !Array.isArray(s.swords) || !Array.isArray(s.relics)
                    || s.relics.length > 8 || !Number.isFinite(s.cash) || !Number.isInteger(s.rng)
                    || !Number.isInteger(s.day) || s.day < 1 || !['playing', 'dead', 'victory'].includes(s.status)) {
                    throw new Error('存档格式或版本不兼容');
                }
                this.s = clone(s);
            } else {
                const seed = (options.seed ?? Date.now()) >>> 0;
                this.s = {
                    version: VERSION, runId: `ft-${Date.now()}-${seed}`, player: String(options.player || '莱恩').slice(0, 32),
                    seed, rng: seed || 1, revision: 0, day: 1, misses: 0, status: 'playing',
                    cash: 0, income: 0, maxSword: 100, nextId: 1, swords: [], relics: [],
                    items: { watch: 0, protect: 0, bless: 0, trade: 0 }, pendingIron: 0,
                    shops: { relics: [], items: [] }, daily: { ember: false, magnet: false }, undo: null
                };
                this.enterDay();
            }
            this.events = [];
        }
        random() {
            let x = this.s.rng;
            x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
            this.s.rng = x >>> 0;
            return this.s.rng / 4294967296;
        }
        has(id) { return this.s.relics.includes(id); }
        emit(type, data = {}) { this.events.push({ type, ...data }); }
        target(day = this.s.day) { return money(400 * Math.pow(1.58, day - 1)); }
        addSword(value = 100, broken = false) {
            const sword = {
                id: `s${this.s.nextId++}`, type: 'iron', level: 0, value, broken,
                cracks: 0, pressure: 0, focus: 0, hits: 0, maintains: 0, successes: 0,
                momentum: 0, surge: false, cloth: false, protection: false, blessing: false, evolutions: 0
            };
            this.s.swords.push(sword);
            return sword;
        }
        enterDay() {
            this.s.daily = { ember: false, magnet: false };
            const count = 3 + this.s.pendingIron + (this.has('twin') ? 1 : 0);
            this.s.pendingIron = 0;
            for (let i = 0; i < count; i++) this.addSword();
            const pool = RELICS.filter(relic => !this.has(relic.id));
            this.s.shops.relics = [];
            for (let i = 0; i < 3; i++) {
                const index = Math.floor(this.random() * pool.length);
                this.s.shops.relics.push({ id: pool.splice(index, 1)[0].id, sold: false });
            }
            if ((this.s.day - 1) % 3 === 0) {
                this.s.shops.items = ITEMS.map(item => ({
                    id: item.id, bought: 0, base: money(item.base * Math.pow(1.22, this.s.day - 1))
                }));
            }
        }
        probabilities(sword) {
            const t = TYPES[sword.type];
            const risk = (sword.cracks * 4.5 + sword.pressure * 1.1) * t.risk;
            const w = [
                risk * (this.has('gloves') ? 1.5 : 1) * (this.has('crit') ? 1.8 : 1)
                    * (this.has('brace') ? 0.75 : 1) * (this.has('highRoll') ? 1.3 : 1)
                    * (this.has('allIn') && this.s.swords.filter(s => !s.broken).length === 1 ? 1.5 : 1),
                (14 + sword.level * 0.24 + sword.cracks * 0.3) * (this.has('goggles') ? 0.8 : 1),
                Math.max(8, 29 - sword.momentum * 2),
                47 * t.success * (sword.level < 5 && this.has('bellows') ? 1.25 : 1),
                10 * t.critical * (this.has('gloves') ? 1.8 : 1)
            ];
            if (sword.blessing) { w[3] *= 2; w[4] *= 2; }
            const sum = w.reduce((a, b) => a + b, 0);
            return w.map(n => n / sum);
        }
        roll(sword) {
            const p = this.probabilities(sword);
            let r = this.random();
            for (let i = 0; i < p.length; i++) { r -= p[i]; if (r < 0) return i; }
            return 4;
        }
        hit(id, safe = false) {
            const sword = this.s.swords.find(s => s.id === id);
            if (!sword || sword.broken) return false;
            const before = clone(this.s); before.undo = null;
            let result = this.roll(sword);
            if (!safe && this.has('rhythm') && sword.maintains >= 2) result = 3;
            const protectedHit = safe || sword.protection;
            if (!safe) { sword.protection = false; sword.blessing = false; }
            if (result === 0 && !protectedHit && this.has('ember') && !this.s.daily.ember) {
                this.s.daily.ember = true; result = 1;
                this.emit('relic', { id: 'ember', message: '不灭余烬：破碎改为损坏' });
            }
            sword.hits++;
            sword.pressure += 0.5 + sword.level * 0.04;
            if (result === 0 || result === 1) {
                sword.cracks += (this.has('tongs') ? 0.65 : 1) * (this.has('crit') ? 1.8 : 1);
                sword.momentum = Math.max(-3, sword.momentum - 1);
                sword.maintains = 0;
                if (this.has('loss')) sword.surge = true;
            }
            const oldValue = sword.value;
            if (result === 0 && !protectedHit) {
                this.s.swords = this.s.swords.filter(s => s.id !== id);
                if (this.has('salvage')) this.addSword(money(oldValue * 0.33), true);
                if (this.has('magnet')) {
                    const recovered = Math.max(100, money(oldValue * 0.15));
                    this.s.cash = money(this.s.cash + recovered);
                    this.emit('relic', { id: 'magnet', message: `拾荒磁铁回收现金 ${recovered}` });
                }
            } else if (result === 1 && !protectedHit) {
                const fraction = this.has('cloth') ? 0.1 : 0.2;
                sword.value = money(sword.value * (1 - fraction)); sword.cloth = true;
            } else if (result === 2) {
                sword.maintains++;
                if (this.has('patience')) sword.patience = true;
                sword.momentum = Math.min(4, sword.momentum + 0.5);
            } else if (result >= 3) {
                const critical = result === 4;
                let gain = (80 + sword.value * (critical ? 0.48 : 0.20) + sword.level * 22) * TYPES[sword.type].gain;
                if (sword.level < 5 && this.has('notes')) gain *= 1.3;
                if (this.has('anvil')) gain *= critical ? 0.8 : 1.5;
                if (critical && this.has('crit')) gain *= 4;
                if (critical && this.has('brace')) gain *= 0.9;
                if (this.has('highRoll')) gain *= critical ? 2 : 0.8;
                if (safe && this.has('focusGain')) gain *= 1.6;
                if (sword.patience && this.has('patience')) gain *= 1.4;
                sword.patience = false;
                if (this.has('allIn') && this.s.swords.filter(s => !s.broken).length === 1) gain *= 2;
                if (sword.surge) { gain *= 1.8; sword.surge = false; }
                sword.value = money(sword.value + gain);
                sword.level = Math.min(99, sword.level + (critical ? 2 : 1));
                sword.successes++; sword.maintains = 0;
                sword.momentum = Math.min(4, sword.momentum + 1);
                if (critical && this.has('quench')) sword.cracks = Math.max(0, sword.cracks - 1);
                if (sword.evolutions < 2 && this.random() < (this.has('compass') ? 0.14 : 0.07)) {
                    const types = Object.keys(TYPES).filter(type => type !== 'iron' && type !== sword.type);
                    sword.type = types[Math.floor(this.random() * types.length)]; sword.evolutions++;
                    sword.value = money(sword.value * 1.2);
                    this.emit('evolution', { swordId: id, name: TYPES[sword.type].name });
                }
                this.s.maxSword = Math.max(this.s.maxSword, sword.value);
            }
            const alive = this.s.swords.some(s => s.id === id);
            this.emit('hammer', {
                swordId: id, result: ['break', 'damage', 'maintain', 'success', 'critical'][result],
                safe, blocked: result < 2 && protectedHit, before: oldValue,
                after: alive ? sword.value : 0, level: sword.level, focus: sword.focus
            });
            if (result < 2 && !protectedHit) this.s.undo = { snapshot: before, swordId: id };
            else this.s.undo = null;
            if (!alive) return false;
            if (!safe) {
                sword.focus += 1;
                if (result === 1 && this.has('damageFocus')) sword.focus += 2;
                if (sword.hits === 1 && this.has('start')) sword.focus += 2;
                if (this.has('spark') && this.random() < 0.25) {
                    sword.focus++; this.emit('relic', { id: 'spark', message: '游走火星：额外1格专注' });
                }
                if (sword.focus >= 10) {
                    sword.focus = 0; this.s.undo = null;
                    const count = this.has('chain') ? 7 : 5;
                    this.emit('focus', { swordId: id, count });
                    for (let i = 0; i < count; i++) this.hit(id, true);
                    sword.focus = this.has('warm') ? 2 : 0;
                }
            }
            return true;
        }
        getState() {
            const state = clone(this.s);
            delete state.undo;
            state.canUndo = Boolean(this.s.undo && this.s.items.watch > 0);
            state.target = this.target(); state.nextTarget = this.target(this.s.day + 1);
            state.lives = 2 - state.misses;
            state.relicSlots = 8;
            state.swords = state.swords.map(s => ({
                ...s, name: s.broken ? '损坏残剑' : s.level === 99 ? `${TYPES[s.type].name}·圣剑` : TYPES[s.type].name,
                probabilities: s.broken ? null : this.probabilities(s)
            }));
            state.relics = state.relics.map(id => clone(RELICS.find(r => r.id === id)));
            state.shops.relics = state.shops.relics.map(slot => ({
                ...clone(RELICS.find(r => r.id === slot.id)), sold: slot.sold, owned: this.has(slot.id)
            }));
            state.shops.items = state.shops.items.map(slot => ({
                ...clone(ITEMS.find(i => i.id === slot.id)), bought: slot.bought, price: money(slot.base * 2 ** slot.bought)
            }));
            state.shopRefreshIn = 3 - ((state.day - 1) % 3);
            return state;
        }
        exportSave() { return clone(this.s); }
        require(condition, message) { if (!condition) throw new Error(message); }
        dispatch(action) {
            const backup = this.exportSave();
            this.events = [];
            try {
                this.require(action && typeof action.type === 'string', '动作格式无效');
                this.require(this.s.status === 'playing', '本局已经结束');
                if (action.revision !== undefined) this.require(action.revision === this.s.revision, '状态已变化，请重新查询');
                if (action.type === 'watch') {
                    this.require(this.s.undo && this.s.items.watch > 0, '没有可回退的失败或怀表不足');
                    const remaining = this.s.items.watch - 1;
                    this.s = clone(this.s.undo.snapshot);
                    this.s.items.watch = remaining; this.s.undo = null;
                    this.emit('undo', { message: '失败已撤销；随机状态同步回退，命运不会免费重抽。' });
                } else {
                    this.s.undo = null;
                    if (action.type === 'hammer') {
                        this.require([1, 3, 5, 10].includes(action.count), '锤数只能为1、3、5、10');
                        this.require(this.s.swords.some(s => s.id === action.swordId && !s.broken), '剑不存在或无法强化');
                        for (let i = 0; i < action.count; i++) if (!this.hit(action.swordId)) break;
                    } else if (action.type === 'use') {
                        this.require(['protect', 'bless', 'trade'].includes(action.itemId), '未知道具');
                        this.require(this.s.items[action.itemId] > 0, '道具数量不足');
                        if (action.itemId === 'trade') this.s.pendingIron += 2;
                        else {
                            const sword = this.s.swords.find(s => s.id === action.swordId && !s.broken);
                            this.require(sword, '请选择可强化的剑');
                            const key = action.itemId === 'protect' ? 'protection' : 'blessing';
                            this.require(!sword[key], '该剑已经拥有相同待生效效果'); sword[key] = true;
                        }
                        this.s.items[action.itemId]--;
                        this.emit('item', { itemId: action.itemId, message: '道具已使用' });
                    } else if (action.type === 'buyItem') {
                        const slot = this.s.shops.items.find(i => i.id === action.itemId);
                        this.require(slot && slot.bought < 3, '商品不存在或本轮已售罄');
                        const price = money(slot.base * 2 ** slot.bought);
                        this.require(this.s.cash >= price, '现金不足');
                        this.s.cash -= price; slot.bought++;
                        if (slot.id === 'iron') this.addSword(); else this.s.items[slot.id]++;
                        this.emit('purchase', { itemId: slot.id, price });
                    } else if (action.type === 'buyRelic') {
                        const slot = this.s.shops.relics.find(r => r.id === action.relicId);
                        this.require(slot && !slot.sold && !this.has(slot.id), '遗物已售出或已经持有');
                        const relic = RELICS.find(r => r.id === slot.id);
                        const ids = action.swordIds;
                        this.require(Array.isArray(ids) && new Set(ids).size === ids.length && ids.length === relic.cost, '兑换铁剑数量不正确');
                        this.require(ids.every(id => this.s.swords.some(s => s.id === id && !s.broken && s.type === 'iron' && s.level === 0 && s.hits === 0)), '只能用从未锻造的基础铁剑兑换');
                        if (this.s.relics.length === 8) {
                            this.require(this.s.relics.includes(action.replaceId), '八槽已满，请选择替换遗物');
                            this.s.relics = this.s.relics.filter(id => id !== action.replaceId);
                        }
                        this.s.swords = this.s.swords.filter(s => !ids.includes(s.id));
                        this.s.relics.push(slot.id); slot.sold = true;
                        this.emit('relicPurchase', { relicId: slot.id, replaced: action.replaceId || null });
                    } else if (action.type === 'tribute') {
                        const ids = action.swordIds;
                        this.require(Array.isArray(ids) && new Set(ids).size === ids.length, '上贡剑列表无效');
                        this.require(ids.every(id => this.s.swords.some(s => s.id === id)), '上贡剑不存在');
                        const selected = ids.map(id => this.s.swords.find(s => s.id === id));
                        const total = money(selected.reduce((sum, s) => sum + this.saleValue(s), 0));
                        const credited = money(total + (this.has('seal') && selected.length ? this.saleValue(selected[0]) * 0.2 : 0));
                        const paid = money(total * (this.has('wax') ? 1.05 : 1));
                        const passed = credited >= this.target();
                        this.s.cash = money(this.s.cash + paid); this.s.income = money(this.s.income + paid);
                        this.s.swords = this.s.swords.filter(s => !ids.includes(s.id));
                        if (!passed) this.s.misses++;
                        if (this.has('tax') && credited >= this.target() * 1.5) this.s.items.protect++;
                        this.emit('tribute', { day: this.s.day, target: this.target(), credited, paid, passed });
                        if (this.s.misses >= 2) {
                            this.s.status = 'dead'; this.emit('end', { ending: '魔王处决' });
                        } else { this.s.day++; this.enterDay(); this.emit('day', { day: this.s.day }); }
                    } else if (action.type === 'slay') {
                        this.require(this.s.swords.some(s => !s.broken && s.level === 99), '需要背包中的+99圣剑');
                        this.s.status = 'victory'; this.emit('end', { ending: '弑王·真结局' });
                    } else throw new Error('未知动作');
                }
                this.s.revision = backup.revision + 1;
                return { ok: true, events: clone(this.events), state: this.getState() };
            } catch (error) {
                this.s = backup; this.events = [];
                return { ok: false, error: error.message, events: [], state: this.getState() };
            }
        }
        saleValue(sword) {
            return money(sword.value * (this.has('scrap') && !sword.broken && sword.level <= 5 ? 1.3 : 1));
        }
    }
    const exported = { Engine, RELICS, TYPES, ITEMS, VERSION };
    if (typeof module === 'object' && module.exports) module.exports = exported;
    else root.ForgeTax = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this);