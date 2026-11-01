// 资料卡页：管理资料卡、绑定到角色卡 / 群组、写入角色卡分享
import { h, add, clear, toast, button, select, field, textInput, textArea, checkbox } from './dom.js';
import { makeProfile, sampleProfile, PROFILE_KEYS } from '../defaults.js';
import {
    PROFILE_FORMAT, profilePayload, profilesFromPayload, addProfiles, getProfile, boundOwners, removeProfile, profileStats,
} from '../profiles.js';
import * as ST from '../st.js';
import { downloadJson, pickJson, today } from './files.js';

/** 比较两张资料卡的内容（忽略 id 与时间） */
function sameContent(a, b) {
    const pick = p => JSON.stringify([p.name, p.desc, ...PROFILE_KEYS.map(k => p[k])]);
    return pick(a) === pick(b);
}

export function renderProfilesTab(app, root) {
    clear(root);
    add(root, ownerSection(app), listSection(app));
}

// ---------------------------------------------------------------- 当前聊天的绑定

function ownerSection(app) {
    const s = app.settings;
    const owner = ST.currentOwner();
    const box = h('div.tsrpg-owner');
    if (!owner) {
        return add(box, h('div.tsrpg-section-title', '当前聊天'), h('div.tsrpg-muted', '打开一个角色或群组聊天后，可以把资料卡绑定到它。'));
    }
    const bound = s.bindings[owner.key] || '';
    const sel = select([['', '不绑定（停用战棋，不影响聊天）'], ...s.profiles.map(p => [p.id, p.name])], bound, v => {
        if (v) s.bindings[owner.key] = v;
        else delete s.bindings[owner.key];
        app.save();
        app.syncProfileWithChat().then(() => app.render());
    });
    add(box,
        h('div.tsrpg-section-title', h('i', { class: `fa-solid ${owner.kind === 'group' ? 'fa-users' : 'fa-user'}` }), ` 当前聊天：${owner.name}`),
        field(`${owner.kind === 'group' ? '这个群组' : '这个角色'}使用的资料卡`, sel, '打开这个聊天时自动切换到绑定的资料卡'),
    );
    if (owner.kind === 'char') add(box, cardSection(app, owner));
    return box;
}

/** 把资料卡写进角色卡（随角色卡 PNG 一起分享） */
function cardSection(app, owner) {
    const s = app.settings;
    const embedded = ST.readCardExtension(owner.character);
    const emb = embedded?.format === PROFILE_FORMAT ? embedded.profile : null;
    const p = app.data;
    const rows = [];
    const local = emb ? getProfile(s, emb.id) : null;
    const inSync = !!local && sameContent(local, emb);
    if (emb) {
        const status = !local ? '本地没有这张资料卡' : sameContent(local, emb) ? '与本地一致' : '与本地版本不同';
        rows.push(h('div.tsrpg-muted', h('i.fa-solid.fa-id-card'), ` 角色卡内附带资料卡「${emb.name}」（${profileStats({ units: emb.units || [], maps: emb.maps || [], terrains: emb.terrains || [] })}）— ${status}`));
    } else {
        rows.push(h('div.tsrpg-muted', '角色卡内没有附带资料卡。'));
    }
    const write = async () => {
        if (emb && emb.id !== p.id && !confirm(`角色卡里已经有资料卡「${emb.name}」，要用「${p.name}」替换吗？`)) return;
        try {
            p.updatedAt = Date.now();
            await ST.writeCardExtension(owner.characterId, profilePayload(p));
            s.bindings[owner.key] = p.id;
            app.save();
            await app.syncProfileWithChat();
            toast('success', `已把资料卡「${p.name}」写入 ${owner.name} 的角色卡，并绑定到这个角色。导出角色卡时会一起带上。`);
            app.render();
        } catch (err) {
            toast('error', `写入失败：${err.message || err}`);
        }
    };
    const importFromCard = () => {
        const replace = !!local && confirm(`本地已有「${local.name}」。点击“确定”用角色卡里的版本覆盖；点击“取消”作为副本导入。`);
        const [added] = addProfiles(s, [emb], { replace, normalize: ST.normalizeProfile });
        s.bindings[owner.key] = added.id;
        app.save();
        app.switchProfile(added.id, { quiet: true });
        app.syncProfileWithChat();
        toast('success', `已导入资料卡「${added.name}」`);
        app.render();
    };
    const removeFromCard = async () => {
        if (!confirm(`从 ${owner.name} 的角色卡中移除附带的资料卡？（本地资料卡和绑定不受影响）`)) return;
        try {
            await ST.writeCardExtension(owner.characterId, null);
            toast('success', '已从角色卡移除');
            app.render();
        } catch (err) {
            toast('error', `移除失败：${err.message || err}`);
        }
    };
    return h('div',
        rows,
        h('div.tsrpg-row',
            button(emb && emb.id === p.id ? `更新角色卡中的「${p.name}」` : `把「${p.name}」写入角色卡`, write, { icon: 'fa-file-signature', title: '资料卡会保存在角色卡的扩展数据里，导出角色卡 PNG / JSON 时一起分享' }),
            emb && !inSync ? button('从角色卡导入', importFromCard, { icon: 'fa-file-import' }) : null,
            emb ? button('', removeFromCard, { icon: 'fa-trash', cls: 'danger', title: '从角色卡中移除附带的资料卡' }) : null,
        ),
        h('small.tsrpg-muted', '分享后，需要在「资料卡」页手动从角色卡导入并绑定；打开未绑定聊天不会自动启用。'),
    );
}

