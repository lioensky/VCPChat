const fs = require('fs').promises;
const path = require('path');
const cheerio = require('cheerio');
const { projectMemoryProtocols } = require('../../shared/memoryProtocolProjection');

const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 200;
const DEFAULT_OUTLINE_LIMIT = 50;
const MAX_OUTLINE_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const AUTO_TAIL_MESSAGE_THRESHOLD = 30;
const AUTO_TAIL_CHAR_THRESHOLD = 32000;
const DEFAULT_TAIL_COUNT = 20;
const DEFAULT_MAX_CHARS_PER_TURN = 12000;
const EXPLICIT_SLICE_MAX_CHARS_PER_TURN = 48000;
const TOOL_RESULT_START_MARKER = '[[' + 'VCP调用结果信息汇总:';
const TOOL_RESULT_END_MARKER = 'VCP调用结果结束]' + ']';
const HTML_TAG_NAMES = new Set([
    'a', 'abbr', 'address', 'article', 'aside', 'audio', 'b', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
    'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del', 'details', 'dfn',
    'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'g',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input',
    'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map', 'mark', 'math', 'menu', 'meta', 'meter',
    'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'path', 'picture', 'pre',
    'progress', 'q', 'rect', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section', 'select', 'small', 'source',
    'span', 'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea',
    'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr', 'circle',
    'ellipse', 'line', 'polygon', 'polyline', 'text', 'tspan', 'defs', 'lineargradient', 'stop', 'use',
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function safeSlice(str, start = 0, end = str.length) {
    const s = String(str ?? '');
    const len = s.length;
    let from = Math.max(0, Math.min(len, start < 0 ? len + start : start));
    let to = Math.max(from, Math.min(len, end < 0 ? len + end : end));
    if (from > 0 && from < len) {
        const code = s.charCodeAt(from);
        if (code >= 0xDC00 && code <= 0xDFFF) from += 1;
    }
    if (to > from && to < len) {
        const prev = s.charCodeAt(to - 1);
        if (prev >= 0xD800 && prev <= 0xDBFF) to -= 1;
    }
    return s.slice(from, to);
}

function isSafeRegexPattern(pattern) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > 300) return false;
    // 防御指数级回溯（如 (a+)+ 或 ([a-z]+)*）
    return !/\((?:[^()\\]|\\.)*[+*}\]]\s*\)\s*(?:[+*?]|\{\d+,)/.test(pattern);
}

async function readJsonWithRetry(filePath, retries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(content);
        } catch (error) {
            lastError = error;
            if (attempt < retries && (error instanceof SyntaxError || ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code))) {
                await sleep(15 * (attempt + 1));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

function clampInt(value, fallback, min, max) {
    if (value === undefined || value === null || value === '') return fallback;
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(num)));
}

function toBooleanFlag(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (['true', '1', 'yes'].includes(lower)) return true;
        if (['false', '0', 'no'].includes(lower)) return false;
    }
    return fallback;
}

function extractMediaMarkers(html) {
    return html.replace(/<img\b([^>]*)>/gi, (full, attrs) => {
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
        const alt = (altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '').trim();
        if (!src || /^data:/i.test(src)) return alt ? `[图片: ${alt}]` : '';
        return alt ? `[图片(${alt}): ${src}]` : `[图片: ${src}]`;
    });
}

