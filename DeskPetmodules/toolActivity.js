/* 桌宠「正在做什么」小卡片的数据：从回复流里认出工具调用请求和调用结果，
 * 整理成「正在搜索 · 关键词」这样一句话。不依赖 DOM，测试里可以直接载入。
 *
 * 回复流里的两种块（和主窗口工具卡片认的是同一套）：
 *   <<<[TOOL_REQUEST]>>> tool_name:「始」X「末」, command:「始」Y「末」, … <<<[END_TOOL_REQUEST]>>>
 *   [[VCP调用结果信息汇总: - 工具名称: X  - 执行状态: ✅ SUCCESS … VCP调用结果结束]]
 */

const REQUEST_OPEN = '<<<[TOOL_REQUEST]>>>';
const REQUEST_CLOSE = '<<<[END_TOOL_REQUEST]>>>';
const RESULT_OPEN = '[[VCP调用结果信息汇总:';
const RESULT_CLOSE = 'VCP调用结果结束]]';
const MAX_ACTIVITIES = 20;
const TARGET_MAX = 28;
const OPEN_HEAD_CHARS = 2048;

// 按命令认类别（与主窗口工具行的分类一致），命令认不出再按工具名猜。
const COMMAND_KINDS = {
    GetCode: 'read', ReadCode: 'read', ReadFile: 'read', Outline: 'read', ListWorkspaces: 'read', ListProjects: 'read',
    GetProject: 'read', GetNodeDiff: 'read', ListDirectory: 'read',
    SearchProjects: 'search', FindSymbol: 'search', Trace: 'search', SearchHistory: 'search', search: 'search',
    EditCode: 'edit', CreateFile: 'edit', RemoveFile: 'edit', MoveFile: 'edit', MoveCode: 'edit', CopyCode: 'edit',
    WriteFile: 'edit', AppendFile: 'edit', ResolveEdit: 'edit', Rollback: 'edit',
    UpdateTodos: 'plan', SubmitReport: 'plan',
    ExecutePowerShell: 'command', StartInteractive: 'command', SendInteractiveKey: 'command',
    PasteInteractiveText: 'command', RunInteractiveSequence: 'command',
    CreateTopic: 'topic', CreateFlowlockTopic: 'topic', ReplyToTopic: 'topic',
    SetAlarm: 'alarm',
};
const TOOL_KINDS = [
    [/alarm|闹钟/i, 'alarm'],
    [/topicsponsor/i, 'topic'],
    [/dailynote|diary|memo|memory|日记|回忆/i, 'memory'],
    [/search|tavily|google|bing|serp|搜索/i, 'search'],
    [/fetch|url|browser|web|crawl|网页/i, 'web'],
    [/gen$|flux|comfy|image|draw|paint|novelai|suno|video|绘|画/i, 'media'],
    [/music|song|音乐/i, 'music'],
    [/weather|天气/i, 'weather'],
    [/powershell|shell|terminal|command|executor/i, 'command'],
    [/file|code|project/i, 'read'],
];
// [进行中, 已完成, 图标]
const KIND_WORDS = {
    read: ['正在查看', '看完了', '📄'],
    search: ['正在搜索', '搜完了', '🔍'],
    edit: ['正在修改', '改好了', '✏️'],
    command: ['正在执行命令', '命令执行完了', '⌨️'],
    web: ['正在看网页', '网页看完了', '🌐'],
    media: ['正在生成', '生成好了', '🎨'],
    music: ['正在放音乐', '音乐放上了', '🎵'],
    weather: ['正在查天气', '天气查到了', '⛅'],
    memory: ['正在翻记忆', '记下了', '📔'],
    plan: ['正在更新计划', '计划更新了', '🗒️'],
    topic: ['正在开新话题', '新话题开好了', '💬'],
    alarm: ['正在设闹钟', '闹钟设好了', '⏰'],
    other: ['正在调用', '调用完了', '🔧'],
};
// 说明「对什么做」的参数，按顺序取第一个有值的
const TARGET_FIELDS = ['query', 'keyword', 'keywords', 'prompt', 'url', 'path', 'filePath', 'file', 'paths', 'glob',
    'powershell', 'command_line', 'topic_name', 'time_description', 'reminder_text', 'song', 'target', 'city', 'text', 'content'];

function parseFields(body) {
    const fields = {};
    const re = /([A-Za-z_][\w-]*)\s*[:：]\s*「始」([\s\S]*?)(?:「末」|$)/g;
    let match;
    while ((match = re.exec(body)) !== null) {
        if (!(match[1] in fields)) fields[match[1]] = match[2].trim();
    }
    return fields;
}

function parseResult(body) {
    const field = (name) => body.match(new RegExp(`${name}\\s*[:：]\\s*([^\\n]*)`))?.[1]?.trim() || '';
    return { tool: field('工具名称'), status: resultStatus(field('执行状态')) };
}

function resultStatus(value) {
    const status = String(value || '').replace(/^[✅❌⚠️\s]+/u, '').trim().toLowerCase();
    if (/^(success|succeeded|ok|成功)/.test(status)) return 'success';
    if (/^(fail|error|错误|失败)/.test(status)) return 'failed';
    if (/^(stopped|cancel|已停止|已取消)/.test(status)) return 'failed';
    return 'success';
}

