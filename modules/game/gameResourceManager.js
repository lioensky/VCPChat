'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

class GameResourceManager {
    constructor(runtime) { this.runtime = runtime; }
    async inventory() {
        const { gameService, groupChat } = this.runtime;
        const listed = await gameService.listRecords();
        const groups = await groupChat.getAgentGroups();
        const sessions = new Map(groups.filter(g => g.mode === 'game')
            .map(g => [g.id, { groupId: g.id, name: g.name, records: [], running: false }]));
        for (const item of listed.records) {
            const record = await gameService.read(item.matchId);
            let session = sessions.get(record.groupId);
            if (!session) {
                session = { groupId: record.groupId, name: '游戏存档（后台群缺失或已改模式）',
                    records: [], running: false };
                sessions.set(record.groupId, session);
            }
            session.records.push(item);
            session.running ||= this.runtime.getState(item.matchId).running;
        }
        return { sessions: [...sessions.values()], unavailable: listed.unavailable };
    }
    async remove(groupIds) {
        if (!Array.isArray(groupIds) || !groupIds.length || groupIds.length > 200
            || groupIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))) {
            throw new Error('请选择有效的游戏会话（一次最多200项）。');
        }
        if (this.runtime.maintenance) throw new Error('游戏资源管理正在执行，请稍后。');
        if (this.runtime.resourceOperations) throw new Error('开桌或牌局操作尚未结束，请稍后清理。');
        this.runtime.maintenance = true;
        const results = [];
        try {
            for (const groupId of new Set(groupIds)) {
                try {
                    const inventory = await this.inventory();
                    if (inventory.unavailable.length) throw new Error('存在关联不明的坏档，请先修复；本轮拒绝删除会话。');
                    const session = inventory.sessions.find(s => s.groupId === groupId);
                    if (!session) throw new Error('会话已不存在，请刷新。');
                    if (session.running) throw new Error('本桌仍有请求运行，请停止并等回复结束后再清理。');
                    const group = await this.runtime.groupChat.getAgentGroupConfig(groupId);
                    if (group && group.mode !== 'game') throw new Error('后台群已改为普通群，拒绝删除。');
                    const ids = session.records.map(r => r.matchId).sort();
                    // Own every match write queue before deleting anything. Reads after deletion fail;
                    // no queued submit can recreate a removed save.
                    const locked = async index => {
                        if (index < ids.length) return this.runtime.gameService.serial(ids[index], () => locked(index + 1));
                        for (const id of ids) {
                            const record = await this.runtime.gameService.read(id);
                            if (record.groupId !== groupId) throw new Error('存档关联已变化，请刷新。');
                        }
                        const latestGroup = await this.runtime.groupChat.getAgentGroupConfig(groupId);
                        if (latestGroup && latestGroup.mode !== 'game') throw new Error('后台群模式已变化，拒绝删除。');
                        if (!latestGroup) {
                            try {
                                await fs.lstat(path.join(path.dirname(this.runtime.gameService.root), 'AgentGroups', groupId));
                                throw new Error('后台群目录存在但配置不可读取，拒绝当作缺失清理。');
                            } catch (error) { if (error.code !== 'ENOENT') throw error; }
                        }
                        const root = path.dirname(this.runtime.gameService.root);
                        const safeDirectory = async file => {
                            try {
                                const stat = await fs.lstat(file);
                                if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资源目录不是普通目录，拒绝清理。');
                                const normalize = value => process.platform === 'win32'
                                    ? path.resolve(value).toLowerCase() : path.resolve(value);
                                const expected = path.join(await fs.realpath(root), path.relative(root, file));
                                if (normalize(await fs.realpath(file)) !== normalize(expected)) {
                                    throw new Error('资源目录存在链接重定向，拒绝清理。');
                                }
                            } catch (error) { if (error.code !== 'ENOENT') throw error; }
                        };
                        for (const id of ids) await safeDirectory(path.dirname(this.runtime.gameService.file(id)));
                        if (latestGroup) {
                            await safeDirectory(path.join(root, 'AgentGroups', groupId));
                            await safeDirectory(path.join(root, 'UserData', groupId));
                        }
                        // Remove saves first. On failure keep the backend group and report partial progress.
                        for (const id of ids) {
                            await fs.rm(path.dirname(this.runtime.gameService.file(id)), { recursive: true, force: true });
                        }
                        if (latestGroup) {
                            // Keep config discoverable when history removal fails, so retry remains possible.
                            await fs.rm(path.join(root, 'UserData', groupId), { recursive: true, force: true });
                            const result = await this.runtime.groupChat.deleteAgentGroup(groupId);
                            if (!result.success) throw new Error(result.error || '后台群清理失败，刷新后可重试。');
                        }
                    };
                    await locked(0);
                    results.push({ groupId, success: true, count: ids.length });
                } catch (error) {
                    results.push({ groupId, success: false, error: error.message });
                }
            }
            return { results };
        } finally { this.runtime.maintenance = false; }
    }
}
module.exports = { GameResourceManager };