// Groupmodules/modes/natureRandomMode.js
// 自然随机发言模式 - 基于 Tag 匹配、@提及、概率等规则决定发言者

const BaseChatMode = require('./baseChatMode');

class NatureRandomMode extends BaseChatMode {
    constructor() {
        super('naturerandom');
    }

    /**
     * 自然随机模式：根据 @提及、Tag 匹配、概率等规则决定哪些 Agent 发言
     * 
     * @param {Array<object>} activeMembersConfigs - 活跃成员配置数组
     * @param {Array<object>} history - 聊天历史
     * @param {object} groupConfig - 群组配置
     * @param {object} userMessageEntry - 用户消息
     * @returns {Array<object>} 需要发言的 Agent 配置数组，按发言顺序排列
     */
    determineSpeakers(activeMembersConfigs, history, groupConfig, userMessageEntry) {
        const speakers = [];
        const spokenThisTurn = new Set(); // 存储已确定发言的 Agent ID
        const userMessageText = (userMessageEntry.content && typeof userMessageEntry.content === 'string')
                                ? userMessageEntry.content.toLowerCase()
                                : "";

        // 修复2：排除最后一项（当前用户消息），contextText 只代表纯历史上下文。
        // 当前用户消息通过 userMessageText 独立检测，避免与历史上下文混淆，
        // 防止"旧话题残留在窗口"与"当前消息提及"无法区分的问题。
        const CONTEXT_WINDOW = 8;
        const recentHistory = history.slice(-(CONTEXT_WINDOW + 1), -1);
        const contextText = recentHistory
            .map(msg => {
                const rawContent = typeof msg.content === 'string' ? msg.content : (msg.content?.text || '');
                return rawContent.replace(/^\[.*?的发言\]:\s*/, '');
            })
            .join(' \n ')
            .toLowerCase();

        // 读取发言触发模式，默认 strict（向后兼容）
        const tagMatchMode = groupConfig.tagMatchMode || 'strict';

        // 优先级1: @角色名 (直接在最新消息中匹配) — 两种模式相同
        this._matchDirectMentions(activeMembersConfigs, userMessageText, speakers, spokenThisTurn);

        // 优先级2: Tag 匹配 — 行为因模式而异
        this._matchTags(activeMembersConfigs, userMessageText, contextText, recentHistory, history, groupConfig, tagMatchMode, speakers, spokenThisTurn);

        // 优先级3: @所有人 (在最新消息中匹配) — 两种模式相同
        this._matchMentionAll(activeMembersConfigs, userMessageText, speakers, spokenThisTurn);

        // 优先级4: 概率发言（对于未被上述规则触发的）
        this._probabilisticSpeakers(activeMembersConfigs, contextText, groupConfig, tagMatchMode, speakers, spokenThisTurn);

        // 优先级5: 保底发言（如果以上都没有触发任何 Agent）
        this._fallbackSpeaker(activeMembersConfigs, contextText, groupConfig, speakers, spokenThisTurn);

        // 排序优化：Tag 在用户最新发言中命中的角色排在最前
        this._sortByRelevance(speakers, userMessageText, contextText, groupConfig);

        console.log(`[NatureRandom] Mode: ${tagMatchMode}. Speakers: ${speakers.map(s => s.name).join(', ')}`);
        return speakers;
    }

    /**
     * 优先级1: @角色名直接提及
     */
    _matchDirectMentions(activeMembersConfigs, userMessageText, speakers, spokenThisTurn) {
        activeMembersConfigs.forEach(memberConfig => {
            if (userMessageText.includes(`@${memberConfig.name.toLowerCase()}`)) {
                if (!spokenThisTurn.has(memberConfig.id)) {
                    speakers.push(memberConfig);
                    spokenThisTurn.add(memberConfig.id);
                    console.log(`[NatureRandom] @${memberConfig.name} triggered by direct mention.`);
                }
            }
        });
    }

