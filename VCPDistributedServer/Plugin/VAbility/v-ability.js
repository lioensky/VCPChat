'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const APP_DATA = path.resolve(__dirname, '../../../AppData');
const STORES = [
    ['official', 'VCPChatTarven.official.json'],
    ['user', 'VCPChatTarven.json']
];
const text = value => [{ type: 'text', text: value }];
const inline = value => String(value).replace(/[\\`*_{}\[\]<>()|#!]/g, '\\$&').replace(/[\r\n]+/g, ' ');

async function loadAbilities(appData = APP_DATA) {
    const groups = await Promise.all(STORES.map(async ([source, filename]) => {
        let store;
        try {
            store = JSON.parse((await fs.readFile(path.join(appData, filename), 'utf8')).replace(/^\uFEFF/, ''));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw new Error(`无法读取 ${filename}：${error.message}`);
        }
        if (!store || !Array.isArray(store.rules)) throw new Error(`${filename} 缺少 rules 数组。`);
        const seen = new Set();
        return store.rules.map((rule, index) => {
            if (!rule || typeof rule.id !== 'string' || !rule.id.trim() ||
                typeof rule.name !== 'string' || !rule.name.trim() || typeof rule.content !== 'string') {
                throw new Error(`${filename} 第 ${index + 1} 条能力的 id/name/content 无效。`);
            }
            if (seen.has(rule.id)) throw new Error(`${filename} 存在重复 id：${rule.id}`);
            seen.add(rule.id);
            return { id: rule.id, name: rule.name, content: rule.content, source };
        });
    }));
    const abilities = groups.flat();
    const counts = new Map();
    for (const ability of abilities) counts.set(ability.id, (counts.get(ability.id) || 0) + 1);
    return abilities.map(({ source, ...ability }) => ({
        ...ability,
        id: counts.get(ability.id) > 1 ? `${source}:${ability.id}` : ability.id
    }));
}

function catalog(abilities) {
    return abilities.map(a => `- **name:** ${inline(a.name)}\n  - **id:** ${inline(a.id)}`).join('\n');
}

async function execute(args, appData = APP_DATA) {
    try {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象。');
        const command = typeof args.command === 'string' ? args.command.trim().toLowerCase() : '';
        if (!['list', 'read'].includes(command)) throw new Error('command 必须为 list 或 read。');
        let name;
        let id;
        if (command === 'read') {
            for (const key of ['name', 'id']) {
                if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) {
                    throw new Error(`${key} 必须为非空字符串。`);
                }
            }
            name = args.name?.trim();
            id = args.id?.trim();
            if (!name && !id) throw new Error('read 需要 name；重名时使用返回的 id。');
        }
        const abilities = await loadAbilities(appData);
        if (command === 'list') {
            return text(`## V能力目录\n\n共 ${abilities.length} 项。使用 read + name 读取正文；重名时用 id。\n\n${catalog(abilities) || '暂无能力。'}`);
        }
        // Name is authoritative when supplied; id only narrows duplicate names.
        let matches = name ? abilities.filter(a => a.name === name) : abilities.filter(a => a.id === id);
        if (name && matches.length > 1 && id) matches = matches.filter(a => a.id === id);
        if (!matches.length) return text('## 未找到能力\n\n请使用 list 核对 name 或 id；名称采用精确匹配。');
        if (matches.length > 1) {
            return text(`## 能力重名，请指定 id\n\n${catalog(matches)}\n\n使用 read + id 读取其中一项；本次不展开 content。`);
        }
        const ability = matches[0];
        return text(`## ${inline(ability.name)}\n\n- **id:** ${inline(ability.id)}\n- **name:** ${inline(ability.name)}\n\n### content\n\n${ability.content}`);
    } catch (error) {
        return text(`## V能力读取失败\n\n${inline(error.message)}`);
    }
}

async function main() {
    try {
        process.stdin.setEncoding('utf8');
        let input = '';
        for await (const chunk of process.stdin) {
            input += chunk;
            if (input.length > 65536) throw new Error('输入超过 64K 字符。');
        }
        process.stdout.write(JSON.stringify({
            status: 'success',
            result: { content: await execute(JSON.parse(input)) }
        }) + '\n');
    } catch (error) {
        process.stdout.write(JSON.stringify({
            status: 'error',
            error: `V能力请求失败：${error.message}`
        }) + '\n');
    }
}

if (require.main === module) main();
module.exports = { execute, loadAbilities };