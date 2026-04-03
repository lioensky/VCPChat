// modules/contextSanitizer.js
// 上下文HTML标签转MD净化器模块

// 🔴 优化：将沉重的模块改为按需加载，防止阻塞主进程发送消息
let JSDOM = null;
let TurndownService = null;

/**
 * LRU缓存类，支持过期时间
 */
class LRUCache {
    constructor(maxSize = 100, ttl = 3600000) { // 默认最大100条，过期时间1小时
        this.maxSize = maxSize;
        this.ttl = ttl; // Time to live in milliseconds
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) {
            return null;
        }

        const item = this.cache.get(key);
        const now = Date.now();

        // 检查是否过期
        if (now - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }

        // LRU: 将访问的项移到最后（最新）
        this.cache.delete(key);
        this.cache.set(key, item);

        return item.value;
    }

    set(key, value) {
        // 如果已存在，先删除旧的
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }

        // 如果缓存已满，删除最旧的（第一个）
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        // 添加新项
        this.cache.set(key, {
            value: value,
            timestamp: Date.now()
        });
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

/**
 * 上下文净化器类
 */
class ContextSanitizer {
    constructor() {
        // 初始化 LRU 缓存，最大100条，1小时过期
        this.cache = new LRUCache(100, 3600000);

        this.turndownService = null;
    }