    /**
     * 优先级2: Tag 匹配（strict 和 natural 两种模式）
     */
    _matchTags(activeMembersConfigs, userMessageText, contextText, recentHistory, history, groupConfig, tagMatchMode, speakers, spokenThisTurn) {
        activeMembersConfigs.forEach(memberConfig => {
            if (spokenThisTurn.has(memberConfig.id)) return;

            const tagsString = groupConfig.memberTags ? groupConfig.memberTags[memberConfig.id] : '';
            if (!tagsString) return;
            const tags = tagsString.split(/,|，/).map(t => t.trim().toLowerCase()).filter(t => t);

            if (tagMatchMode === 'natural') {
                this._matchTagsNatural(memberConfig, tags, userMessageText, recentHistory, history, speakers, spokenThisTurn);
            } else {
                this._matchTagsStrict(memberConfig, tags, userMessageText, contextText, speakers, spokenThisTurn);
            }
        });
    }

    /**
     * Natural 模式的 Tag 匹配：按 tag 来源分档处理
     */
    _matchTagsNatural(memberConfig, tags, userMessageText, recentHistory, history, speakers, spokenThisTurn) {
        // 检查 tag 是否出现在历史上其他人（其他 Agent 或历史用户消息）的消息中
        const tagInHistoricalOtherMessages = recentHistory
            .filter(msg => msg.agentId !== memberConfig.id)
            .some(msg => {
                const content = (typeof msg.content === 'string'
                    ? msg.content : (msg.content?.text || ''))
                    .replace(/^\[.*?的发言\]:\s*/, '')
                    .toLowerCase();
                return tags.some(tag => content.includes(tag));
            });

        // 修复2：当前用户消息独立检测，是最强的外部信号
        const tagInCurrentUserMessage = tags.some(tag => userMessageText.includes(tag));

        const tagInOtherMessages = tagInHistoricalOtherMessages || tagInCurrentUserMessage;

        // 检查 tag 是否仅出现在自身历史消息中（自我污染场景）
        const tagOnlyInOwnMessages = !tagInOtherMessages &&
            recentHistory
                .filter(msg => msg.agentId === memberConfig.id)
                .some(msg => {
                    const content = (typeof msg.content === 'string'
                        ? msg.content : (msg.content?.text || '')).toLowerCase();
                    return tags.some(tag => content.includes(tag));
                });

        if (tags.some(tag => userMessageText.includes(`@${tag}`))) {
            // @tag 直接提及 → 强信号，100% 触发
            speakers.push(memberConfig);
            spokenThisTurn.add(memberConfig.id);
            console.log(`[NatureRandom/Natural] @tag trigger for ${memberConfig.name}.`);

        } else if (tagInOtherMessages) {
            // tag 来自用户或其他 Agent → 话题真实相关，100% 触发
            speakers.push(memberConfig);
            spokenThisTurn.add(memberConfig.id);
            console.log(`[NatureRandom/Natural] Tag in others' messages, triggering ${memberConfig.name}.`);

        } else if (tagOnlyInOwnMessages) {
            // tag 仅来自自身历史消息 → 动态概率（区分"话题延续"与"自我污染"）
            const lastAiMsg = [...history].slice(0, -1).reverse()
                .find(msg => msg.role === 'assistant');
            const isLastSpeaker = lastAiMsg?.agentId === memberConfig.id;
            const ownMsgCount = recentHistory
                .filter(msg => msg.agentId === memberConfig.id).length;

            // isLastSpeaker=true: 刚发言，用户可能在延续对话，概率随发言次数递增，上限 0.75
            // isLastSpeaker=false: 更可能是自我污染，保持低概率
            const speakChance = isLastSpeaker
                ? Math.min(0.5 + ownMsgCount * 0.1, 0.75)
                : 0.2;

            if (Math.random() < speakChance) {
                speakers.push(memberConfig);
                spokenThisTurn.add(memberConfig.id);
                console.log(`[NatureRandom/Natural] Self-context trigger for ${memberConfig.name} (isLastSpeaker=${isLastSpeaker}, chance=${speakChance.toFixed(2)}).`);
            }
        }
    }

    /**
     * Strict 模式的 Tag 匹配：tag 在历史上下文 OR 在当前用户消息 → 100% 触发
     */
    _matchTagsStrict(memberConfig, tags, userMessageText, contextText, speakers, spokenThisTurn) {
        // 修复2：userMessageText.includes(tag) 显式替代原先通过 contextText 捕获当前消息 tag 的方式
        if (tags.some(tag => contextText.includes(tag) || userMessageText.includes(tag))) {
            speakers.push(memberConfig);
            spokenThisTurn.add(memberConfig.id);
            console.log(`[NatureRandom/Strict] Tag match for ${memberConfig.name}.`);
        }
    }

