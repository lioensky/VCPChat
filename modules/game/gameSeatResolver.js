'use strict';

// Household signature convention, not cryptographic identity.
function resolveSeat(seats, signature) {
    if (typeof signature !== 'string' || !signature.trim()) {
        throw new Error('游戏工具缺少maid/valet署名。');
    }
    const name = signature.trim().toLowerCase();
    const candidates = seats.map((seat, index) => ({ ...seat, index }))
        .filter(seat => seat.kind === 'agent' && typeof seat.name === 'string' && seat.name.trim());
    const exact = candidates.filter(seat => seat.name.trim().toLowerCase() === name);
    const matches = exact.length ? exact : candidates.filter(seat => {
        const configured = seat.name.trim().toLowerCase();
        return name.includes(configured) || configured.includes(name);
    });
    if (matches.length !== 1) {
        throw new Error(matches.length ? '署名同时命中本桌多个座位，请使用完整名字。' : '署名不属于本桌Agent。');
    }
    return matches[0].index;
}
function createSignatureAuthorizer(gameService) {
    return async (args) => {
        const record = await gameService.read(args.matchId);
        const signatures = [args.maid, args.valet].filter(value => typeof value === 'string' && value.trim());
        const seat = resolveSeat(record.seats, signatures[0]);
        if (signatures.some(signature => resolveSeat(record.seats, signature) !== seat)) {
            throw new Error('maid和valet署名指向不同座位。');
        }
        if (typeof args.decisionId !== 'string' || !args.decisionId.trim()
            || args.revision === undefined || args.revision === null
            || (typeof args.revision === 'string' && !args.revision.trim())) {
            throw Object.assign(new Error('缺少decisionId或revision。请原样复制最后一次私有邀请的三个绑定字段，revision=0也必须填写。'), {
                code: 'MISSING_DECISION_BINDING',
            });
        }
        const revision = Number(args.revision);
        if (!['string', 'number'].includes(typeof args.revision)
            || !Number.isSafeInteger(revision) || revision < 0
            || args.decisionId !== `${record.matchId}:${revision}`) {
            throw Object.assign(new Error('decisionId与revision不一致。请原样复制最后一次私有邀请中的matchId、decisionId、revision；不要使用event序号，也不要自行拼接或递增。'), {
                code: 'INVALID_DECISION_BINDING',
            });
        }
        return {
            matchId: record.matchId, seat,
            decisionId: args.decisionId, revision,
        };
    };
}
module.exports = { resolveSeat, createSignatureAuthorizer };