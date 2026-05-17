// modules/tavernRulesEngine.js
// VCPChatTarven 通用规则引擎 - 纯逻辑，无 Electron 依赖
// 同时支持主进程（CommonJS）和渲染进程（window.TavernRulesEngine）
//
// 规则数据结构:
// {
//   id: string,
//   name: string,
//   type: 'system_suffix' | 'user_suffix' | 'context_inject',
//   enabled: boolean,
//   content: string,
//   scope: 'global' | 'agent' | 'group',
//   // context_inject 专用:
//   role: 'user' | 'assistant',
//   depth: number  // 0 = 上下文末尾, N = 倒数第 N+1 条之前
// }

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.TavernRulesEngine = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const INJECTION_HEADER = '[本信息由VCPChat客户端注入]';
    const INJECTION_FOOTER = '[临时注入结束]';

    /**
     * 用统一的标记包装注入文本
     * @param {string} content
     * @returns {string}
     */
    function wrapInjection(content) {
        const text = (content == null) ? '' : String(content);
        return INJECTION_HEADER + '\n' + text + '\n' + INJECTION_FOOTER;
    }

    /**
     * 根据规则的 wrap 字段决定是否包裹
     * @param {object} rule
     * @returns {string}
     */
    function renderRuleContent(rule) {
        const text = (rule && typeof rule.content === 'string') ? rule.content : '';
        const shouldWrap = !rule || rule.wrap !== false; // 默认包裹
        return shouldWrap ? wrapInjection(text) : text;
    }

    /**
     * 判定一条规则在给定场景下是否生效
     * @param {object} rule
     * @param {'agent'|'group'} scope
     */
    function isRuleActive(rule, scope) {
        if (!rule || rule.enabled === false) return false;
        const ruleScope = rule.scope || 'global';
        if (ruleScope === 'global') return true;
        return ruleScope === scope;
    }

    function filterRulesByType(rules, type, scope) {
        if (!Array.isArray(rules)) return [];
        return rules.filter(function (r) {
            return r && r.type === type && isRuleActive(r, scope) &&
                   typeof r.content === 'string' && r.content.trim() !== '';
        });
    }

    /**
     * 在系统提示词尾部追加 system_suffix 规则
     * @param {string} systemPromptContent
     * @param {Array} rules
     * @param {'agent'|'group'} scope
     * @returns {string}
     */
    function applySystemSuffix(systemPromptContent, rules, scope) {
        const matched = filterRulesByType(rules, 'system_suffix', scope);
        if (matched.length === 0) return systemPromptContent || '';
        const parts = [];
        if (systemPromptContent && systemPromptContent.trim()) {
            parts.push(systemPromptContent.trim());
        }
        for (let i = 0; i < matched.length; i++) {
            parts.push(renderRuleContent(matched[i]));
        }
        return parts.join('\n\n');
    }

    /**
     * 在本次用户消息文本尾部追加 user_suffix 规则
     * 注意：返回值仅用于 VCP 提交，不应写入历史
     * @param {string} userText
     * @param {Array} rules
     * @param {'agent'|'group'} scope
     * @returns {string}
     */
    function applyUserSuffix(userText, rules, scope) {
        const matched = filterRulesByType(rules, 'user_suffix', scope);
        if (matched.length === 0) return userText || '';
        const parts = [];
        if (userText && userText.trim()) {
            parts.push(userText);
        }
        for (let i = 0; i < matched.length; i++) {
            parts.push(renderRuleContent(matched[i]));
        }
        return parts.join('\n\n');
    }

    /**
     * 按 depth 把 context_inject 规则插入到消息数组（不含 system）
     * 复制后返回新数组，不修改输入
     *
     * @param {Array} messages 上下文消息数组（顺序：旧 -> 新）
     * @param {Array} rules
     * @param {'agent'|'group'} scope
     * @param {object} [options]
     * @param {function} [options.makeMessage] (role, contentText) => message  自定义生成消息节点的函数
     * @returns {Array}
     */
    function applyContextInject(messages, rules, scope, options) {
        const matched = filterRulesByType(rules, 'context_inject', scope);
        if (matched.length === 0 || !Array.isArray(messages)) {
            return Array.isArray(messages) ? messages.slice() : [];
        }

        const makeMessage = (options && typeof options.makeMessage === 'function')
            ? options.makeMessage
            : function (role, text) {
                return { role: role, content: text, __tavernInjected: true };
            };

        const result = messages.slice();
        // 按 depth 从大到小处理，避免索引错位
        const sorted = matched.slice().sort(function (a, b) {
            return (Number(b.depth) || 0) - (Number(a.depth) || 0);
        });

        for (let i = 0; i < sorted.length; i++) {
            const rule = sorted[i];
            const role = rule.role === 'assistant' ? 'assistant' : 'user';
            const depth = Math.max(0, Number(rule.depth) || 0);
            const insertIndex = Math.max(0, result.length - depth);
            result.splice(insertIndex, 0, makeMessage(role, renderRuleContent(rule)));
        }
        return result;
    }

    /**
     * 创建一条新规则的默认值
     * @param {string} type
     */
    function createDefaultRule(type) {
        const id = 'rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        const base = {
            id: id,
            name: '新规则',
            type: type || 'system_suffix',
            enabled: true,
            content: '',
            scope: 'global',
            wrap: true
        };
        if (type === 'context_inject') {
            base.role = 'user';
            base.depth = 0;
        }
        return base;
    }

    /**
     * 校验/规范化规则集合
     */
    function normalizeRuleStore(store) {
        const safe = (store && typeof store === 'object') ? store : {};
        const rules = Array.isArray(safe.rules) ? safe.rules : [];
        const normalized = rules
            .filter(function (r) { return r && typeof r === 'object'; })
            .map(function (r) {
                const t = ['system_suffix', 'user_suffix', 'context_inject'].indexOf(r.type) !== -1
                    ? r.type : 'system_suffix';
                const out = {
                    id: typeof r.id === 'string' && r.id ? r.id : ('rule_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
                    name: typeof r.name === 'string' ? r.name : '未命名规则',
                    type: t,
                    enabled: r.enabled !== false,
                    content: typeof r.content === 'string' ? r.content : '',
                    scope: ['global', 'agent', 'group'].indexOf(r.scope) !== -1 ? r.scope : 'global',
                    wrap: r.wrap !== false // 默认包裹
                };
                if (t === 'context_inject') {
                    out.role = r.role === 'assistant' ? 'assistant' : 'user';
                    out.depth = Math.max(0, Number(r.depth) || 0);
                }
                return out;
            });
        return { version: 1, rules: normalized };
    }

    return {
        INJECTION_HEADER: INJECTION_HEADER,
        INJECTION_FOOTER: INJECTION_FOOTER,
        wrapInjection: wrapInjection,
        renderRuleContent: renderRuleContent,
        isRuleActive: isRuleActive,
        applySystemSuffix: applySystemSuffix,
        applyUserSuffix: applyUserSuffix,
        applyContextInject: applyContextInject,
        createDefaultRule: createDefaultRule,
        normalizeRuleStore: normalizeRuleStore
    };
});