function oneLine(value, max = TARGET_MAX) {
    const flat = String(value || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function toolKind(tool, command) {
    if (command && COMMAND_KINDS[command]) return COMMAND_KINDS[command];
    for (const [pattern, kind] of TOOL_KINDS) if (pattern.test(tool || '')) return kind;
    return 'other';
}

/** 一条活动 → { icon, text, status }，text 形如「正在搜索 · 今天的天气」 */
export function describeActivity(activity) {
    const kind = toolKind(activity.tool, activity.command);
    const [running, done, icon] = KIND_WORDS[kind] || KIND_WORDS.other;
    let verb;
    if (activity.status === 'running') verb = kind === 'other' && activity.tool ? `正在调用 ${activity.tool}` : running;
    else if (activity.status === 'failed') verb = `${activity.tool || '工具'} 没成功`;
    else verb = kind === 'other' && activity.tool ? `${activity.tool} 调用完了` : done;
    const target = activity.target ? ` · ${activity.target}` : '';
    return { icon, text: `${verb}${target}`, status: activity.status, kind };
}

/**
 * 读一条流式回复，记下其中的工具调用。push 返回这一段有没有带来变化。
 * activities 按出现顺序排列：{ tool, command, target, status: running | success | failed }
 */
export function createToolActivityTracker() {
    let buffer = '';
    let cursor = 0;
    const activities = [];
    let open = null; // 正在写的请求块：{ activity, at }

    const fillFromRequest = (activity, body) => {
        const fields = parseFields(body);
        activity.tool = fields.tool_name || activity.tool || '';
        activity.command = fields.command || fields.commandIdentifier || activity.command || '';
        const targetKey = TARGET_FIELDS.find((key) => fields[key]);
        activity.target = targetKey ? oneLine(fields[targetKey]) : activity.target || '';
    };

    const applyResult = ({ tool, status }) => {
        const running = activities.filter((a) => a.status === 'running');
        const match = running.find((a) => a.tool && tool && a.tool === tool) || running[0];
        if (match) {
            match.status = status;
            return true;
        }
        // 只有结果、没看到请求（请求被藏起来了）：也算一条，至少让人知道调过什么
        if (!tool) return false;
        activities.push({ tool, command: '', target: '', status });
        return true;
    };

    const scan = () => {
        let changed = false;
        for (;;) {
            if (open) {
                // 写文件这类请求的参数能有几十 KB：结束标记只在新到的那段附近找，
                // 参数只看开头一段（工具名、命令和对象都写在前面）
                const close = buffer.indexOf(REQUEST_CLOSE, Math.max(open.at, open.searched - REQUEST_CLOSE.length));
                open.searched = buffer.length;
                const body = close === -1 ? buffer.slice(open.at, open.at + OPEN_HEAD_CHARS) : buffer.slice(open.at, close);
                const before = `${open.activity.tool}|${open.activity.command}|${open.activity.target}`;
                fillFromRequest(open.activity, body);
                if (`${open.activity.tool}|${open.activity.command}|${open.activity.target}` !== before) changed = true;
                if (close === -1) {
                    // 开头之后的参数用不上，只留够认出结束标记的尾巴，缓冲不跟着请求变长
                    const keep = open.at + OPEN_HEAD_CHARS;
                    if (buffer.length > keep + REQUEST_CLOSE.length * 2) {
                        buffer = buffer.slice(0, keep) + buffer.slice(-(REQUEST_CLOSE.length - 1));
                        open.searched = buffer.length;
                    }
                    break;
                }
                cursor = close + REQUEST_CLOSE.length;
                open = null;
                continue;
            }
            const req = buffer.indexOf(REQUEST_OPEN, cursor);
            const res = buffer.indexOf(RESULT_OPEN, cursor);
            if (req === -1 && res === -1) {
                // 标记可能被切在两段中间：留下够长的尾巴，下次接着找
                cursor = Math.max(cursor, buffer.length - Math.max(REQUEST_OPEN.length, RESULT_OPEN.length));
                break;
            }
            if (req !== -1 && (res === -1 || req < res)) {
                const activity = { tool: '', command: '', target: '', status: 'running' };
                activities.push(activity);
                if (activities.length > MAX_ACTIVITIES) activities.shift();
                open = { activity, at: req + REQUEST_OPEN.length, searched: 0 };
                changed = true;
                continue;
            }
            const close = buffer.indexOf(RESULT_CLOSE, res);
            if (close === -1) {
                cursor = res;
                break;
            }
            if (applyResult(parseResult(buffer.slice(res + RESULT_OPEN.length, close)))) changed = true;
            cursor = close + RESULT_CLOSE.length;
        }
        // 已经处理过的部分不用留着
        if (cursor > 4096) {
            const drop = open ? Math.min(cursor, open.at - REQUEST_OPEN.length) : cursor;
            buffer = buffer.slice(drop);
            cursor -= drop;
            if (open) {
                open.at -= drop;
                open.searched -= drop;
            }
        }
        return changed;
    };

    return {
        push(text) {
            if (!text) return false;
            buffer += text;
            return scan();
        },
        /** 回复结束：还没等到结果的调用不会再有结果了，当作做完 */
        finish() {
            let changed = false;
            for (const activity of activities) {
                if (activity.status === 'running') {
                    activity.status = 'success';
                    changed = true;
                }
            }
            open = null;
            return changed;
        },
        get activities() { return activities; },
        get latest() { return activities[activities.length - 1] || null; },
    };
}
