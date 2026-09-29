// Agent proposes actions; JEV alone selects an action or a terminal outcome.
(function initializeFlowlockJev(root) {
    'use strict';
    const LIMITS = Object.freeze({ candidates: 6, action: 2000, summary: 2000, block: 20000, history: 12 });
    const prompts = typeof module !== 'undefined' && module.exports ? require('./flowlock-jev-prompts') : root.flowlockJevPrompts;
    function textOf(message) {
        const content = message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text || '').join('\n');
        return typeof content?.text === 'string' ? content.text : '';
    }
    function userContextKey(history) {
        const message = history.filter(m => !m.isThinking && m.role === 'user' && !textOf(m).trim().startsWith('[系统提示:]')).at(-1);
        return JSON.stringify(message ? [message.id || null, message.timestamp || null, textOf(message)] : null);
    }
    function parseCandidates(content, protocol) {
        if (typeof protocol?.createSafeScanText !== 'function') throw new Error('心流安全协议解析器不可用');
        const text = typeof content === 'string' ? content : '';
        const safe = protocol.createSafeScanText(text);
        const starts = [...safe.matchAll(/\[\[Flowlock::Candidates\]\]/gi)];
        if (!starts.length) return null;
        if (starts.length !== 1) throw new Error('每轮只允许一个 Candidates 块');
        const blockStart = starts[0].index;
        const lower = safe.toLowerCase();
        for (const name of ['nextprompt', 'fail']) {
            const open = lower.lastIndexOf('[[flowlock::' + name + ']]', blockStart);
            const close = lower.lastIndexOf('[[/flowlock::' + name + ']]', blockStart);
            if (open !== -1 && close < open && lower.indexOf('[[/flowlock::' + name + ']]', blockStart) !== -1) return null;
        }
        const start = starts[0].index + starts[0][0].length;
        const end = /\[\[\/Flowlock::Candidates\]\]/gi;
        end.lastIndex = start;
        const close = end.exec(safe);
        if (!close || close.index - start > LIMITS.block) throw new Error('Candidates 块未闭合或过长');
        let data;
        try { data = JSON.parse(text.slice(start, close.index)); } catch (_) { throw new Error('Candidates 必须是合法 JSON'); }
        if (!data || !Array.isArray(data.candidates) || data.candidates.length > LIMITS.candidates) throw new Error('Candidates 必须包含 0~6 个候选');
        const ids = new Set();
        const candidates = data.candidates.map(candidate => {
            if (!candidate || typeof candidate.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(candidate.id) || ids.has(candidate.id)) throw new Error('候选 id 无效或重复');
            ids.add(candidate.id);
            if (typeof candidate.action !== 'string' || !candidate.action.trim() || candidate.action.length > LIMITS.action) throw new Error('候选 action 必须为 1~2000 字符');
            if (/\[\[\/?Flowlock::|<<<\[TOOL_REQUEST\]/i.test(candidate.action)) throw new Error('候选 action 不得嵌入控制命令或工具请求');
            const delay = candidate.delaySeconds;
            if (delay !== undefined && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 1 || delay > 86400)) throw new Error('候选 delaySeconds 必须为 1~86400 秒');
            return { id: candidate.id, action: candidate.action.trim(), reason: typeof candidate.reason === 'string' ? candidate.reason.slice(0, 1000) : '', delaySeconds: delay ?? null };
        });
        return { summary: typeof data.summary === 'string' ? data.summary.slice(0, LIMITS.summary) : '', candidates };
    }
    function buildRequest({ session, plan, history = [], content = '', terminalProposal = null }) {
        const entries = history.filter(m => !m.isThinking && ['user', 'assistant', 'system'].includes(m.role));
        const userMessages = entries.filter(m => m.role === 'user' && !/^\[系统提示:\]/.test(textOf(m).trim()));
        const criteria = {};
        const optionToCandidate = {};
        const questions = {
            lifecycle: {
                type: 'choice', instructions: prompts.lifecycle,
                criteria: {
                    continue: '用户目标尚未满足，仍有安全有界、有实际增量的必要工作可自主推进。不是为了保持活跃而继续。',
                    complete: '用户当前全部必要要求已有可见完成证据，包括明确要求的验证；不存在必做的遗漏或未决错误。不是计划完成或自称完成。',
                    needs_user: '继续必须由用户提供关键输入、登录、批准或消解会改变结果的歧义；Agent 无法在既有授权下自行处理。',
                    failed: '明确证据表明目标无法完成，且当前没有可行的自助恢复路径；不是暂时故障或仅缺用户输入。',
                    stopped: '用户已要求停止，或者继续只会重复、扩张范围、空转，或现有证据不足以支持自主执行；不宣称任务完成。'
                }
            },
            completion_supported: {
                type: 'noul', instructions: prompts.completion,
                criteria: { true: '所有用户必要要求都有对应结果和必要验证，证据充分且没有矛盾。', false: '仍有遗漏、未验证、失败、进行中、证据缺失，或只有 Agent 的宣言。' }
            }
        };
        plan.candidates.forEach((candidate, index) => {
            const key = `action_${index + 1}`;
            criteria[key] = `原样选择候选 state.proposal.candidates[${index}]：${candidate.action}。仅在它是符合用户目标、授权和依赖顺序的最佳有效下一步时选择。`;
            optionToCandidate[key] = candidate;
            questions[`${key}_allowed`] = {
                type: 'noul', instructions: prompts.allowed(index),
                criteria: { true: '用户授权涵盖动作后果，执行前提具备，无需额外人工批准。', false: '未授权、越权、前提缺失、关键参数无证据或必须人工确认。' }
            };
            questions[`${key}_progress`] = {
                type: 'noul', instructions: prompts.progress(index),
                criteria: { true: '带来尚未实现的必要进展、有效验证或关键新信息。', false: '重复空转、已完成、无关扩张、抽象敷衍或无新条件的失败重试。' }
            };
        });
        if (plan.candidates.length) {
            criteria.none = '所有候选均不适合立即执行，或缺少可判断的必要依据。不要强行匹配，不自行创造动作。';
            questions.next_action = { type: 'choice', instructions: prompts.selection, criteria };
        }
        return {
            optionToCandidate, questions,
            state: {
                goal: session.goal || textOf(userMessages.at(-1)).slice(0, 4000),
                latestUserRequest: textOf(userMessages.at(-1)).slice(0, 4000),
                session: { agentId: session.agentId, topicId: session.topicId, round: session.round, taskPrompt: (session.defaultPrompt || '').slice(0, 4000) },
                recentDecisions: session.decisionHistory || [],
                recentMessages: entries.slice(-LIMITS.history).map(m => ({ role: m.role, content: textOf(m).slice(0, 4000) })),
                contextTruncated: entries.length > LIMITS.history || entries.slice(-LIMITS.history).some(m => textOf(m).length > 4000) || content.length > 6000,
                latestReply: content.slice(0, 6000), proposal: plan, terminalProposal
            }
        };
    }
    function probability(value) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('JEV 返回无效概率/置信度');
        return value;
    }
    function choiceAnswer(result, request, key) {
        const answer = result?.answers?.[key];
        const criteria = request.questions[key]?.criteria;
        if (!answer || !criteria || typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)) throw new Error(`JEV ${key} 返回未知选项`);
        probability(answer.confidence);
        const distribution = answer.probabilities;
        if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution)) throw new Error('JEV 缺少选项概率分布');
        const keys = Object.keys(criteria);
        if (Object.keys(distribution).length !== keys.length) throw new Error('JEV 概率分布与候选不匹配');
        const sum = keys.reduce((total, option) => total + probability(distribution[option]), 0);
        if (Math.abs(sum - 1) > 0.02 || keys.some(k => distribution[k] > distribution[answer.choice] + 0.000001)) throw new Error('JEV 选择与概率分布不一致');
        return answer;
    }
    function parseDecision(result, request, minConfidence = 0.6, minEvidence = 0.85) {
        // Conservative application defaults, not TypeSafe guarantees; tune using local evals.
        const lifecycle = choiceAnswer(result, request, 'lifecycle');
        const base = { confidence: lifecycle.confidence, lifecycle: lifecycle.choice };
        if (lifecycle.confidence < minConfidence) return { ...base, type: 'stop', reason: 'low_confidence' };
        if (lifecycle.choice === 'complete') {
            const evidence = probability(result?.answers?.completion_supported?.noul);
            return evidence >= minEvidence
                ? { ...base, type: 'complete', reason: 'jev_complete', evidence }
                : { ...base, type: 'stop', reason: 'completion_unverified', evidence };
        }
        if (lifecycle.choice !== 'continue') return { ...base, type: lifecycle.choice === 'failed' ? 'fail' : 'stop', reason: `jev_${lifecycle.choice}` };
        if (!request.questions.next_action) return { ...base, type: 'replan', reason: 'no_candidates' };
        const answer = choiceAnswer(result, request, 'next_action');
        if (answer.confidence < minConfidence) return { ...base, type: 'stop', reason: 'uncertain_action', actionConfidence: answer.confidence };
        if (answer.choice === 'none') return { ...base, type: 'replan', reason: 'no_suitable_candidate' };
        const allowed = probability(result?.answers?.[`${answer.choice}_allowed`]?.noul);
        const progress = probability(result?.answers?.[`${answer.choice}_progress`]?.noul);
        if (allowed < minEvidence) return { ...base, type: 'stop', reason: 'action_not_authorized_or_ready', allowed };
        if (progress < minEvidence) return { ...base, type: 'replan', reason: 'action_without_progress', progress };
        return { ...base, type: 'execute', candidate: request.optionToCandidate[answer.choice], choice: answer.choice, actionConfidence: answer.confidence, allowed, progress };
    }
    const candidateInstructions = [
        '你处于 JEV 裁决的心流锁。Agent 负责提案和执行，JEV 独立选择下一项及何时结束。',
        '完成本轮后，在回复末尾输出恰好一个闭合的候选块，不要用代码块、工具请求或思考标签包裹：',
        '[[Flowlock::Candidates]]',
        '{"summary":"本轮结果、验证证据和剩余问题","candidates":[{"id":"check","action":"下一步具体动作","reason":"必要性和预期增量","delaySeconds":5}]}',
        '[[/Flowlock::Candidates]]',
        '提出 1~6 个不同且符合用户授权的可执行候选；每项仅一个有界动作。若任务完成/受阻/需用户输入，candidates 可为空并在 summary 说明证据。',
        '候选 action 不得包含 Flowlock 控制标记或工具请求。不得提前执行未被选中的候选。Complete/Stop/Fail 仅供裁判参考。'
    ].join('\n');
    function planningPrompt(taskPrompt = '') {
        return ['[系统提示:] 当前是候选规划轮，只评估现状并生成候选，不调用工具、不执行候选，不自行选定下一步。', taskPrompt ? `当前任务提示：${taskPrompt}` : '', candidateInstructions].filter(Boolean).join('\n');
    }
    function executionPrompt(candidate) {
        return ['[系统提示:] JEV 已选择以下唯一动作；只执行此动作及必要验证，不执行其他候选。若权限/前提不满足则报告阻碍，不扩大范围。', `候选 ${candidate.id}：${candidate.action}`, candidateInstructions].join('\n');
    }
    const api = Object.freeze({ LIMITS, parseCandidates, buildRequest, parseDecision, planningPrompt, executionPrompt, textOf, userContextKey });
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.flowlockJev = api;
})(typeof window !== 'undefined' ? window : null);
