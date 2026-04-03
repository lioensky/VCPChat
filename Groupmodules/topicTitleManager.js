// Groupmodules/topicTitleManager.js
// 话题标题自动生成管理模块 - 从 groupchat.js 中独立出来，方便后续优化

const fs = require('fs-extra');

// 话题总结相关常量
const MIN_MESSAGES_FOR_SUMMARY = 4;
const DEFAULT_TOPIC_NAMES = ["主要群聊"]; // 也可以包含 "新话题" 的模式匹配

/**
 * 清理和格式化从AI获取的话题标题
 * @param {string} rawTitle - AI返回的原始标题
 * @returns {string} 清理后的标题
 */
function cleanSummarizedTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') return "AI总结话题";

    let cleanedTitle = rawTitle.split('\n')[0].trim(); // 取第一行
    // 移除常见标点、数字编号、特定前后缀
    cleanedTitle = cleanedTitle.replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s（）()-]/g, ''); // 保留一些常用括号
    cleanedTitle = cleanedTitle.replace(/^\s*[\d①②③④⑤⑥⑦⑧⑨⑩❶❷❸❹❺❻❼❽❾❿一二三四五六七八九十]+\s*[\.\uff0e\s、]\s*/, ''); // 移除 "1. ", "①. " 等
    cleanedTitle = cleanedTitle.replace(/^(话题|标题|总结|Topic|Title|Summary)[:：\s]*/i, '');
    cleanedTitle = cleanedTitle.replace(/[。？！，、；：""''（）《》〈〉【】「」『』]/g, ''); // 移除特定标点
    cleanedTitle = cleanedTitle.replace(/\s+/g, ' ').trim(); // 合并多个空格为一个，并去除首尾空格

    if (cleanedTitle.length > 15) { // 限制长度
        cleanedTitle = cleanedTitle.substring(0, 15);
    }
    return cleanedTitle || "AI总结话题"; // 如果清理后为空，返回默认
}

/**
 * 构建用于话题总结的消息内容
 * @param {Array<object>} groupHistory - 聊天历史
 * @param {object} globalVcpSettings - 全局设置
 * @returns {string} 格式化后的对话内容
 */
function buildSummaryContent(groupHistory, globalVcpSettings) {
    const recentMessagesContent = groupHistory.slice(-MIN_MESSAGES_FOR_SUMMARY).map(msg => {
        const speakerName = msg.name || (msg.role === 'user' ? (globalVcpSettings.userName || '用户') : 'AI成员');
        // 确保从消息内容中提取文本，即使它是对象 { text: '...' }
        let contentText = typeof msg.content === 'string' ? msg.content : (msg.content?.text || '');
        // 如果消息有附件且包含提取的文本，也将其包含在内
        if (msg.attachments && msg.attachments.length > 0) {
            for (const att of msg.attachments) {
                const fileManagerData = att._fileManagerData || {};
                // 🟢 同步：多级路径探测。优先使用 internalPath (物理路径)
                const filePathForContext = (fileManagerData && fileManagerData.internalPath) || 
                                           att.localPath || 
                                           att.src || 
                                           (att.name || '未知文件');

                if (fileManagerData && typeof fileManagerData.extractedText === 'string' && fileManagerData.extractedText.trim() !== '') {
                    contentText += `\n\n[附加文件: ${filePathForContext}]\n${fileManagerData.extractedText}\n[/附加文件结束: ${att.name || '未知文件'}]`;
                } else if (att.type && !att.type.startsWith('image/')) {
                    contentText += `\n\n[附加文件: ${filePathForContext} (无法预览文本内容)]`;
                }
            }
        }
        return `${speakerName}: ${contentText}`;
    }).join('\n\n');

    return recentMessagesContent;
}

/**
 * 调用 AI 生成话题标题
 * @param {string} summaryContent - 对话内容摘要
 * @param {object} globalVcpSettings - 全局 VCP 设置
 * @returns {Promise<string|null>} AI 生成的原始标题，或 null
 */
