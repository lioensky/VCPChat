'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, RELICS } = require('../Gamemodules/forge-tax/engine');
const make = () => new Engine({ seed: 12345, player: '测试铁匠' });
test('完整状态隔离，30件遗物，初始三剑与零破碎率', () => {
    const e = make(), s = e.getState();
    assert.equal(RELICS.length, 30);
    assert.equal(s.swords.length, 3);
    assert.equal(s.shops.relics.length, 3);
    assert.equal(s.shops.items.length, 5);
    assert.equal(s.relicSlots, 8);
    assert.equal(s.swords[0].probabilities[0], 0);
    s.swords[0].value = 999;
    assert.equal(e.s.swords[0].value, 100);
});
test('相同存档和动作得到相同事件与状态', () => {
    const a = make(), b = new Engine({ save: a.exportSave() });
    const action = { type: 'hammer', swordId: 's1', count: 10 };
    assert.deepEqual(a.dispatch(action), b.dispatch(action));
});
test('专注追加五锤，负面判定保留风险但不会损伤或再次充能', () => {
    const e = make();
    e.roll = () => 1;
    const sw = e.s.swords[0]; sw.focus = 9; sw.protection = true;
    const result = e.dispatch({ type: 'hammer', swordId: sw.id, count: 1 });
    assert.equal(result.events.filter(x => x.type === 'hammer').length, 6);
    assert.equal(sw.value, 100);
    assert.equal(sw.cracks, 6);
    assert.ok(sw.pressure > 0);
    assert.equal(sw.focus, 0);
    assert.ok(result.events.filter(x => x.type === 'hammer').every(x => x.blocked));
});
test('破碎停止批量，不产生专注，残剑不可强化', () => {
    const e = make(); e.roll = () => 0; e.s.relics = ['salvage'];
    e.s.swords[0].focus = 9;
    const r = e.dispatch({ type: 'hammer', swordId: 's1', count: 10 });
    assert.equal(r.events.filter(x => x.type === 'hammer').length, 1);
    assert.equal(r.events.filter(x => x.type === 'focus').length, 0);
    const remnant = e.s.swords.find(x => x.broken);
    assert.equal(remnant.value, 33);
    assert.equal(e.dispatch({ type: 'hammer', swordId: remnant.id, count: 1 }).ok, false);
});
test('怀表原子回退破碎附带收益，扣一枚且revision单调', () => {
    const e = make(); e.roll = () => 0;
    e.s.items.watch = 1; e.s.relics = ['salvage', 'magnet'];
    e.dispatch({ type: 'hammer', swordId: 's1', count: 1 });
    assert.equal(e.s.cash, 100);
    assert.equal(e.dispatch({ type: 'watch' }).ok, true);
    assert.equal(e.s.cash, 0);
    assert.equal(e.s.swords.length, 3);
    assert.equal(e.s.swords[0].id, 's1');
    assert.equal(e.s.items.watch, 0);
    assert.equal(e.s.revision, 2);
});
test('无效操作完整回滚，过期revision拒绝', () => {
    const e = make(), before = e.exportSave();
    assert.equal(e.dispatch({ type: 'buyItem', itemId: 'watch' }).ok, false);
    assert.deepEqual(e.exportSave(), before);
    assert.equal(e.dispatch({ type: 'hammer', swordId: 's1', count: 1, revision: 999 }).ok, false);
});
test('满八槽必须替换，取消和错误兑换不扣材料', () => {
    const e = make(); e.s.relics = RELICS.slice(0, 8).map(x => x.id);
    e.s.shops.relics = [{ id: 'salvage', sold: false }];
    const before = e.exportSave();
    const action = { type: 'buyRelic', relicId: 'salvage', swordIds: ['s1', 's2'] };
    assert.equal(e.dispatch(action).ok, false);
    assert.deepEqual(e.exportSave(), before);
    assert.equal(e.dispatch({ ...action, replaceId: 'start' }).ok, true);
    assert.equal(e.s.relics.length, 8);
    assert.equal(e.s.swords.length, 1);
    assert.equal(e.has('start'), false);
});
test('道具1/2/4倍、每轮最多三件、第4天刷新', () => {
    const e = make(); e.s.cash = 100000;
    const base = e.s.shops.items.find(x => x.id === 'iron').base;
    const start = e.s.cash;
    for (let i = 0; i < 3; i++) assert.equal(e.dispatch({ type: 'buyItem', itemId: 'iron' }).ok, true);
    assert.equal(start - e.s.cash, base * 7);
    assert.equal(e.dispatch({ type: 'buyItem', itemId: 'iron' }).ok, false);
    e.s.day = 4; e.enterDay();
    assert.equal(e.s.shops.items.find(x => x.id === 'iron').bought, 0);
});
test('现金不能补贡金，失败累计不被成功清除，未上贡剑保留', () => {
    const e = make(); e.s.cash = 1000000;
    e.dispatch({ type: 'tribute', swordIds: [] });
    assert.equal(e.s.misses, 1);
    assert.equal(e.s.swords.length, 6);
    e.s.swords[0].value = 5000;
    const r = e.dispatch({ type: 'tribute', swordIds: ['s1'] });
    assert.equal(r.events.find(x => x.type === 'tribute').paid, 5000);
    assert.equal(e.s.income, 5000);
    assert.equal(e.s.misses, 1);
    assert.ok(e.s.swords.some(x => x.id === 's2'));
    e.dispatch({ type: 'tribute', swordIds: [] });
    assert.equal(e.s.status, 'dead');
    assert.equal(e.s.day, 3);
});
test('交易卷下一天领取，+99圣剑可主动真结局，结束禁止操作', () => {
    const e = make(); e.s.items.trade = 1;
    e.dispatch({ type: 'use', itemId: 'trade' });
    e.dispatch({ type: 'tribute', swordIds: [] });
    assert.equal(e.s.swords.length, 8);
    e.s.swords[0].level = 99;
    assert.equal(e.dispatch({ type: 'slay' }).ok, true);
    assert.equal(e.s.status, 'victory');
    assert.equal(e.dispatch({ type: 'hammer', swordId: 's1', count: 1 }).ok, false);
});
test('圣剑最多99级，超级成功仅将本次增值乘四', () => {
    const e = make(); e.roll = () => 4; e.random = () => 0.99;
    const sw = e.s.swords[0]; sw.level = 98;
    e.s.relics = ['crit'];
    e.dispatch({ type: 'hammer', swordId: sw.id, count: 1 });
    assert.equal(sw.level, 99);
    assert.equal(sw.value, Math.round(100 + (80 + 100 * .48 + 98 * 22) * 4));
});
test('折中风险：初始零破碎，首次损坏后约5%，持续敲打继续升高', () => {
    const e = make(), sw = e.s.swords[0];
    assert.equal(e.probabilities(sw)[0], 0);
    e.roll = () => 1;
    e.dispatch({ type: 'hammer', swordId: sw.id, count: 1 });
    const damaged = e.probabilities(sw)[0];
    assert.ok(damaged > .045 && damaged < .055);
    e.roll = () => 2;
    e.dispatch({ type: 'hammer', swordId: sw.id, count: 5 });
    assert.ok(e.probabilities(sw)[0] > damaged);
});
test('刷新排除已持有遗物且当日三件不重复；消耗品仍出售', () => {
    const e = make(); e.s.relics = RELICS.slice(0, 8).map(r => r.id);
    for (let i = 0; i < 20; i++) {
        e.s.day++; e.enterDay();
        const ids = e.s.shops.relics.map(r => r.id);
        assert.equal(new Set(ids).size, 3);
        assert.ok(ids.every(id => !e.has(id)));
    }
    e.s.items.protect = 5;
    e.s.day = 4; e.enterDay();
    assert.ok(e.s.shops.items.some(i => i.id === 'protect'));
});
test('打磨布每次减损、拾荒每次按价值回收且不计收入', () => {
    const e = make(); e.s.relics = ['cloth', 'magnet'];
    e.roll = () => 1; e.s.swords[0].value = 1000;
    e.dispatch({ type: 'hammer', swordId: 's1', count: 3 });
    assert.equal(e.s.swords[0].value, 729);
    e.roll = () => 0;
    e.dispatch({ type: 'hammer', swordId: 's1', count: 1 });
    assert.equal(e.s.cash, 109);
    e.dispatch({ type: 'hammer', swordId: 's2', count: 1 });
    assert.equal(e.s.cash, 209); assert.equal(e.s.income, 0);
});
test('清仓强化剑增值且残剑不加成；逆境呼吸保护损坏也充能', () => {
    const e = make(); e.s.relics = ['scrap', 'damageFocus'];
    const sw = e.s.swords[0]; sw.level = 5;
    assert.equal(e.saleValue(sw), 130);
    assert.equal(e.saleValue({ ...sw, broken: true }), 100);
    e.roll = () => 1; sw.protection = true;
    e.dispatch({ type: 'hammer', swordId: sw.id, count: 1 });
    assert.equal(sw.focus, 3); assert.equal(sw.value, 100);
});
test('心流砧台安全成功增值；耐心刻刀仅消费一次；孤注风险和收益', () => {
    const e = make(); e.s.relics = ['focusGain', 'patience', 'allIn'];
    e.s.swords = [e.s.swords[0]]; e.random = () => .99; e.roll = () => 3;
    const sw = e.s.swords[0]; sw.patience = true; sw.cracks = 1;
    const risky = e.probabilities(sw)[0];
    e.s.relics = ['focusGain', 'patience'];
    assert.ok(e.probabilities(sw)[0] < risky);
    e.s.relics.push('allIn');
    e.hit(sw.id, true);
    assert.equal(sw.value, Math.round(100 + 100 * 1.6 * 1.4 * 2));
    assert.equal(sw.patience, false);
});