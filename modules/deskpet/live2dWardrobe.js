'use strict';

// 只读取模型目录内的资源；不改写下载的 model3 / VTube Studio 配置。
const path = require('path');
const fs = require('fs-extra');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;

async function readLocalJson(base, relative) {
    if (typeof relative !== 'string' || /[:\0]/.test(relative)) return null;
    const file = path.resolve(base, relative.replace(/\\/g, '/'));
    const rel = path.relative(base, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
        const [realBase, realFile, stat] = await Promise.all([fs.realpath(base), fs.realpath(file), fs.stat(file)]);
        const realRel = path.relative(realBase, realFile);
        if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel) || !stat.isFile() || stat.size > MAX_BYTES) return null;
        return await fs.readJson(realFile);
    } catch { return null; }
}

function cleanName(value) {
    return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function fallbackName(value) {
    const name = String(value || '').split(/_by_/i)[0].trim();
    return name || '形象';
}

async function modelInfo(modelPath) {
    const base = path.dirname(modelPath);
    const model = await readLocalJson(base, path.basename(modelPath));
    const stem = path.basename(modelPath).replace(/\.model3\.json$/i, '');
    const vtube = await readLocalJson(base, `${stem}.vtube.json`);
    return { base, model, vtube, name: cleanName(model?.Name || model?.name) || cleanName(vtube?.Name || vtube?.name) };
}

function classify(name) {
    const match = /^(衣服|服装|前发|后发|鬓发)[\s_-]+(.+)$/u.exec(name);
    if (match) return { group: match[1] === '服装' ? '衣服' : match[1], label: match[2], multiple: false };
    const accessory = /^(?:按键[\s_-]+)?(眼镜|耳麦|猫耳|精灵耳|发圈)$/u.exec(name);
    return accessory ? { group: '配饰', label: accessory[1], multiple: true } : null;
}

async function readWardrobe(modelPath) {
    const { base, model, vtube } = await modelInfo(modelPath);
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    const candidates = new Map();
    const add = (file, name) => {
        if (typeof file !== 'string' || !/\.exp3\.json$/i.test(file)) return;
        const id = file.replace(/\\/g, '/');
        if (!candidates.has(id)) candidates.set(id, cleanName(name) || path.posix.basename(id).replace(/\.exp3\.json$/i, ''));
    };
    const expressions = model?.FileReferences?.Expressions;
    const hotkeys = vtube?.Hotkeys;
    for (const entry of (Array.isArray(expressions) ? expressions : []).slice(0, MAX_ITEMS)) add(entry?.File, entry?.Name);
    for (const hotkey of (Array.isArray(hotkeys) ? hotkeys : []).slice(0, MAX_ITEMS)) {
        if (hotkey?.Action === 'ToggleExpression') add(hotkey.File, hotkey.Name);
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
        if (entry.isFile()) add(entry.name);
    }
    const groups = new Map();
    for (const [id, name] of [...candidates].slice(0, MAX_ITEMS)) {
        const category = classify(name);
        if (!category) continue;
        const expression = await readLocalJson(base, id);
        if (!Array.isArray(expression?.Parameters) || expression.Parameters.length > 500) continue;
        const parameters = expression.Parameters.filter(p => typeof p?.Id === 'string' && p.Id.length <= 200
            && Number.isFinite(p.Value) && ['Add', 'Multiply', 'Overwrite'].includes(p.Blend || 'Add'))
            .map(p => ({ id: p.Id, value: p.Value, blend: p.Blend || 'Add' }));
        if (!parameters.length) continue;
        if (!groups.has(category.group)) groups.set(category.group, { id: category.group, name: category.group, multiple: category.multiple, items: [] });
        groups.get(category.group).items.push({ id, name: category.label, parameters });
    }
    return [...groups.values()];
}

function normalizeSelection(groups, selection) {
    return Object.fromEntries(groups.map(group => {
        const wanted = Array.isArray(selection?.[group.id]) ? selection[group.id] : [];
        const valid = group.items.filter(item => wanted.includes(item.id)).map(item => item.id);
        return [group.id, group.multiple ? valid : valid.slice(0, 1)];
    }));
}

module.exports = { readLocalJson, modelInfo, fallbackName, readWardrobe, normalizeSelection };