function protectCodeRegions(text) {
    const tokens = [];
    const stash = match => {
        const token = `\uE000VCP_CODE_${tokens.length}\uE001`;
        tokens.push(match);
        return token;
    };
    let protectedText = text.replace(/(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g, stash);
    protectedText = protectedText.replace(/`[^`\r\n]+`/g, stash);
    return {
        protectedText,
        restore: value => value.replace(/\uE000VCP_CODE_(\d+)\uE001/g, (_, idx) => tokens[Number(idx)] ?? ''),
    };
}

function protectNonHtmlAngles(text) {
    let hasRealHtml = false;
    const htmlTokens = [];
    // 正向匹配合法标准 HTML/SVG 标签与注释，仅保留白名单内的真实标签，其余所有孤立 < 一律转义为文本
    const stashed = text.replace(
        /<!--[\s\S]*?-->|<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?)>/g,
        (full, slash = '', tag = '', tail = '') => {
            if (full.startsWith('<!--')) {
                hasRealHtml = true;
                const marker = `\uE002VCP_HTML_${htmlTokens.length}\uE003`;
                htmlTokens.push(full);
                return marker;
            }
            if (!HTML_TAG_NAMES.has(tag.toLowerCase()) || /[<,]/.test(tail)) {
                return full;
            }
            hasRealHtml = true;
            const marker = `\uE002VCP_HTML_${htmlTokens.length}\uE003`;
            htmlTokens.push(`<${slash}${tag}${tail}>`);
            return marker;
        }
    );
    const escaped = stashed
        .replace(/</g, '&lt;')
        .replace(/\uE002VCP_HTML_(\d+)\uE003/g, (_, idx) => htmlTokens[Number(idx)] ?? '');
    return { escaped, hasRealHtml };
}

function findBalancedToolResultEnd(text, start) {
    let depth = 1;
    let cursor = start + TOOL_RESULT_START_MARKER.length;
    while (cursor < text.length) {
        const nextOpen = text.indexOf(TOOL_RESULT_START_MARKER, cursor);
        const nextClose = text.indexOf(TOOL_RESULT_END_MARKER, cursor);
        if (nextClose < 0) return -1;
        if (nextOpen >= 0 && nextOpen < nextClose) {
            depth += 1;
            cursor = nextOpen + TOOL_RESULT_START_MARKER.length;
        } else {
            cursor = nextClose + TOOL_RESULT_END_MARKER.length;
            depth -= 1;
            if (depth === 0) return cursor;
        }
    }
    return -1;
}

function extractVisibleToolSnippets(rawText, maxChars = 600) {
    if (typeof rawText !== 'string' || !rawText.includes(TOOL_RESULT_START_MARKER)) return [];
    const snippets = [];
    let cursor = 0;
    while (cursor < rawText.length) {
        const start = rawText.indexOf(TOOL_RESULT_START_MARKER, cursor);
        if (start < 0) break;
        const end = findBalancedToolResultEnd(rawText, start);
        if (end < 0) break;
        const block = rawText.slice(start + TOOL_RESULT_START_MARKER.length, end - TOOL_RESULT_END_MARKER.length);
        const firstLine = block.split(/\r?\n/, 1)[0] || '';
        const hidden = /\[HIDDEN\]/i.test(firstLine) || /\n\s*-\s*注入上下文:\s*隐藏/.test(block);
        if (!hidden) {
            const match = /-\s*工具名称:\s*([^\r\n]+)\r?\n\s*-\s*执行状态:\s*([^\r\n]+)\r?\n\s*-\s*返回内容:\s*([\s\S]*)$/.exec(block);
            if (match) {
                const name = match[1].trim();
                const status = match[2].trim();
                let body = match[3].replace(/data:[^,\s"'<>]*;base64,[A-Za-z0-9+/_=-]*/gi, '').trim();
                if (body.length > maxChars) body = `${safeSlice(body, 0, maxChars)}…（已截断，总计 ${body.length} 字符）`;
                if (name && body) snippets.push({ name, status, body });
            }
        }
        cursor = end;
    }
    return snippets;
}

function decodeTopicRiverV2Block(text) {
    if (typeof text !== 'string') return '';
    return text.replace(
        /(?:\r?\n){2}\[VCP_TOPIC_RIVER_V2\]\r?\n([\s\S]+?)\r?\n\[\/VCP_TOPIC_RIVER_V2\]((?:\r?\n){2}\[该发言发送自[^\r\n\]]+话题\])?[ \t\r\n]*$/,
        (_full, body, footer = '') => {
            const decoded = body.replace(/&#(\d{1,5});/g, (entity, digits) => {
                const code = Number(digits);
                return code <= 127 || code === 8232 || code === 8233 ? String.fromCharCode(code) : entity;
            });
            return `\n\n[随附上下文引用]\n${decoded}${footer}`;
        }
    );
}

function formatMessageAttachments(entry) {
    const items = Array.isArray(entry?.attachments) ? entry.attachments : [];
    const lines = [];
    for (const att of items) {
        if (!att || typeof att !== 'object') continue;
        const name = att.name || att.fileName || att.filename || '附件';
        const ref = att.url || att.path || att.filePath || '';
        if (ref && !/^data:/i.test(ref)) lines.push(`[附件(${name}): ${ref}]`);
        else if (name) lines.push(`[附件: ${name}]`);
    }
    return lines;
}

function extractRawEntryContent(entry) {
    if (typeof entry?.content === 'string') return entry.content;
    if (Array.isArray(entry?.content)) {
        return entry.content
            .map(part => {
                if (part?.type === 'text' && typeof part.text === 'string') return part.text;
                if (part?.type === 'image_url') {
                    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                    if (url && !/^data:/i.test(url)) return `[图片: ${url}]`;
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (entry?.content && typeof entry.content === 'object') return entry.content.text || '';
    return '';
}

function stripIndependentNoticeShell(text, role) {
    if (role !== 'user' || typeof text !== 'string' || !text.includes('[系统通知]')) return text;
    return text.replace(
        /^[ \t]*\[系统通知\][ \t]*\r?\n[\s\S]*?^[ \t]*\[系统通知结束\][ \t]*(?=\r?\n|$)(?:\r?\n)?/gm,
        ''
    );
}

function normalizeEntryText(entry, includeTools = false) {
    let raw = extractRawEntryContent(entry);
    const toolSnippets = includeTools ? extractVisibleToolSnippets(raw) : [];
    raw = stripIndependentNoticeShell(raw, entry?.role);
    const cleaned = decodeTopicRiverV2Block(cleanHtmlContent(raw));
    const attachmentLines = formatMessageAttachments(entry);
    const parts = [];
    if (cleaned) parts.push(cleaned);
    if (toolSnippets.length) {
        parts.push(toolSnippets.map(t => `[工具回执 · ${t.name} | ${t.status}]\n${t.body}`).join('\n\n'));
    }
    if (attachmentLines.length) parts.push(attachmentLines.join('\n'));
    return {
        text: parts.join('\n\n').trim(),
        toolCount: extractVisibleToolSnippets(extractRawEntryContent(entry), 200).length,
        attachmentCount: attachmentLines.length,
    };
}

function resolveSpeakerName(entry, agentInfo, userName) {
    if (entry?.role === 'user') return entry.name || userName;
    return entry?.name || entry?.speakerName || entry?._metadata?.speaker_name || agentInfo.name;
}

// 轻量骨架筛选：不跑 Cheerio，只过滤瞬态占位/私有载荷以确定稳定楼层 seq，供惰性切片按需清洗
function prepareTurns(history, agentInfo, userName) {
    const entries = [];
    for (const entry of history) {
        if (!entry || !entry.role || entry.isThinking === true) continue;
        if (entry.content === undefined && !Array.isArray(entry.attachments)) continue;
        const raw = extractRawEntryContent(entry);
        const hasAttachments = Array.isArray(entry.attachments) && entry.attachments.length > 0;
        if (/^\s*<!--\s*VCP_TOOL_PAYLOAD\s*-->/.test(raw) && !hasAttachments) continue;
        const strippedNotice = stripIndependentNoticeShell(raw, entry.role).trim();
        if (!strippedNotice && !hasAttachments) continue;
        entries.push({
            seq: entries.length + 1,
            entry,
            role: entry.role,
            speaker: resolveSpeakerName(entry, agentInfo, userName),
            timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
            rawLength: raw.length,
        });
    }
    return entries;
}

function hydrateTurn(item, includeTools = false) {
    const { text, toolCount, attachmentCount } = normalizeEntryText(item.entry, includeTools);
    return {
        seq: item.seq,
        role: item.role,
        speaker: item.speaker,
        timestamp: item.timestamp,
        text,
        chars: text.length,
        toolCount,
        attachmentCount,
    };
}

// --- 主逻辑 ---
async function main() {
    try {
        const input = await readStdin();
        const args = parseToolArgs(input);
        const VchatDataURL = path.join(__dirname, '..', '..', '..', 'AppData');
        const result = await executeTopicMemo(args, { vchatDataDir: VchatDataURL });
        console.log(JSON.stringify({ status: 'success', result }));
    } catch (error) {
        console.error(JSON.stringify({ status: 'error', error: `[TopicMemo] ${error.message}` }));
        process.exit(1);
    }
}

async function executeTopicMemo(args = {}, { vchatDataDir } = {}) {
    const VchatDataURL = vchatDataDir || path.join(__dirname, '..', '..', '..', 'AppData');
    const command = args.command || (args.topic_id ? 'GetTopicContent' : 'ListTopics');
    const hasExplicitOwner = Boolean(args.maid || args.group);
    const maidName = args.maid || args.group || args.query;
    const topicId = args.topic_id;

    if (!['ListTopics', 'OutlineTopic', 'SearchTopic', 'GetTopicContent'].includes(command)) {
        throw new Error(`未知的指令: ${command}，支持的指令: ListTopics, OutlineTopic, SearchTopic, GetTopicContent`);
    }

    let agentInfo = null;
    if (maidName && !(command !== 'ListTopics' && topicId && !hasExplicitOwner)) {
        agentInfo = await findAgentInfo(VchatDataURL, maidName);
    }
    if (!agentInfo && command !== 'ListTopics' && topicId) {
        agentInfo = await findOwnerByTopicId(VchatDataURL, topicId);
    }
    if (!agentInfo) {
        if (!maidName) throw new Error("请求中缺少 'maid' 参数。");
        throw new Error(`未找到名为 "${maidName}" 的Agent或群组。`);
    }

    if (command === 'ListTopics') {
        const listArgs = hasExplicitOwner ? args : { ...args, query: undefined };
        return listTopics(agentInfo, listArgs);
    }

    if (!topicId) throw new Error("请求中缺少 'topic_id' 参数。");
    if (!agentInfo.topics.some(t => t && t.id === topicId)) {
        const resolvedOwner = await findOwnerByTopicId(VchatDataURL, topicId);
        if (resolvedOwner) agentInfo = resolvedOwner;
    }

    const userName = await findUserName(VchatDataURL);
    if (command === 'OutlineTopic') return outlineTopic(VchatDataURL, agentInfo, topicId, userName, args);
    if (command === 'SearchTopic') return searchTopic(VchatDataURL, agentInfo, topicId, userName, args);
    return getTopicContent(VchatDataURL, agentInfo, topicId, userName, args);
}

// --- 辅助函数 ---

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => resolve(data));
    });
}

function parseToolArgs(input) {
    let args;
    try {
        args = JSON.parse(input);
    } catch {
        console.error(JSON.stringify({ status: 'error', error: `[TopicMemo] 无效的输入格式，无法解析JSON: ${input}` }));
        process.exit(1);
    }
    if (args.topicId) {
        args.topic_id = args.topicId;
        delete args.topicId;
    }
    if (args.TopicId) {
        args.topic_id = args.TopicId;
        delete args.TopicId;
    }
    return args;
}

async function loadAllOwners(vchatPath) {
    const roots = [
        { dir: path.join(vchatPath, 'Agents'), type: 'agent' },
        { dir: path.join(vchatPath, 'AgentGroups'), type: 'group' },
    ];
    const owners = [];
    for (const { dir, type } of roots) {
        let folders = [];
        try {
            folders = await fs.readdir(dir);
        } catch (e) {
            if (e.code === 'ENOENT') continue;
            if (type === 'agent') throw new Error('无法读取 Agents 目录。');
            continue;
        }
        for (const folder of folders) {
            const configPath = path.join(dir, folder, 'config.json');
            try {
                const config = await readJsonWithRetry(configPath, 1);
                if (config && typeof config.name === 'string') {
                    owners.push({
                        name: config.name,
                        uuid: folder,
                        type,
                        topics: Array.isArray(config.topics) ? config.topics : [],
                    });
                }
            } catch {
                // 忽略无效的 config.json 文件
            }
        }
    }
    return owners;
}

async function findAgentInfo(vchatPath, maidName) {
    const requested = String(maidName || '').trim();
    const requestedLower = requested.toLowerCase();
    const owners = await loadAllOwners(vchatPath);

    const exactId = owners.find(o => o.uuid === requested);
    if (exactId) return exactId;

    const exactName = owners.find(o => o.name.toLowerCase() === requestedLower);
    if (exactName) return exactName;

    const partial = owners.find(o =>
        o.name.toLowerCase().includes(requestedLower) || requestedLower.includes(o.name.toLowerCase())
    );
    return partial || null;
}

async function findOwnerByTopicId(vchatPath, topicId) {
    const owners = await loadAllOwners(vchatPath);
    return owners.find(o => o.topics.some(t => t && t.id === topicId)) || null;
}

async function findUserName(vchatPath) {
    const settingsPath = path.join(vchatPath, 'settings.json');
    try {
        const settings = await readJsonWithRetry(settingsPath, 1);
        return settings.userName || '主人';
    } catch {
        return '主人';
    }
}

async function loadTopicHistory(vchatPath, agentInfo, topicId) {
    const topicInfo = agentInfo.topics.find(t => t && t.id === topicId);
    if (!topicInfo) {
        throw new Error(`未找到 ID 为 "${topicId}" 的话题。可用的话题ID请先使用 ListTopics 指令查询。`);
    }
    const historyPath = path.join(vchatPath, 'UserData', agentInfo.uuid, 'topics', topicId, 'history.json');
    let history;
    try {
        const rawData = await readJsonWithRetry(historyPath, 2);
        if (Array.isArray(rawData)) {
            history = rawData;
        } else if (rawData && Array.isArray(rawData.messages)) {
            history = rawData.messages;
        } else {
            history = [];
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`话题 "${topicInfo.name}" 的聊天记录文件不存在。`);
        }
        throw new Error(`无法读取话题 "${topicInfo.name}" 的聊天记录: ${error.message}`);
    }
    return { topicInfo, history };
}

// --- 指令1: 列出所有话题（支持关键词过滤、未读筛选与分页） ---
async function listTopics(agentInfo, options = {}) {
    const allTopics = (Array.isArray(agentInfo.topics) ? agentInfo.topics : []).filter(t => t && t.id);
    if (allTopics.length === 0) {
        return `[TopicMemo] ${agentInfo.name} 暂无任何话题记录。`;
    }

    const queryText = typeof options.query === 'string' && options.query.trim() && options.query.trim() !== agentInfo.name
        ? options.query.trim().toLowerCase()
        : (typeof options.keyword === 'string' ? options.keyword.trim().toLowerCase() : '');
    const unreadOnly = toBooleanFlag(options.unreadOnly ?? options.unread_only, false);
    const hasPaging = options.limit !== undefined || options.offset !== undefined || Boolean(queryText) || unreadOnly;

    let items = [...allTopics];
    if (unreadOnly) items = items.filter(t => t.unread === true);
    if (queryText) {
        items = items.filter(t =>
            String(t.name || '').toLowerCase().includes(queryText) ||
            String(t.id || '').toLowerCase().includes(queryText)
        );
    }

    const totalMatched = items.length;
    const offset = clampInt(options.offset, 0, 0, Math.max(0, totalMatched));
    const limit = hasPaging
        ? clampInt(options.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
        : allTopics.length;
    const page = items.slice(offset, offset + limit);

    let result = `## ${agentInfo.name} 的话题列表\n\n`;
    result += `共 ${allTopics.length} 个话题`;
    if (queryText || unreadOnly) result += `，筛选命中 ${totalMatched} 个`;
    if (page.length < totalMatched || offset > 0) {
        result += `（当前展示第 ${offset + 1}–${offset + page.length} 个）`;
    }
    result += '：\n\n';

    if (page.length === 0) {
        return `${result}（无匹配话题）`;
    }

    page.forEach((topic, idx) => {
        const createdDate = Number.isFinite(topic.createdAt)
            ? new Date(topic.createdAt).toLocaleString('zh-CN', {
                year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            })
            : '未知时间';
        const unreadTag = topic.unread === true ? ' [未读]' : '';
        result += `${offset + idx + 1}. **${topic.name || '(未命名话题)'}**${unreadTag}\n`;
        result += `   - ID: \`${topic.id}\`\n`;
        result += `   - 创建时间: ${createdDate}\n\n`;
    });

    if (offset + page.length < totalMatched) {
        result += `_提示：后续还有 ${totalMatched - offset - page.length} 个话题，可传 offset=${offset + page.length} 继续翻页，或传 query 关键词过滤。_\n`;
    }
    return result;
}

// --- 指令2: 话题楼层大纲（两阶段惰性解析，仅对窗口内楼层执行 DOM 提纯） ---
async function outlineTopic(vchatPath, agentInfo, topicId, userName, options = {}) {
    const { topicInfo, history } = await loadTopicHistory(vchatPath, agentInfo, topicId);
    const prepared = prepareTurns(history, agentInfo, userName);
    const total = prepared.length;
    if (total === 0) {
        return `## 话题大纲：${topicInfo.name}\n\n该话题暂无有效对话楼层。`;
    }

    const limit = clampInt(options.limit, DEFAULT_OUTLINE_LIMIT, 1, MAX_OUTLINE_LIMIT);
    let startSeq = clampInt(options.startSeq ?? options.start_seq, Math.max(1, total - limit + 1), 1, total);
    let endSeq = clampInt(options.endSeq ?? options.end_seq, Math.min(total, startSeq + limit - 1), startSeq, total);
    if (endSeq - startSeq + 1 > MAX_OUTLINE_LIMIT) endSeq = startSeq + MAX_OUTLINE_LIMIT - 1;

    const sliced = prepared.slice(startSeq - 1, endSeq).map(item => hydrateTurn(item, false));
    const createdDate = Number.isFinite(topicInfo.createdAt)
        ? new Date(topicInfo.createdAt).toLocaleString('zh-CN')
        : '未知时间';

    const lines = [
        `## 话题大纲：${topicInfo.name}`,
        `所属：${agentInfo.name} | ID: \`${topicId}\` | 创建时间：${createdDate} | 有效楼层：${total} 条（当前大纲 #${startSeq}..#${endSeq}）`,
        '',
        '---',
        '',
    ];

    for (const turn of sliced) {
        const timeStr = turn.timestamp ? new Date(turn.timestamp).toLocaleString('zh-CN', { hour12: false }) : '-';
        const firstLine = (turn.text.split(/\r?\n/).find(l => l.trim()) || '').trim().replace(/\s+/g, ' ');
        const preview = firstLine.length > 80 ? `${safeSlice(firstLine, 0, 80)}…` : firstLine;
        const extras = [];
        if (turn.toolCount > 0) extras.push(`工具×${turn.toolCount}`);
        if (turn.attachmentCount > 0) extras.push(`附件×${turn.attachmentCount}`);
        const extraTag = extras.length ? ` [${extras.join(', ')}]` : '';
        lines.push(`- #${turn.seq} | ${turn.speaker} (${turn.role}) | ${timeStr} | ${turn.chars}字${extraTag}：${preview || '（纯媒体/空文本）'}`);
    }

    if (startSeq > 1 || endSeq < total) {
        lines.push('', `_大纲翻页：可传 startSeq / endSeq 查阅前序或后续楼层，再用 GetTopicContent(startSeq, endSeq) 点读正文。_`);
    }
    return lines.join('\n');
}

// --- 指令3: 话题内检索楼层（渐进暴露 L2 + ReDoS 防御） ---
async function searchTopic(vchatPath, agentInfo, topicId, userName, options = {}) {
    const query = String(options.query || '').trim();
    if (!query) throw new Error("SearchTopic 缺少 'query' 参数。");

    const { topicInfo, history } = await loadTopicHistory(vchatPath, agentInfo, topicId);
    const includeTools = toBooleanFlag(options.includeTools ?? options.include_tools, true);
    const prepared = prepareTurns(history, agentInfo, userName);
    const isRegex = toBooleanFlag(options.isRegex ?? options.is_regex, false);
    const caseSensitive = toBooleanFlag(options.caseSensitive ?? options.case_sensitive, false);
    const maxResults = clampInt(options.maxResults ?? options.max_results, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

    let matcher = null;
    let fallbackLiteral = false;
    if (isRegex) {
        if (!isSafeRegexPattern(query)) {
            fallbackLiteral = true;
        } else {
            try {
                matcher = new RegExp(query, caseSensitive ? '' : 'i');
            } catch {
                fallbackLiteral = true;
            }
        }
    }
    const needle = caseSensitive ? query : query.toLowerCase();

    const hits = [];
    for (const item of prepared) {
        const turn = hydrateTurn(item, includeTools);
        const haystack = turn.text;
        let matchIndex = -1;
        let matchLen = query.length;
        if (matcher) {
            const m = matcher.exec(haystack);
            if (m) {
                matchIndex = m.index;
                matchLen = Math.max(1, m[0].length);
            }
        } else {
            const hay = caseSensitive ? haystack : haystack.toLowerCase();
            matchIndex = hay.indexOf(needle);
        }
        if (matchIndex >= 0) {
            const snippetStart = Math.max(0, matchIndex - 60);
            const snippetEnd = Math.min(haystack.length, matchIndex + matchLen + 140);
            const snippet = safeSlice(haystack, snippetStart, snippetEnd).replace(/\s+/g, ' ').trim();
            hits.push({
                seq: turn.seq,
                speaker: turn.speaker,
                role: turn.role,
                snippet: `${snippetStart > 0 ? '…' : ''}${snippet}${snippetEnd < haystack.length ? '…' : ''}`,
            });
            if (hits.length >= maxResults) break;
        }
    }

    const header = [
        `## 话题内检索：${topicInfo.name}`,
        `查询：\`${query}\`（共 ${prepared.length} 楼，命中 ${hits.length} 处${fallbackLiteral ? '，正则无效或存在回溯风险已回退字面匹配' : ''}）`,
        '',
    ];
    if (hits.length === 0) return `${header.join('\n')}未找到匹配楼层。`;
    for (const hit of hits) {
        header.push(`- **#${hit.seq}** ${hit.speaker} (${hit.role})：${hit.snippet}`);
    }
    header.push('', `_定位到目标楼层后，可调用 GetTopicContent(topic_id="${topicId}", startSeq=N, endSeq=M) 精读完整上下文。_`);
    return header.join('\n');
}

// --- 指令4: 获取话题内容（两阶段惰性提纯 + UTF-16 安全折叠 + 代码保护） ---
async function getTopicContent(vchatPath, agentInfo, topicId, userName, options = {}) {
    const { topicInfo, history } = await loadTopicHistory(vchatPath, agentInfo, topicId);
    const includeTools = toBooleanFlag(options.includeTools ?? options.include_tools, false);
    const prepared = prepareTurns(history, agentInfo, userName);
    const total = prepared.length;

    if (total === 0) {
        return `## 话题：${topicInfo.name}\n\n该话题暂无聊天记录。`;
    }

    const hasExplicitTail = options.tail !== undefined && options.tail !== null && options.tail !== '';
    const hasExplicitRange = (options.startSeq ?? options.start_seq ?? options.endSeq ?? options.end_seq) !== undefined;
    const totalRawChars = prepared.reduce((acc, t) => acc + t.rawLength, 0);

    let startSeq = 1;
    let endSeq = total;
    let windowMode = 'full';

    if (hasExplicitRange) {
        windowMode = 'range';
        startSeq = clampInt(options.startSeq ?? options.start_seq, 1, 1, total);
        endSeq = clampInt(options.endSeq ?? options.end_seq, total, startSeq, total);
    } else if (hasExplicitTail) {
        windowMode = 'tail';
        const tailN = clampInt(options.tail, DEFAULT_TAIL_COUNT, 1, total);
        startSeq = Math.max(1, total - tailN + 1);
        endSeq = total;
    } else if (total > AUTO_TAIL_MESSAGE_THRESHOLD || totalRawChars > AUTO_TAIL_CHAR_THRESHOLD) {
        windowMode = 'auto_tail';
        startSeq = Math.max(1, total - DEFAULT_TAIL_COUNT + 1);
        endSeq = total;
    }

    const defaultTurnCap = windowMode === 'range' ? EXPLICIT_SLICE_MAX_CHARS_PER_TURN : DEFAULT_MAX_CHARS_PER_TURN;
    const maxCharsPerTurn = clampInt(
        options.maxCharsPerTurn ?? options.max_chars_per_turn,
        defaultTurnCap,
        200,
        200000
    );

    const createdDate = Number.isFinite(topicInfo.createdAt)
        ? new Date(topicInfo.createdAt).toLocaleString('zh-CN')
        : '未知时间';

    let result = `## 话题：${topicInfo.name}\n`;
    result += `创建时间：${createdDate}\n`;
    result += `消息数量：${total} 条（当前展示第 #${startSeq}–#${endSeq} 楼`;
    if (windowMode === 'auto_tail') {
        result += `；长话题已自动截取尾部窗口，前文可用 OutlineTopic / SearchTopic 或 GetTopicContent(startSeq, endSeq) 翻阅`;
    }
    result += `）\n\n---\n\n`;

    const selected = prepared.slice(startSeq - 1, endSeq).map(item => hydrateTurn(item, includeTools));
    for (const turn of selected) {
        let body = turn.text;
        if (body.length > maxCharsPerTurn) {
            const headLen = Math.floor(maxCharsPerTurn * 0.75);
            const tailLen = Math.max(100, maxCharsPerTurn - headLen);
            body = `${safeSlice(body, 0, headLen)}\n\n…［第 #${turn.seq} 楼单条内容共 ${body.length} 字，中段已按 maxCharsPerTurn=${maxCharsPerTurn} 折叠，可传更大 maxCharsPerTurn 查看全文］…\n\n${safeSlice(body, body.length - tailLen, body.length)}`;
        }
        result += `### [#${turn.seq}] ${turn.speaker}\n${body}\n\n`;
    }

    return result;
}

// --- HTML 内容清理（代码区隔离 ➔ 媒体转换 ➔ 非HTML泛型转义保护 ➔ Cheerio 降噪 ➔ 无损还原） ---
function cleanHtmlContent(htmlContent) {
    if (htmlContent && typeof htmlContent === 'object') htmlContent = htmlContent.text;
    if (!htmlContent || typeof htmlContent !== 'string') {
        return '';
    }

    let text = projectMemoryProtocols(htmlContent);
    if (!text) return '';

    const { protectedText, restore } = protectCodeRegions(text);
    let working = extractMediaMarkers(protectedText);
    const { escaped, hasRealHtml } = protectNonHtmlAngles(working);
    working = escaped;

    if (!hasRealHtml) {
        return restore(working.replace(/&lt;/g, '<').replace(/&gt;/g, '>')).trim();
    }

    try {
        const $ = cheerio.load(working, {
            decodeEntities: true,
            xmlMode: false,
        });
        $('style').remove();
        $('script').remove();
        $('[style]').removeAttr('style');
        $('[class]').removeAttr('class');

        let extracted = $.text();
        extracted = extracted
            .replace(/[\r\n]+/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n /g, '\n')
            .replace(/ \n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        return restore(extracted).trim();
    } catch {
        const fallback = working
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, '')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/[ \t]+/g, ' ')
            .trim();
        return restore(fallback).trim();
    }
}

if (require.main === module) main();
module.exports = {
    cleanHtmlContent,
    getTopicContent,
    outlineTopic,
    searchTopic,
    loadTopicHistory,
    findAgentInfo,
    findOwnerByTopicId,
    findUserName,
    listTopics,
    executeTopicMemo,
    readJsonWithRetry,
    safeSlice,
};