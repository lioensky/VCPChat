'use strict';

// MinerU 论文工作台：论文库扫描、解析/查重、阅读资产与本地 PDF 关联。
// 主进程：modules/ipc/minerUHandlers.js、modules/services/minerU/*
// 渲染端：MinerUmodules/
const { invoke, on } = require('../core/define');

module.exports = {
    handlers: ['modules/ipc/minerUHandlers.js'],
    roles: ['utility'],
    api: {
        mineruStatus: invoke('mineru:status'),
        mineruSaveConfig: invoke('mineru:save-config', 'patch'),
        mineruPickToolboxRoot: invoke('mineru:pick-toolbox-root'),
        mineruScan: invoke('mineru:scan'),
        mineruGetPaper: invoke('mineru:get-paper', 'paperId'),
        mineruReadPdf: invoke('mineru:read-pdf', 'paperId'),
        mineruPickPdfs: invoke('mineru:pick-pdfs'),
        mineruPickFolder: invoke('mineru:pick-folder'),
        mineruPickPdfForPaper: invoke('mineru:pick-pdf-for-paper', 'paperId'),
        mineruClearPdfMapping: invoke('mineru:clear-pdf-mapping', 'paperId'),
        mineruPreflight: invoke('mineru:preflight', 'payload'),
        mineruParse: invoke('mineru:parse', 'payload'),
        mineruContinue: invoke('mineru:continue', 'paperIds'),
        mineruCancelJob: invoke('mineru:cancel-job', 'jobId'),
        mineruListJobs: invoke('mineru:list-jobs'),
        mineruDuplicates: invoke('mineru:duplicates', 'options'),
        mineruReveal: invoke('mineru:reveal', 'paperId'),
        mineruRevealAsset: invoke('mineru:reveal-asset', 'paperId', 'assetDir'),
        mineruOpenPdf: invoke('mineru:open-pdf', 'paperId'),
        mineruOpenDir: invoke('mineru:open-dir', 'paperId'),
        mineruOpenExternal: invoke('mineru:open-external', 'url'),
        onMineruJob: on('mineru:job'),
        onMineruLibraryChanged: on('mineru:library-changed'),
    },
};
