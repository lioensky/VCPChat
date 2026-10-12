'use strict';

class GameToolAdapter {
    constructor({ gameService, authorize } = {}) {
        if (!gameService || typeof authorize !== 'function') {
            throw new TypeError('Game tool requires a service and trusted authorization adapter.');
        }
        this.service = gameService;
        this.authorize = authorize;
    }
    async processToolCall(args = {}, executionContext = {}) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Invalid tool arguments.');
        let binding;
        try {
            binding = await this.authorize(args, executionContext);
        } catch (error) {
            if (!['MISSING_DECISION_BINDING', 'INVALID_DECISION_BINDING'].includes(error.code)) throw error;
            return this.result({
                accepted: false, code: error.code, message: error.message,
                stateChanged: false,
            });
        }
        if (!binding || ![1, 2].includes(binding.seat)
            || typeof binding.matchId !== 'string' || typeof binding.decisionId !== 'string'
            || !Number.isInteger(binding.revision)) {
            throw new Error('游戏工具缺少可信适配或桌内署名解析得到的有效决策绑定。');
        }
        if (args.matchId !== binding.matchId || args.decisionId !== binding.decisionId
            || Number(args.revision) !== binding.revision) {
            return this.result({ accepted: false, code: 'BINDING_MISMATCH', message: '参数与本次可信决策绑定不一致。' });
        }
        const command = String(args.command || '').toLowerCase();
        if (command === 'getobservation') {
            const observation = await this.service.getObservation(binding.matchId, binding.seat);
            if (observation.decisionId !== binding.decisionId || observation.revision !== binding.revision) {
                return this.result({ accepted: false, code: 'STALE_DECISION', message: '本次决策已过期。' });
            }
            // Private observation appears only in the model-facing content, not public details.
            return this.result({ observation });
        }
        if (command !== 'submitaction') {
            return this.result({ accepted: false, code: 'UNKNOWN_COMMAND', message: '使用GetObservation或SubmitAction。' });
        }
        let cards = args.cards;
        if (typeof cards === 'string') {
            try { cards = JSON.parse(cards); }
            catch { return this.result({ accepted: false, code: 'INVALID_CARDS', message: 'cards须为实体牌ID的JSON数组。' }); }
        }
        let bid;
        if (args.bid !== undefined && args.bid !== '') bid = Number(args.bid);
        try {
            const result = await this.service.submit(binding.matchId, binding.seat, {
                submissionId: args.submissionId,
                decisionId: binding.decisionId, revision: binding.revision,
                action: {
                    type: args.action, cards, bid,
                    speech: args.speech, emoteUrl: args.emoteUrl,
                },
            });
            return this.result(result);
        } catch (error) {
            const businessCodes = new Set([
                'INVALID_SUBMISSION', 'SUBMISSION_CONFLICT', 'STALE_DECISION',
                'NOT_YOUR_TURN', 'FINISHED', 'INVALID_ACTION', 'INVALID_BID',
                'CANNOT_PASS', 'INVALID_COMBINATION', 'CARD_NOT_OWNED', 'CANNOT_BEAT',
                'INVALID_SPEECH', 'INVALID_EMOTE',
            ]);
            if (!businessCodes.has(error.code)) throw error;
            return this.result({
                accepted: false, code: error.code, message: error.message,
                decisionId: binding.decisionId, revision: binding.revision,
            });
        }
    }
    result(value) {
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
}
module.exports = { GameToolAdapter };