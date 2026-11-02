'use strict';
// VCP (): 白板上人和 Agent 轮流来。人写在板上，点“交给 Agent”，Agent 读板，把回答、连线、排版也写在板上，问和答都留在 .excalidraw 里。
// 没有提问框和第二份对话记录，白板本身就是记录。
// 走上游的 AgentAssistant：即时通讯是问话模式，只能看不能改（toolbox/modules/uttuAskModePolicy.js），动手要委派（task_delegation）。委派是异步的，
// 这里只管派活和查进度，页面每两秒问一次。Agent 的工具说明写在 ScriptoriumCollaborator 的 manifest 里。
const fs = require('fs-extra');
const path = require('path');

const TOOL = 'ScriptoriumCollaborator';
const FIELD_END = /「末」/g;
const field = (name, value) => `${name}:「始」${String(value).replace(FIELD_END, '「 末」')}「末」`;
const request = (fields) => `<<<[TOOL_REQUEST]>>>\n${[field('tool_name', 'AgentAssistant'), ...fields].join(',\n')}\n<<<[END_TOOL_REQUEST]>>>`;
const cleanReport = (text) => String(text || '').replace(/\[\[Flowlock::[^\]]*\]\]/g, '').trim();

function endpointOf(settings) {
    let origin;
    try { origin = new URL(settings.vcpServerUrl).origin; } catch (_) { throw new Error('还没有连上 VCP 后端。'); }
    return new URL('/v1/human/tool', origin);
}

async function call(fields, { readSettings, fetchImpl = fetch }) {
    const settings = await readSettings();
    const response = await fetchImpl(endpointOf(settings), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${settings.vcpApiKey || ''}` },
        body: request(fields),
    });
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch (_) { /* 不是 JSON，下面报错 */ }
    if (!response.ok) throw new Error(data?.plugin_error || data?.error || data?.details || `后端回 ${response.status}。`);
    return data?.content?.find((part) => part.type === 'text')?.text ?? body;
}

async function start({ agent, prompt } = {}, deps) {
    const text = await call([field('agent_name', agent), field('prompt', prompt), field('maid', '用户'),
        field('task_delegation', 'true'), field('inject_tools', TOOL)], deps);
    const id = /aa-delegation-[\w-]+/.exec(text)?.[0];
    if (!id) throw new Error(text.slice(0, 200) || '后端没有接下这件事。');
    return { success: true, id };
}

// 进行中回一句话；结束后回 JSON（status、finalReportPreview），过一阵只剩归档时回一段说明。
async function status({ id } = {}, deps) {
    const text = await call([field('query_delegation', id)], deps);
    if (/仍在进行中/.test(text)) return { success: true, running: true };
    try {
        const detail = JSON.parse(text);
        if (detail.status === 'running') return { success: true, running: true };
        return { success: true, running: false, ok: detail.status === 'completed', report: cleanReport(detail.finalReportPreview) };
    } catch (_) {
        return { success: true, running: false, ok: true, report: '' };
    }
}

async function agents({ appDataRoot }) {
    const settings = await fs.readJson(path.join(appDataRoot, 'settings.json')).catch(() => null);
    return { success: true, agents: Array.isArray(settings?.scriptoriumBoardAgents) ? settings.scriptoriumBoardAgents : [] };
}

// deps: appDataRoot、projectRoot()、available()（单独运行的文坊没有后端）。
function register(ipcMain, deps) {
    const readSettings = () => fs.readJson(path.join(deps.appDataRoot, 'settings.json'));
    ipcMain.handle('uttu-scriptorium:board-turn', async (_event, payload = {}) => {
        try {
            switch (payload.command) {
                case 'available': return { success: true, available: deps.available() };
                case 'agents': return await agents(deps);
                case 'start': return await start(payload, { readSettings });
                case 'status': return await status(payload, { readSettings });
                default: return { success: false, error: '不认识的操作。' };
            }
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
}

module.exports = { register, request, start, status };