// ---------------------------------------------------------------- 资料卡列表

function listSection(app) {
    const s = app.settings;
    const active = app.data;
    const create = p => {
        const [added] = addProfiles(s, [p], { normalize: ST.normalizeProfile });
        app.save();
        app.switchProfile(added.id);
    };
    return h('div',
        h('div.tsrpg-section-title', '资料卡', h('div.tsrpg-spacer'),
            button('新建', () => create(makeProfile({ name: `新资料卡 ${s.profiles.length + 1}` })), { icon: 'fa-plus', title: '新建空白资料卡（只带默认地形）' }),
            button('示例', () => create({ ...sampleProfile(), id: undefined, name: '示例：哥布林战役（副本）' }), { icon: 'fa-dragon', title: '新建一张内置示例资料卡' }),
            button('导入', async () => {
                try {
                    const added = addProfiles(s, profilesFromPayload(await pickJson()), { normalize: ST.normalizeProfile });
                    app.save();
                    toast('success', `已导入 ${added.map(p => `「${p.name}」`).join('')}`);
                    app.render();
                } catch (err) {
                    if (err?.message !== 'cancelled') toast('error', `导入失败：${err.message || err}`);
                }
            }, { icon: 'fa-file-import' })),
        h('div.tsrpg-muted', '资料卡包含单位、地形、地图和战斗规则。「单位」「地形」「地图」页和设置里的战斗规则，编辑的都是正在使用的资料卡。'),
        h('div.tsrpg-active-profile',
            h('div.tsrpg-grid2',
                field('正在编辑', textInput(active.name, v => { active.name = v.trim() || active.name; app.save(); app.render(); })),
                field('简介', textInput(active.desc, v => { active.desc = v; app.save(); }, '这张资料卡讲的是什么故事')),
            )),
        multiBindings(app, active),
        s.profiles.map(p => profileItem(app, p)),
    );
}

function profileItem(app, p) {
    const s = app.settings;
    const isActive = p.id === s.activeProfile;
    const owners = boundOwners(s, p.id).map(k => ST.ownerName(k) || k.replace(/^char:/, '').replace(/\.png$/, ''));
    return h(`div.tsrpg-profile${isActive ? '.active' : ''}`,
        h('div.tsrpg-card-title',
            h('b', p.name),
            isActive ? h('span.tsrpg-tag.key', '编辑中') : null),
        p.desc ? h('div.tsrpg-muted', p.desc) : null,
        h('div.tsrpg-muted', profileStats(p)),
        owners.length ? h('div.tsrpg-muted', h('i.fa-solid.fa-link'), ` 绑定：${owners.join('、')}`) : null,
        h('div.tsrpg-row',
            isActive ? null : button('编辑', () => app.switchProfile(p.id), { icon: 'fa-pen', cls: 'primary' }),
            button('', () => {
                const [copy] = addProfiles(s, [{ ...structuredClone(p), id: undefined, name: `${p.name}（副本）` }], { normalize: ST.normalizeProfile });
                app.save();
                toast('success', `已复制为「${copy.name}」`);
                app.render();
            }, { icon: 'fa-copy', title: '复制' }),
            button('', () => downloadJson(`srpg-${p.name}-${today()}.json`, profilePayload(p)), { icon: 'fa-file-export', title: '导出这张资料卡' }),
            button('', () => {
                if (!confirm(`删除资料卡「${p.name}」？其中的单位、地形、地图都会被删除${owners.length ? `，并解除与 ${owners.join('、')} 的绑定` : ''}。`)) return;
                try {
                    removeProfile(s, p.id);
                    app.save();
                    app.syncProfileWithChat();
                    app.ed = app.ed && { ...app.ed, unitId: null, mapId: null, terrainId: null };
                    app.render();
                } catch (err) {
                    toast('warning', err.message || String(err));
                }
            }, { icon: 'fa-trash', cls: 'danger', title: '删除', disabled: s.profiles.length <= 1 }),
        ),
    );
}

/** 一个资料卡可绑定任意多个角色，每个角色独立保存聊天战斗。 */
function multiBindings(app, profile) {
    const s = app.settings;
    const characters = ST.ctx().characters || [];
    return h('details.tsrpg-multi-bindings',
        h('summary', `为「${profile.name}」绑定多个角色卡`),
        h('small.tsrpg-muted', '勾选启用，可同时绑定多个角色；取消勾选只解除这张资料卡的绑定。绑定到其他资料卡的角色会在勾选后切换。'),
        characters.filter(ch => ch.avatar).map(ch => {
            const key = `char:${ch.avatar}`;
            const existing = getProfile(s, s.bindings[key]);
            return checkbox(`${ch.name || ch.avatar}${existing && existing.id !== profile.id ? `（已绑定：${existing.name}）` : ''}`, s.bindings[key] === profile.id, async enabled => {
                if (enabled) s.bindings[key] = profile.id;
                else if (s.bindings[key] === profile.id) delete s.bindings[key];
                app.save();
                if (ST.currentOwner()?.key === key) await app.syncProfileWithChat();
                app.render();
            });
        }),
        !characters.length ? h('div.tsrpg-muted', '没有可绑定的角色卡。') : null,
    );
}
