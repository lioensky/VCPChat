'use strict';

const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TOKEN = /\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}/g;
const MAX_FILE = 256 * 1024;
const MAX_RESULT = 4 * 1024 * 1024;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function parseObject(value, name, fallback = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value && typeof value === 'object' && !Array.isArray(value)) return clone(value);
    try {
        const parsed = JSON.parse(String(value));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('根值不是对象');
        return parsed;
    } catch (error) {
        throw new Error(`${name} 必须是 JSON 对象：${error.message}`);
    }
}

function collectVariables(value, found = new Set()) {
    if (typeof value === 'string') {
        for (const match of value.matchAll(TOKEN)) found.add(match[1]);
    } else if (Array.isArray(value)) {
        value.forEach(item => collectVariables(item, found));
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(item => collectVariables(item, found));
    }
    return found;
}

function normalizePlaceholders(value, steps) {
    const supplied = parseObject(value, 'placeholders');
    const used = collectVariables(steps);
    const normalized = {};
    for (const [name, raw] of Object.entries(supplied)) {
        if (!VARIABLE.test(name)) throw new Error(`占位符名称无效：${name}`);
        const definition = typeof raw === 'string' ? { description: raw } : parseObject(raw, `placeholders.${name}`);
        normalized[name] = {
            description: String(definition.description || '').slice(0, 500),
            required: definition.required !== false && definition.default === undefined,
            ...(definition.default !== undefined ? { default: definition.default } : {}),
            ...(definition.example !== undefined ? { example: definition.example } : {}),
        };
    }
    const undeclared = [...used].filter(name => !normalized[name]);
    if (undeclared.length) throw new Error(`串语法引用了未声明占位符：${undeclared.join('、')}`);
    return {
        definitions: normalized,
        used: [...used],
        valid: true,
    };
}

function resolveVariables(value, definitions, inputs) {
    if (typeof value === 'string') {
        const exact = value.match(/^\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}$/);
        if (exact) return variableValue(exact[1], definitions, inputs);
        return value.replace(TOKEN, (_token, name) => String(variableValue(name, definitions, inputs)));
    }
    if (Array.isArray(value)) return value.map(item => resolveVariables(item, definitions, inputs));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key, resolveVariables(item, definitions, inputs),
        ]));
    }
    return value;
}

function variableValue(name, definitions, inputs) {
    const definition = definitions[name];
    if (!definition) throw new Error(`Skill 引用了未知占位符：${name}`);
    if (Object.prototype.hasOwnProperty.call(inputs, name)) return inputs[name];
    if (Object.prototype.hasOwnProperty.call(definition, 'default')) return definition.default;
    throw new Error(`缺少必填 Skill 输入：${name}`);
}

function validateSteps(steps) {
    if (!Array.isArray(steps) || !steps.length || steps.length > 100) {
        throw new Error('Skill 需要 1-100 个编号步骤。');
    }
    const indexes = new Set();
    for (const step of steps) {
        if (!Number.isInteger(step.index) || step.index < 1 || indexes.has(step.index)) {
            throw new Error('Skill 步骤 index 必须是唯一正整数。');
        }
        indexes.add(step.index);
        if (!step.command || typeof step.command !== 'string') throw new Error(`Skill 步骤 ${step.index} 缺少 command。`);
        if (step.command === 'wait') {
            if (!Number.isFinite(step.waitMs) || step.waitMs < 0 || step.waitMs > 2147483647) {
                throw new Error(`Skill 步骤 ${step.index} 等待时长无效或超过 JavaScript 定时器安全范围。`);
            }
        }
        if (step.params && (typeof step.params !== 'object' || Array.isArray(step.params))) {
            throw new Error(`Skill 步骤 ${step.index} params 无效。`);
        }
    }
    return steps.slice().sort((a, b) => a.index - b.index);
}

class LoomSkillService {
    constructor({ root, execute, compile, ttlMs = 1800000, timeoutMs = 120000 }) {
        this.root = root;
        this.execute = execute;
        this.compile = compile;
        this.ttlMs = ttlMs;
        this.timeoutMs = timeoutMs;
        this.tasks = new Map();
        this.busyApps = new Set();
        this.sweep = setInterval(() => this.cleanup(), Math.min(ttlMs, 60000));
        this.sweep.unref?.();
    }

