import * as maskModule from './vcpResilienceMask.js';

const api = globalThis.VCPProtocolResilienceMask
    || (maskModule?.default && typeof maskModule.default.findClosedFenceAndToolRanges === 'function' ? maskModule.default : null)
    || (typeof maskModule?.findClosedFenceAndToolRanges === 'function' ? maskModule : null);

if (!api) {
    throw new Error('VCPProtocolResilienceMask is not loaded');
}

export const {
    INFO_START,
    INFO_END,
    isLineLeadingBlank,
    isLineTrailingBlank,
    findNestedVcpInfoRanges,
    findClosedFenceAndToolRanges,
    applyMaskRanges,
    maskProtectedRegions,
    unmaskProtectedRegions,
    isGuidanceErrorInfoBlock,
    isToolResultHidden,
    stripThoughtChains,
    stripHiddenToolResults,
    stripErrorSummaryItemsInSummaryBlocks,
    stripResilienceNoiseFromMasked,
    stripProtocolResilienceNoise,
    extractTextFromMultimodalContent,
    createUniqueMaskPrefix,
    maskInlineBackticks,
    unmaskInlineBackticks,
    blankInlineBackticksOutsideFences,
    shouldStripUnclosedToolRequest,
    findSafeClosedFenceRanges,
    findFenceRangesOutsideProtocolWalls,
    stripUnclosedToolRequestsSafe,
} = api;

export default api;