    /**
     * 延迟初始化 Turndown 和 JSDOM
     */
    _ensureService() {
        if (this.turndownService) return;

        console.log('[ContextSanitizer] Initializing heavy dependencies (JSDOM, Turndown)...');
        if (!JSDOM) JSDOM = require('jsdom').JSDOM;
        if (!TurndownService) TurndownService = require('turndown');

        this.turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*',
        });

        this.setupTurndownRules();
    }

    setupTurndownRules() {
        // 规则1：保留图片
        this.turndownService.addRule('preserveImages', {
            filter: 'img',
            replacement: (content, node) => {
                const src = node.getAttribute('src');
                const alt = node.getAttribute('alt') || '';
                if (src) {
                    return `<img src="${src}" alt="${alt}">`;
                }
                return '';
            }
        });

        // 规则2：保留多媒体
        this.turndownService.addRule('preserveMedia', {
            filter: ['audio', 'video'],
            replacement: (content, node) => {
                const tagName = node.nodeName.toLowerCase();
                const src = node.getAttribute('src');
                if (src) {
                    return `<${tagName} src="${src}"></${tagName}>`;
                }
                const sources = node.querySelectorAll('source');
                if (sources.length > 0) {
                    const firstSrc = sources[0].getAttribute('src');
                    if (firstSrc) {
                        return `<${tagName} src="${firstSrc}"></${tagName}>`;
                    }
                }
                return '';
            }
        });

        // 规则3：✅ 保留 VCP 特殊块（已美化的）
        // 优先级高于未美化的块
        this.turndownService.addRule('vcpPrettifiedBlocks', {
            filter: (node) => {
                if (node.nodeName !== 'PRE') return false;

                // ✅ jsdom 支持 classList
                return node.classList.contains('vcp-tool-use-bubble') ||
                    node.classList.contains('maid-diary-bubble');
            },
            replacement: (content, node) => {
                // ✅ 从 data-raw-content 获取原始内容
                const rawContent = node.getAttribute('data-raw-content');

                if (rawContent) {
                    // ✅ 直接返回原始内容，Turndown 不会对其进行转义
                    return rawContent;
                }

                console.warn('[ContextSanitizer] VCP special block missing data-raw-content:',
                    node.className, node.textContent.substring(0, 50));
                return ''; // 返回空，避免污染
            }
        });

        // 规则4：✅ 保留未美化但包含特殊标记的块
        this.turndownService.addRule('vcpRawBlocks', {
            filter: (node) => {
                if (node.nodeName !== 'PRE') return false;

                // 排除已美化的（由上面的规则处理）
                if (node.classList.contains('vcp-tool-use-bubble') ||
                    node.classList.contains('maid-diary-bubble')) {
                    return false;
                }

                // 检查是否包含特殊标记
                const text = node.textContent || '';
                return text.includes('<<<[TOOL_REQUEST]>>>') ||
                    text.includes('<<<DailyNoteStart>>>');
            },
            replacement: (content, node) => {
                const text = node.textContent || '';
                // ✅ 直接返回原始内容，Turndown 不会对其进行转义
                return text;
            }
        });

        // 规则5：清理 VCP 元思考链
        this.turndownService.addRule('vcpThoughtChains', {
            filter: (node) => {
                if (node.nodeName !== 'DIV') return false;
                return node.classList.contains('vcp-thought-chain-bubble');
            },
            replacement: (content, node) => {
                // 检查 TurndownService 实例上的自定义属性
                if (this.turndownService.keepThoughtChains) {
                    const title = node.getAttribute('data-thought-title') || '';
                    const titlePart = title ? `: "${title}"` : '';
                    return `\n\n[--- VCP元思考链${titlePart} ---]\n${content}\n[--- 元思考链结束 ---]\n\n`;
                }
                return '';
            }
        });
    }

    /**
     * 清理元思考链（明文形式）
     * @param {string} content - 原始内容
     * @returns {string} - 清理后的内容
     */
    stripThoughtChains(content) {
        if (typeof content !== 'string') return content;
        const THOUGHT_CHAIN_REGEX = /\[--- VCP元思考链(?::\s*"([^"]*)")?\s*---\][\s\S]*?\[--- 元思考链结束 ---\]/gs;
        const CONVENTIONAL_THOUGHT_REGEX = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
        return content.replace(THOUGHT_CHAIN_REGEX, '').replace(CONVENTIONAL_THOUGHT_REGEX, '');
    }

    /**
     * 生成缓存键
     * @param {string} content - 原始内容
     * @returns {string} - 缓存键（使用简单的哈希）
     */
    generateCacheKey(content) {
        // 使用简单的字符串哈希作为缓存键
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return `sanitized_${hash}_${content.length}`;
    }

    /**
     * 检查内容是否包含 HTML 标签
     * @param {string} content - 要检查的内容
     * @returns {boolean} - 是否包含 HTML
     */
    containsHTML(content) {
        if (typeof content !== 'string') return false;

        // 简单检查：是否包含 HTML 标签
        const htmlRegex = /<[^>]+>/;
        return htmlRegex.test(content);
    }

    /**
     * 净化单条消息内容：HTML -> Markdown
     * @param {string} content - 原始内容
     * @returns {string} - 净化后的内容
     */
    sanitizeContent(content, keepThoughtChains = false) {
        if (typeof content !== 'string' || !content.trim()) {
            return content;
        }

        // 如果不包含 HTML，直接返回
        if (!this.containsHTML(content)) {
            return content;
        }

        // 尝试从缓存获取
        const cacheKey = this.generateCacheKey(content + (keepThoughtChains ? '_keep' : '_strip'));
        const cached = this.cache.get(cacheKey);
        if (cached !== null) {
            console.log('[ContextSanitizer] Cache hit for content');
            return cached;
        }

        try {
            this._ensureService();

            // ✅ 使用 jsdom 解析
            const dom = new JSDOM(content);
            const body = dom.window.document.body;

            // 设置 Turndown 服务的临时状态
            this.turndownService.keepThoughtChains = keepThoughtChains;

            // ✅ 转换为 Markdown
            let markdown = this.turndownService.turndown(body);

            // 清理多余的空行（保留最多2个连续空行）
            markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

            // 存入缓存
            this.cache.set(cacheKey, markdown);

            console.log('[ContextSanitizer] Sanitized content, cached result');
            return markdown;

        } catch (error) {
            console.error('[ContextSanitizer] Error sanitizing content:', error);
            // 出错时返回原始内容
            return content;
        }
    }

    /**
     * 处理消息历史，根据深度设置净化 AI 消息
     * @param {Array} messages - 消息数组
     * @param {number} startDepth - 净化初始深度（0 = 处理所有，1 = 跳过最后1条AI消息）
     * @returns {Array} - 处理后的消息数组
     */
    sanitizeMessages(messages, startDepth = 2, keepThoughtChains = false) {
        if (!Array.isArray(messages) || messages.length === 0) {
            return messages;
        }

        // 找出所有 AI 消息的索引
        const aiMessageIndices = [];
        messages.forEach((msg, index) => {
            if (msg.role === 'assistant') {
                aiMessageIndices.push(index);
            }
        });

        if (aiMessageIndices.length === 0) {
            return messages; // 没有 AI 消息，直接返回
        }

        // 计算需要净化的 AI 消息索引
        // startDepth = 0: 处理所有 AI 消息
        // startDepth = 1: 跳过最后 1 条 AI 消息
        // startDepth = 2: 跳过最后 2 条 AI 消息（即从倒数第3条开始）
        const indicesToSanitize = new Set();

        if (startDepth === 0) {
            // 处理所有 AI 消息
            aiMessageIndices.forEach(idx => indicesToSanitize.add(idx));
        } else {
            // 只处理较早的 AI 消息
            const skipCount = Math.min(startDepth, aiMessageIndices.length);
            const processCount = aiMessageIndices.length - skipCount;

            for (let i = 0; i < processCount; i++) {
                indicesToSanitize.add(aiMessageIndices[i]);
            }
        }

        // 创建新的消息数组，对需要净化的消息进行处理
        const sanitizedMessages = messages.map((msg, index) => {
            if (!indicesToSanitize.has(index)) {
                return msg; // 不需要处理，直接返回
            }

            // 处理 content 字段
            let processedContent = msg.content;
            if (typeof processedContent === 'string') {
                processedContent = this.sanitizeContent(processedContent, keepThoughtChains);
            } else if (Array.isArray(processedContent)) {
                // 处理多模态内容（content 是数组的情况）
                processedContent = processedContent.map(part => {
                    if (part.type === 'text' && typeof part.text === 'string') {
                        return {
                            ...part,
                            text: this.sanitizeContent(part.text, keepThoughtChains)
                        };
                    }
                    return part; // 其他类型（如 image_url）保持不变
                });
            }

            // 🛡️ 严格脱敏：只构建包含必须字段的新对象
            const sanitizedMsg = {
                role: msg.role,
                content: processedContent
            };
            if (msg.name) sanitizedMsg.name = msg.name;
            if (msg.tool_calls) sanitizedMsg.tool_calls = msg.tool_calls;
            if (msg.tool_call_id) sanitizedMsg.tool_call_id = msg.tool_call_id;

            return sanitizedMsg;
        });

        console.log(`[ContextSanitizer] Processed ${indicesToSanitize.size} AI messages out of ${messages.length} total messages`);
        return sanitizedMessages;
    }

    /**
     * 清空缓存
     */
    clearCache() {
        this.cache.clear();
        console.log('[ContextSanitizer] Cache cleared');
    }

    /**
     * 获取缓存统计信息
     */
    getCacheStats() {
        return {
            size: this.cache.size(),
            maxSize: this.cache.maxSize,
            ttl: this.cache.ttl
        };
    }
}

// 创建单例实例
const contextSanitizer = new ContextSanitizer();

module.exports = contextSanitizer;