    /**
     * 优先级3: @所有人
     */
    _matchMentionAll(activeMembersConfigs, userMessageText, speakers, spokenThisTurn) {
        if (userMessageText.includes('@所有人')) {
            activeMembersConfigs.forEach(memberConfig => {
                if (!spokenThisTurn.has(memberConfig.id)) {
                    speakers.push(memberConfig);
                    spokenThisTurn.add(memberConfig.id);
                    console.log(`[NatureRandom] @所有人 triggered for ${memberConfig.name}.`);
                }
            });
        }
    }

    /**
     * 优先级4: 概率发言
     * 修复1：natural 模式禁用 contextText 提升
     */
    _probabilisticSpeakers(activeMembersConfigs, contextText, groupConfig, tagMatchMode, speakers, spokenThisTurn) {
        const nonTriggeredMembers = activeMembersConfigs.filter(member => !spokenThisTurn.has(member.id));
        const baseRandomSpeakProbability = 0.15;

        nonTriggeredMembers.forEach(memberConfig => {
            let speakChance = baseRandomSpeakProbability;

            if (tagMatchMode === 'strict') {
                // strict 模式保留 contextText 提升（向后兼容）
                const tagsString = groupConfig.memberTags ? groupConfig.memberTags[memberConfig.id] : '';
                if (tagsString) {
                    const tags = tagsString.split(/,|，/).map(t => t.trim().toLowerCase()).filter(t => t);
                    if (tags.some(tag => contextText.includes(tag))) {
                        speakChance = 0.85;
                        console.log(`[NatureRandom/Strict] Increased speak probability for ${memberConfig.name}.`);
                    }
                }
            }
            // natural 模式：只用基础 15%，不做 tag 提升

            if (Math.random() < speakChance) {
                speakers.push(memberConfig);
                spokenThisTurn.add(memberConfig.id);
                console.log(`[NatureRandom] Probabilistic speak for ${memberConfig.name} (chance=${speakChance.toFixed(2)}).`);
            }
        });
    }

    /**
     * 优先级5: 保底发言（如果以上都没有触发任何 Agent）
     * 修复3：speakers.length === 0 时 spokenThisTurn 必然为空
     */
    _fallbackSpeaker(activeMembersConfigs, contextText, groupConfig, speakers, spokenThisTurn) {
        if (speakers.length === 0 && activeMembersConfigs.length > 0) {
            const relevantMembers = activeMembersConfigs.filter(m => {
                const tagsString = groupConfig.memberTags ? groupConfig.memberTags[m.id] : '';
                if (!tagsString) return false;
                const tags = tagsString.split(/,|，/).map(t => t.trim().toLowerCase()).filter(t => t);
                return tags.some(tag => contextText.includes(tag));
            });

            let fallbackSpeaker;
            if (relevantMembers.length > 0) {
                fallbackSpeaker = relevantMembers[Math.floor(Math.random() * relevantMembers.length)];
                console.log(`[NatureRandom] Fallback speaker (relevant): ${fallbackSpeaker.name}.`);
            } else {
                // 修复3：spokenThisTurn 为空，直接随机选取，无需额外过滤
                fallbackSpeaker = activeMembersConfigs[Math.floor(Math.random() * activeMembersConfigs.length)];
                console.log(`[NatureRandom] Fallback speaker (random): ${fallbackSpeaker.name}.`);
            }
            if (fallbackSpeaker) {
                speakers.push(fallbackSpeaker);
            }
        }
    }

    /**
     * 排序优化：Tag 在用户最新发言中命中的角色排在最前
     */
    _sortByRelevance(speakers, userMessageText, contextText, groupConfig) {
        speakers.sort((a, b) => {
            const getRelevance = (memberConfig) => {
                const tagsString = groupConfig.memberTags ? groupConfig.memberTags[memberConfig.id] : '';
                if (!tagsString) return 0;
                const tags = tagsString.split(/,|，/).map(t => t.trim().toLowerCase()).filter(t => t);
                if (tags.some(tag => userMessageText.includes(tag))) return 2;
                if (tags.some(tag => contextText.includes(tag))) return 1;
                return 0;
            };
            return getRelevance(b) - getRelevance(a);
        });
    }
}

module.exports = new NatureRandomMode();