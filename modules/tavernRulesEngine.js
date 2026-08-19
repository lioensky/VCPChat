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
//   builtinKey?: string, // 官方预置的稳定覆盖键
//   isBuiltin?: boolean, // 仅运行时/UI 使用，不持久化
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

    // 官方预置只提供安全的能力开关，不代表默认授权。
    // 除基础输出能力外，其余权限均默认关闭；插件管理员等超高危权限不得进入此清单。
    const BUILTIN_RULES = Object.freeze([
        {
            id: 'builtin_agent_div_render',
            builtinKey: 'agent-div-render',
            name: 'Agent输出动画气泡',
            type: 'system_suffix',
            enabled: true,
            content: '输出规范要求：{{VarDivRender}}',
            scope: 'global',
            wrap: true
        },
        {
            id: 'builtin_flowlock',
            builtinKey: 'flowlock',
            name: '心流锁系统',
            type: 'system_suffix',
            enabled: false,
            content: `当前VCHAT支持心流锁系统————

一轮工具循环(请求工具-获得结果-请求工具-获得结果…)整体循环视为一个“单回复”，不触发心跳。只有当无工具调用的回合才视为回合结束，触发心流锁。
工具循环结束视为一个单回合锁，视为回复结束。触发心跳。
心流锁状态下你可以进入完全自主的行为模式，自己决策自己的行为。完全异步，支持后台窗口。

直接在回复末尾输入
[[Flowlock::Start]]  启动锁，然后你会进入自主心跳模式，核心启动流程，否则后续功能不触发
[[Flowlock::Stop]]  停止锁，关闭心跳
[[Flowlock::Complete]] 完成任务，会弹出通知提醒用户
[[Flowlock::Fail]] 主动放弃任务，会弹出通知提醒用户
[[Flowlock::NextHeartbeat::120]] 主动设置下一次心跳来临时间 (默认回复结束后2秒，120代表120秒后触发下一轮，仅支持秒判定)
[[Flowlock::NextPrompt]]...[[/Flowlock::NextPrompt]]  主动设置下一次心跳来临的提示词，否则是默认提示词。

所有锁占位符不可被工具请求格式或者代码块包裹，否则会忽略。

当然考虑到用户可能不在电脑前，可以使用工具通知用户。
tool_name:「始」AgentMessage「末」,
message:「始」当用户不在时，向用户的设备发送通知消息。「末」,
archery:「始」no_reply「末」`,
            scope: 'agent',
            wrap: false
        },
        {
            id: 'builtin_loom',
            builtinKey: 'loom',
            name: 'Loom权限',
            type: 'system_suffix',
            enabled: false,
            content: `启用Loom控制权限
{{VCPLoomController}}`,
            scope: 'global',
            wrap: true
        },
        {
            id: 'builtin_scriptorium',
            builtinKey: 'scriptorium',
            name: '文坊权限',
            type: 'system_suffix',
            enabled: false,
            content: `VCP文坊编辑权限
{{VCPScriptoriumCollaborator}}
该命令集全局支持串行指令（command1 / command2 / …）
除了基础的html动画和canvas动画，还支持anime.js与three.js，引用的cdn脚本源码会被自动替换为文档内核依赖本地源码，安全可靠。
在创建样式时，尤其是pptx样式，建议每页使用独立的slideid标注样式避免互相污染，除非确实需要全局样式广播。`,
            scope: 'global',
            wrap: true
        },
        {
            id: 'builtin_forbid_tools',
            builtinKey: 'forbid-tools',
            name: '禁用所有工具',
            type: 'system_suffix',
            enabled: false,
            content: '[[VCPToolUse=Forbidden]]',
            scope: 'agent',
            wrap: false
        },
        {
            id: 'builtin_vcp_desktop',
            builtinKey: 'vcp-desktop',
            name: 'VCP桌面权限',
            type: 'system_suffix',
            enabled: false,
            content: `VCP桌面相关
{{VarDesktop}}
[[VCP桌面知识日记本::TagMemo]]`,
            scope: 'agent',
            wrap: false
        },
        {
            id: 'builtin_server_auth_code',
            builtinKey: 'server-auth-code',
            name: '获取服务器验证码',
            type: 'system_suffix',
            enabled: false,
            content: `工具权限验证码-服务器验证码
{{USER_AUTH_CODE}}`,
            scope: 'agent',
            wrap: false
        },
        {
            id: 'builtin_window_control',
            builtinKey: 'window-control',
            name: '窗口控制权限',
            type: 'system_suffix',
            enabled: false,
            content: `窗口感知器
{{WindowSensor_Node}}
窗口控制器
{{VCPScreenPilot}}`,
            scope: 'agent',
            wrap: false
        },
        {
            id: 'builtin_html_media',
            builtinKey: 'html-media',
            name: '启用HTML多媒体权限',
            type: 'system_suffix',
            enabled: false,
            content: `启用Html多媒体生成功能
{{VCPMediaRenderer}}`,
            scope: 'global',
            wrap: true
        }
    ].map(function (rule) {
        return Object.freeze({ ...rule, isBuiltin: true });
    }));

    function cloneRule(rule) {
        return { ...rule };
    }

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
                if (typeof r.builtinKey === 'string' && r.builtinKey) {
                    out.builtinKey = r.builtinKey;
                }
                if (r.isBuiltin === true) {
                    out.isBuiltin = true;
                }
                if (t === 'context_inject') {
                    out.role = r.role === 'assistant' ? 'assistant' : 'user';
                    out.depth = Math.max(0, Number(r.depth) || 0);
                }
                return out;
            });
        return { version: 1, rules: normalized };
    }

    /**
     * 把官方预置与用户规则合并为运行时规则。
     * 稳定 builtinKey 优先；旧配置可用同名规则覆盖，避免升级后重复注入。
     */
    function mergeBuiltinRules(store) {
        const userStore = normalizeRuleStore(store);
        const unmatched = userStore.rules.slice();
        const mergedBuiltins = BUILTIN_RULES.map(function (builtin) {
            const overrideIndex = unmatched.findIndex(function (rule) {
                return rule.builtinKey === builtin.builtinKey ||
                    (!rule.builtinKey && rule.name === builtin.name);
            });
            if (overrideIndex === -1) return cloneRule(builtin);

            const override = unmatched.splice(overrideIndex, 1)[0];
            return {
                ...cloneRule(builtin),
                ...override,
                builtinKey: builtin.builtinKey,
                isBuiltin: true
            };
        });

        return {
            version: 2,
            rules: mergedBuiltins.concat(unmatched.map(function (rule) {
                const copy = cloneRule(rule);
                delete copy.isBuiltin;
                return copy;
            }))
        };
    }

    function comparableRule(rule) {
        return {
            name: rule.name,
            type: rule.type,
            enabled: rule.enabled !== false,
            content: rule.content,
            scope: rule.scope || 'global',
            wrap: rule.wrap !== false,
            ...(rule.type === 'context_inject'
                ? { role: rule.role === 'assistant' ? 'assistant' : 'user', depth: Math.max(0, Number(rule.depth) || 0) }
                : {})
        };
    }

    /**
     * 保存前移除未修改的官方预置，只把用户覆盖项写入用户文件。
     */
    function compactRuleStore(store) {
        const normalized = normalizeRuleStore(store);
        const rules = normalized.rules.reduce(function (result, rule) {
            const builtin = BUILTIN_RULES.find(function (candidate) {
                return candidate.builtinKey === rule.builtinKey ||
                    (!rule.builtinKey && candidate.name === rule.name);
            });
            if (!builtin) {
                const custom = cloneRule(rule);
                delete custom.isBuiltin;
                result.push(custom);
                return result;
            }

            if (JSON.stringify(comparableRule(rule)) !== JSON.stringify(comparableRule(builtin))) {
                const override = cloneRule(rule);
                override.builtinKey = builtin.builtinKey;
                delete override.isBuiltin;
                result.push(override);
            }
            return result;
        }, []);
        return { version: 2, rules };
    }

    return {
        INJECTION_HEADER: INJECTION_HEADER,
        INJECTION_FOOTER: INJECTION_FOOTER,
        BUILTIN_RULES: BUILTIN_RULES,
        wrapInjection: wrapInjection,
        renderRuleContent: renderRuleContent,
        isRuleActive: isRuleActive,
        applySystemSuffix: applySystemSuffix,
        applyUserSuffix: applyUserSuffix,
        applyContextInject: applyContextInject,
        createDefaultRule: createDefaultRule,
        normalizeRuleStore: normalizeRuleStore,
        mergeBuiltinRules: mergeBuiltinRules,
        compactRuleStore: compactRuleStore
    };
});