async function generateTitleFromAI(summaryContent, globalVcpSettings) {
    if (!globalVcpSettings.vcpUrl) {
        console.error("[TopicTitleManager] VCP URL not configured. Cannot summarize topic.");
        return null;
    }

    const summaryPrompt = `请根据以下群聊对话内容，仅返回一个简洁的话题标题。要求：1. 标题长度控制在10个汉字或20个英文字符以内。2. 标题本身不能包含任何标点符号、数字编号或任何非标题文字。3. 直接给出标题文字，不要添加任何解释或前缀。\n\n对话内容：\n${summaryContent}`;
    const messagesForAISummary = [{ role: 'user', content: [{ type: 'text', text: summaryPrompt }] }];

    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000); // 20秒超时（总结用时较短）

    let response;
    try {
        response = await fetch(globalVcpSettings.vcpUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${globalVcpSettings.vcpApiKey}`
            },
            body: JSON.stringify({
                messages: messagesForAISummary,
                model: globalVcpSettings.topicSummaryModel || 'gemini-2.5-flash-preview-05-20',
                temperature: 0.3,
                max_tokens: 4000,
                stream: false // 总结通常不需要流式
            }),
            signal: controller.signal
        });
    } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
            console.error(`[TopicTitleManager] VCP request timeout after 20 seconds`);
            return null;
        }
        throw fetchError;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[TopicTitleManager] VCP请求失败. Status: ${response.status}, Response: ${errorText}`);
        return null;
    }

    const summaryResponseJson = await response.json();
    if (summaryResponseJson.choices && summaryResponseJson.choices.length > 0) {
        return summaryResponseJson.choices[0].message.content;
    }

    console.warn('[TopicTitleManager] AI未能生成有效的总结标题或响应格式不符。Response:', summaryResponseJson);
    return null;
}

/**
 * 触发话题总结（如果需要）
 * @param {string} groupId - 群组 ID
 * @param {string} topicId - 话题 ID
 * @param {Array<object>} groupHistory - 当前话题的完整历史记录
 * @param {object} globalVcpSettings - 全局VCP设置
 * @param {object} groupConfig - 当前群组的配置
 * @param {function} sendStreamChunkToRenderer - 用于发送通知回渲染器的函数
 * @param {function} saveGroupTopicTitle - 保存话题标题的函数
 */
async function triggerSummarizationIfNeeded(groupId, topicId, groupHistory, globalVcpSettings, groupConfig, sendStreamChunkToRenderer, saveGroupTopicTitle) {
    if (!groupConfig || !groupConfig.topics) return;

    const currentTopic = groupConfig.topics.find(t => t.id === topicId);
    if (!currentTopic) {
        console.warn(`[TopicTitleManager] 尝试总结时未找到话题 ${topicId} in group ${groupId}`);
        return;
    }

    const isDefaultTitle = DEFAULT_TOPIC_NAMES.includes(currentTopic.name) || currentTopic.name.startsWith("新话题");

    if (groupHistory.length >= MIN_MESSAGES_FOR_SUMMARY && isDefaultTitle) {
        console.log(`[TopicTitleManager] 话题 ${topicId} (${currentTopic.name}) 满足总结条件。消息数: ${groupHistory.length}`);

        try {
            const summaryContent = buildSummaryContent(groupHistory, globalVcpSettings);
            const rawTitle = await generateTitleFromAI(summaryContent, globalVcpSettings);

            if (!rawTitle) return;

            const newTitle = cleanSummarizedTitle(rawTitle);

            // 检查新标题是否有效且与原标题不同
            if (newTitle && newTitle !== "AI总结话题" && newTitle !== currentTopic.name) {
                console.log(`[TopicTitleManager] 话题 ${topicId} 新标题: "${newTitle}" (原: "${currentTopic.name}")`);
                const saveResult = await saveGroupTopicTitle(groupId, topicId, newTitle);
                if (saveResult.success && sendStreamChunkToRenderer) {
                    // 通知渲染器话题标题已更新
                    sendStreamChunkToRenderer({
                        type: 'topic_updated',
                        context: {
                            groupId,
                            topicId,
                            newTitle,
                            topics: saveResult.topics,
                            isGroupMessage: true
                        }
                    });
                    console.log(`[TopicTitleManager] 已通知渲染器话题 ${topicId} 标题更新。`);
                } else if (!saveResult.success) {
                    console.error(`[TopicTitleManager] 保存新话题标题失败: ${saveResult.error}`);
                }
            } else if (newTitle === "AI总结话题") {
                console.log(`[TopicTitleManager] AI未能有效总结话题 ${topicId} (返回默认值)，不更新标题。原始AI返回: "${rawTitle}"`);
            } else if (newTitle === currentTopic.name) {
                console.log(`[TopicTitleManager] AI总结的标题与原标题 "${currentTopic.name}" 相同，不更新。`);
            } else {
                console.log(`[TopicTitleManager] 生成的标题为空或无效，不更新: "${newTitle}"`);
            }
        } catch (error) {
            console.error('[TopicTitleManager] 调用VCP进行话题总结时出错:', error);
        }
    }
}

module.exports = {
    cleanSummarizedTitle,
    buildSummaryContent,
    generateTitleFromAI,
    triggerSummarizationIfNeeded,
    MIN_MESSAGES_FOR_SUMMARY,
    DEFAULT_TOPIC_NAMES
};