    file(skillId) {
        if (!ID.test(String(skillId || ''))) {
            throw new Error('skillId 必须为 2-64 位小写字母、数字、短横线或下划线。');
        }
        return path.join(this.root, `${skillId}.skill.json`);
    }

    async read(skillId) {
        const file = this.file(skillId);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) {
            throw new Error('Skill 文件类型或大小不合法。');
        }
        const skill = JSON.parse(await fs.readFile(file, 'utf8'));
        if (skill.schemaVersion !== 2 || skill.skillId !== skillId || !ID.test(skill.appId)) {
            throw new Error('Skill 文件身份或版本无效。');
        }
        skill.steps = validateSteps(skill.steps);
        normalizePlaceholders(skill.placeholders, skill.steps);
        return skill;
    }

    async save(args, edit = false) {
        const file = this.file(args.skillId);
        const old = edit ? await this.read(args.skillId) : null;
        if (edit && ![
            'title', 'name', 'description', 'appId', 'placeholders', 'steps',
        ].some(key => args[key] !== undefined) && !Object.keys(args).some(key => /^command\d+$/i.test(key))) {
            throw new Error('EditSkill 没有提供可更新内容。');
        }
        const compiled = typeof this.compile === 'function' &&
            (args.steps !== undefined || Object.keys(args).some(key => /^command\d+$/i.test(key)))
            ? await this.compile(args)
            : null;
        const steps = validateSteps(compiled?.steps || args.steps || old?.steps);
        const placeholderCheck = normalizePlaceholders(
            args.placeholders ?? old?.placeholders ?? {},
            steps
        );
        const skill = {
            schemaVersion: 2,
            skillId: args.skillId,
            appId: String(args.appId ?? compiled?.appId ?? old?.appId ?? ''),
            title: String(args.title ?? args.name ?? old?.title ?? args.skillId).slice(0, 200),
            description: String(args.description ?? old?.description ?? '').slice(0, 2000),
            placeholders: placeholderCheck.definitions,
            steps,
            validation: compiled?.validation || {
                placeholders: placeholderCheck,
                targets: [],
                executed: false,
                valid: true,
            },
            updatedAt: new Date().toISOString(),
        };
        if (!ID.test(skill.appId)) throw new Error('Skill 需要有效 appId。');
        const serialized = JSON.stringify(skill, null, 2);
        if (Buffer.byteLength(serialized) > MAX_FILE) throw new Error('Skill 文件超过 256 KB。');
        await fs.mkdir(this.root, { recursive: true });
        if (!edit) {
            await fs.writeFile(file, serialized, { flag: 'wx' });
        } else {
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.writeFile(temporary, serialized, { flag: 'wx' });
                await fs.rename(temporary, file);
            } finally {
                await fs.rm(temporary, { force: true });
            }
        }
        return skill;
    }

    async manage(args) {
        const operation = String(args.operation || 'list').toLowerCase();
        if (operation === 'get') return this.read(args.skillId);
        if (operation === 'delete') {
            await fs.unlink(this.file(args.skillId));
            return { skillId: args.skillId, deleted: true };
        }
        if (operation !== 'list') throw new Error('ManageSkill operation 支持 list/get/delete。');
        await fs.mkdir(this.root, { recursive: true });
        const skills = [];
        for (const file of await fs.readdir(this.root)) {
            if (!file.endsWith('.skill.json')) continue;
            const skillId = file.slice(0, -11);
            try {
                const skill = await this.read(skillId);
                skills.push({
                    skillId, appId: skill.appId, title: skill.title,
                    description: skill.description, updatedAt: skill.updatedAt,
                    stepCount: skill.steps.length,
                    placeholders: Object.keys(skill.placeholders),
                    validation: skill.validation,
                });
            } catch (error) {
                skills.push({ skillId, error: error.message });
            }
        }
        return { skills };
    }

    cleanup() {
        for (const [id, task] of this.tasks) {
            if (task.expiresAt && task.expiresAt <= Date.now()) this.tasks.delete(id);
        }
    }

    query(taskId) {
        this.cleanup();
        const task = this.tasks.get(taskId);
        if (!task) throw new Error('任务不存在、已过期或服务已重启。');
        return clone(task);
    }

    async run(args) {
        const mode = String(args.mode || 'sync').toLowerCase();
        if (!['sync', 'async'].includes(mode)) throw new Error('mode 必须为 sync 或 async。');
        const skill = await this.read(args.skillId);
        const inputs = parseObject(args.inputs, 'inputs');
        // 在创建任务和任何页面动作之前完成全部输入检查与字段级替换。
        const steps = validateSteps(resolveVariables(skill.steps, skill.placeholders, inputs));
        const unusedInputs = Object.keys(inputs).filter(name => !skill.placeholders[name]);
        if (unusedInputs.length) throw new Error(`传入了未声明 Skill 输入：${unusedInputs.join('、')}`);
        this.cleanup();
        if (this.tasks.size >= 100) throw new Error('任务容量已满，请等待过期回收。');
        const apps = new Set([skill.appId, ...steps.filter(step => step.appId).map(step => step.appId)]);
        if ([...apps].some(id => this.busyApps.has(id))) throw new Error('目标应用已有 Skill 执行中，请稍后重试。');
        for (const id of apps) this.busyApps.add(id);
        const taskId = randomUUID();
        const task = {
            taskId, skillId: skill.skillId, status: 'running',
            createdAt: Date.now(), completedCount: 0, steps: [], content: [],
        };
        this.tasks.set(taskId, task);
        const release = () => apps.forEach(id => this.busyApps.delete(id));
        const work = this.perform(task, skill, steps, release, {
            timeoutMs: mode === 'sync' ? this.timeoutMs : null,
        }).finally(() => {
            if (!task.pendingAction) release();
        });
        if (mode === 'async') {
            void work.catch(() => {});
            return { taskId };
        }
        await work;
        return this.query(taskId);
    }

    async perform(task, skill, steps, release, options = {}) {
        const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : null;
        const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
        let appId = skill.appId;
        let resultBytes = 0;
        try {
            for (const step of steps) {
                if (deadline !== null && Date.now() >= deadline) {
                    throw new Error('同步 Skill 执行超过两分钟，后续步骤已停止；长流程请使用异步模式。');
                }
                task.currentStep = step.index;
                if (step.appId) appId = step.appId;
                let timer;
                const operation = step.command === 'wait'
                    ? new Promise(resolve => { timer = setTimeout(resolve, step.waitMs); })
                    : Promise.resolve().then(() => this.execute({
                        command: step.command,
                        appId,
                        ...(step.params || {}),
                        ...(step.options || {}),
                    }));
                let deadlineTimer;
                let output;
                try {
                    if (deadline === null) {
                        output = await operation;
                    } else {
                        output = await Promise.race([
                            operation,
                            new Promise((_, reject) => {
                                deadlineTimer = setTimeout(() => reject(new Error(
                                    '同步 Skill 执行超时；已发送动作可能仍在完成，不会重放，后续步骤已停止。'
                                )), Math.max(1, deadline - Date.now()));
                            }),
                        ]);
                    }
                } catch (error) {
                    if (step.command !== 'wait') {
                        task.pendingAction = true;
                        void operation.catch(() => {}).finally(() => {
                            task.pendingAction = false;
                            release();
                        });
                    }
                    throw error;
                } finally {
                    clearTimeout(timer);
                    clearTimeout(deadlineTimer);
                }
                resultBytes += Buffer.byteLength(JSON.stringify(output ?? null));
                if (resultBytes > MAX_RESULT) throw new Error('Skill 回执超过 4 MB，后续步骤已停止。');
                task.steps.push({ index: step.index, command: step.command, output: output ?? null });
                if (Array.isArray(output?.content)) task.content.push(...output.content);
                task.completedCount++;
            }
            task.status = 'success';
        } catch (error) {
            task.status = 'failed';
            task.error = error.message;
            task.failedStep = task.currentStep;
        } finally {
            task.finishedAt = Date.now();
            task.expiresAt = task.finishedAt + this.ttlMs;
        }
    }

    dispose() {
        clearInterval(this.sweep);
    }
}

module.exports = {
    LoomSkillService,
    collectVariables,
    normalizePlaceholders,
    resolveVariables,
    validateSteps,
};