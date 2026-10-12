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
        const revision = Number(args.revision);
        if (!Number.isSafeInteger(revision) || revision < 0
            || args.decisionId !== `${record.matchId}:${revision}`) {
            throw new Error('游戏决策ID与版本不一致。');
        }
        return {
            matchId: record.matchId, seat,
            decisionId: args.decisionId, revision,
        };
    };
}
module.exports = { resolveSeat, createSignatureAuthorizer };