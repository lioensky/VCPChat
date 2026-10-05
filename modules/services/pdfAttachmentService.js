'use strict';

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');

// 判定阈值与安全上限配置
const HEADER_FOOTER_RATIO = 0.09; // 页面顶部 9% 和底部 9% 视为页眉/页脚区间
const SCAN_PAGE_CHAR_THRESHOLD = 35; // 单页正文有效字符低于此值视为疑似扫描页/纯图页
const MAX_IMAGE_PAGES = 10; // 扫描件转多模态图片的最大页数上限（保护上下文大小）
const MAX_IMAGE_DIMENSION = 1600; // 多模态图片最大长宽边长
const JPEG_QUALITY = 80; // 压缩质量

// 匹配常见页码模式：例如 "1", "- 1 -", "Page 1", "Page 1 of 12", "第 1 页", "第 1 页 共 5 页", "1/10" 等
const PAGE_NUMBER_REGEX = /^\s*(?:第?\s*\d+\s*页(?:\s*[\/、,]?\s*共?\s*\d+\s*页)?|page\s*\d+(?:\s*(?:of|\/)\s*\d+)?|\d+\s*[\/\-]\s*\d+|\-?\s*\d+\s*\-?|\d+)\s*$/i;

// 匹配常见扫描水印/元数据模式：例如纯时间戳、纯 URL、纯文件名
const SCAN_METADATA_HEADER_REGEX = /^\s*(?:\d{4}[-\/\.]\d{1,2}[-\/\.]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?|https?:\/\/\S+|scanner|camscanner|scanned\s+by\s+\S+)\s*$/i;

/**
 * 判断是否为高熵乱码串（如扫描件坏字体/未解码字形：0JPFWGo4oU9ZaY8O9R7NnPpPnPqOfQpPvNiNmNnQ9PrQoOuOtPmQxNtOrN）
 * @param {string} str
 * @returns {boolean}
 */
function isGibberishText(str) {
    if (!str || typeof str !== 'string') return false;
    const trimmed = str.trim();
    if (trimmed.length < 20) return false;

    // 连续长串无空格、无常见中文标点、纯英文字母数字混合
    if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
        // 统计大写-小写、小写-大写交替跳变次数
        let flipCount = 0;
        for (let i = 0; i < trimmed.length - 1; i++) {
            const current = trimmed[i];
            const next = trimmed[i + 1];
            const isCurrLower = current >= 'a' && current <= 'z';
            const isCurrUpper = current >= 'A' && current <= 'Z';
            const isNextLower = next >= 'a' && next <= 'z';
            const isNextUpper = next >= 'A' && next <= 'Z';
            if ((isCurrLower && isNextUpper) || (isCurrUpper && isNextLower)) {
                flipCount++;
            }
        }
        // 正常英文单词极少出现频繁大小写交替跳变（如每 2~3 字符跳一次）
        if (flipCount >= 6 && flipCount / trimmed.length > 0.18) {
            return true;
        }

        // 统计数字与字母掺杂且无词汇边界
        const digits = (trimmed.match(/\d/g) || []).length;
        const letters = (trimmed.match(/[a-zA-Z]/g) || []).length;
        if (digits >= 3 && letters >= 10 && !trimmed.includes(' ') && trimmed.length >= 25) {
            return true;
        }
    }

    return false;
}

/**
 * 结构化解析 PDF 单页，分离页眉、页脚、页码与正文，并统计有效语言特征
 * @param {object} pageData - pdf.js 页面对象
 * @returns {Promise<object>}
 */
async function renderPageStructured(pageData) {
    const pageIndex = pageData.pageIndex;
    const pageNumber = pageIndex + 1;
    let viewportHeight = 842;
    let viewportWidth = 595;

    try {
        const vp = pageData.getViewport(1.0);
        if (vp && vp.height && vp.width) {
            viewportHeight = vp.height;
            viewportWidth = vp.width;
        }
    } catch (_e) {
        // 使用默认 A4 尺寸
    }

    const textContent = await pageData.getTextContent({
        normalizeWhitespace: true,
        disableCombineTextItems: false
    });

    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    const headerItems = [];
    const footerItems = [];
    const bodyItems = [];

    // 根据坐标分组
    for (const item of items) {
        const rawStr = item?.str;
        if (typeof rawStr !== 'string' || !rawStr.trim()) continue;
        const transform = item.transform || [];
        const yCoord = typeof transform[5] === 'number' ? transform[5] : (viewportHeight / 2);

        // PDF 坐标系：0 在底部，viewportHeight 在顶部
        const isHeaderZone = yCoord >= viewportHeight * (1 - HEADER_FOOTER_RATIO);
        const isFooterZone = yCoord <= viewportHeight * HEADER_FOOTER_RATIO;

        if (isHeaderZone) {
            headerItems.push({ str: rawStr, y: yCoord, item });
        } else if (isFooterZone) {
            footerItems.push({ str: rawStr, y: yCoord, item });
        } else {
            bodyItems.push({ str: rawStr, y: yCoord, item });
        }
    }

    // 格式化文本行
    const formatItemsToText = (itemList) => {
        let lastY = null;
        let text = '';
        for (const it of itemList) {
            if (lastY === null || Math.abs(lastY - it.y) <= 4) {
                text += (text ? ' ' : '') + it.str;
            } else {
                text += '\n' + it.str;
            }
            lastY = it.y;
        }
        return text.trim();
    };

    const headerText = formatItemsToText(headerItems);
    const footerText = formatItemsToText(footerItems);
    const bodyRawText = formatItemsToText(bodyItems);

    // 针对页眉页脚检测页码与扫描元数据
    const isHeaderPageNum = PAGE_NUMBER_REGEX.test(headerText) || SCAN_METADATA_HEADER_REGEX.test(headerText);
    const isFooterPageNum = PAGE_NUMBER_REGEX.test(footerText) || SCAN_METADATA_HEADER_REGEX.test(footerText);

    // 过滤正文中的独立乱码段落
    const bodyLines = bodyRawText.split('\n');
    const validBodyLines = [];
    let gibberishCharsCount = 0;

    for (const line of bodyLines) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        if (isGibberishText(trimmedLine)) {
            gibberishCharsCount += trimmedLine.length;
            continue;
        }
        // 如果在正文区也混入了独立的孤立页码（例如部分排版工具未严格位于边缘）
        if (bodyLines.length <= 3 && PAGE_NUMBER_REGEX.test(trimmedLine)) {
            continue;
        }
        validBodyLines.push(trimmedLine);
    }

    const cleanBodyText = validBodyLines.join('\n');

    // 统计有效字符维度
    const chineseChars = (cleanBodyText.match(/[\u4e00-\u9fa5]/g) || []).length;
    const latinWords = (cleanBodyText.match(/\b[a-zA-Z]{2,}\b/g) || []).length;
    const bodyCharsWithoutSpace = cleanBodyText.replace(/\s+/g, '').length;

    // 单页是否疑似扫描/图表页：有效正文字符太少，或绝大部分被判定为乱码
    const isScanLikePage = bodyCharsWithoutSpace < SCAN_PAGE_CHAR_THRESHOLD
        || (chineseChars < 5 && latinWords < 5 && bodyCharsWithoutSpace < 50);

    return {
        pageNumber,
        viewportWidth,
        viewportHeight,
        headerText,
        footerText,
        isHeaderPageNum,
        isFooterPageNum,
        rawText: [headerText, bodyRawText, footerText].filter(Boolean).join('\n'),
        bodyText: cleanBodyText,
        bodyCharsCount: bodyCharsWithoutSpace,
        chineseChars,
        latinWords,
        gibberishCharsCount,
        isScanLikePage
    };
}

/**
 * 综合评估整篇 PDF 文档是属于可阅读文本 PDF 还是扫描件/图像 PDF
 * @param {Array<object>} pages
 * @param {number} numPages
 * @returns {object}
 */
function evaluatePdfDocument(pages, numPages) {
    const totalPages = Math.max(pages.length, numPages || 0);
    if (totalPages === 0) {
        return {
            isScanned: true,
            reason: '未提取到任何页面内容',
            totalPages: 0,
            totalBodyChars: 0,
            cleanFullText: ''
        };
    }

    let totalBodyChars = 0;
    let totalChineseChars = 0;
    let totalLatinWords = 0;
    let scanLikePagesCount = 0;
    let totalGibberishChars = 0;
    const fullTextParts = [];

    for (const page of pages) {
        totalBodyChars += page.bodyCharsCount;
        totalChineseChars += page.chineseChars;
        totalLatinWords += page.latinWords;
        totalGibberishChars += page.gibberishCharsCount;
        if (page.isScanLikePage) {
            scanLikePagesCount++;
        }
        if (page.bodyText) {
            fullTextParts.push(`--- 第 ${page.pageNumber} 页 ---\n${page.bodyText}`);
        }
    }

    const cleanFullText = fullTextParts.join('\n\n');
    const scanLikeRatio = totalPages > 0 ? (scanLikePagesCount / totalPages) : 1;
    const avgCharsPerPage = totalPages > 0 ? (totalBodyChars / totalPages) : 0;

    // 规则 1：单页 PDF 判定
    if (totalPages === 1) {
        if (totalBodyChars < 60 && totalChineseChars < 10 && totalLatinWords < 8) {
            return {
                isScanned: true,
                reason: `单页正文字符过少（正文仅 ${totalBodyChars} 字符，中文 ${totalChineseChars} 字，英文 ${totalLatinWords} 词），疑似扫描件或纯图表`,
                totalPages,
                totalBodyChars,
                scanLikeRatio,
                cleanFullText
            };
        }
        if (totalGibberishChars > 0 && totalBodyChars < 20) {
            return {
                isScanned: true,
                reason: `单页提取主要为无意义乱码/字符噪音（乱码 ${totalGibberishChars} 字符），判定为扫描件`,
                totalPages,
                totalBodyChars,
                scanLikeRatio,
                cleanFullText
            };
        }
        return {
            isScanned: false,
            reason: '单页包含充足正文字符',
            totalPages,
            totalBodyChars,
            scanLikeRatio,
            cleanFullText
        };
    }

    // 规则 2：多页 PDF 判定
    // 2.1 绝大多数页面（>= 70%）均无正文或仅含页码
    if (scanLikeRatio >= 0.70) {
        return {
            isScanned: true,
            reason: `文档大部分页面（${scanLikePagesCount}/${totalPages} 页，占比 ${Math.round(scanLikeRatio * 100)}%）无有效正文或仅含页码，判定为扫描件`,
            totalPages,
            totalBodyChars,
            scanLikeRatio,
            cleanFullText
        };
    }

    // 2.2 平均每页正文字符密度极低（如 3 页 PDF 总共只有几十个字）
    if (avgCharsPerPage < SCAN_PAGE_CHAR_THRESHOLD) {
        return {
            isScanned: true,
            reason: `平均每页正文字符密度过低（平均仅 ${Math.round(avgCharsPerPage)} 字符/页），判定为扫描件`,
            totalPages,
            totalBodyChars,
            scanLikeRatio,
            cleanFullText
        };
    }

    // 2.3 汉字和英文有效单词均极低
    if (totalChineseChars < totalPages * 5 && totalLatinWords < totalPages * 5 && totalBodyChars < totalPages * 50) {
        return {
            isScanned: true,
            reason: `文档有效自然语言词汇极度稀疏，判定为扫描件`,
            totalPages,
            totalBodyChars,
            scanLikeRatio,
            cleanFullText
        };
    }

    return {
        isScanned: false,
        reason: `检测到连续有效正文（共 ${totalBodyChars} 字符，平均 ${Math.round(avgCharsPerPage)} 字符/页）`,
        totalPages,
        totalBodyChars,
        scanLikeRatio,
        cleanFullText
    };
}

/**
 * 将 PDF 渲染为适合多模态 LLM 的 Base64 JPEG 图片序列
 * 使用 pdf-poppler 光栅化渲染 + sharp 高保真等比压缩
 * @param {string} pdfPath
 * @param {object} options
 * @returns {Promise<{ imageFrames: Array<string>, totalPages: number, convertedCount: number }>}
 */
async function convertPdfToMultiModalImages(pdfPath, options = {}) {
    const maxPages = Number.isInteger(options.maxPages) && options.maxPages > 0
        ? options.maxPages
        : MAX_IMAGE_PAGES;

    const tempDir = path.join(os.tmpdir(), `vcp-pdf-mm-${crypto.randomBytes(12).toString('hex')}`);
    await fs.ensureDir(tempDir);

    try {
        console.log(`[PdfAttachmentService] 开始 Poppler 转图渲染: ${pdfPath}`);
        const poppler = require('pdf-poppler');
        const prefix = 'page';
        const popplerOptions = {
            format: 'jpeg',
            out_dir: tempDir,
            out_prefix: prefix,
            page: null // 先渲染所有页面，随后按上限截取
        };

        await poppler.convert(pdfPath, popplerOptions);

        const allFiles = await fs.readdir(tempDir);
        const imageFiles = allFiles
            .filter(f => f.toLowerCase().endsWith('.jpg') || f.toLowerCase().endsWith('.jpeg'))
            .sort((a, b) => {
                const matchA = a.match(/\d+/);
                const matchB = b.match(/\d+/);
                const numA = matchA ? parseInt(matchA[0], 10) : 0;
                const numB = matchB ? parseInt(matchB[0], 10) : 0;
                return numA - numB;
            });

        const totalRendered = imageFiles.length;
        const selectedFiles = imageFiles.slice(0, maxPages);
        const imageFrames = [];

        for (const file of selectedFiles) {
            const rawImagePath = path.join(tempDir, file);
            // 使用 Sharp 进行自适应等比压缩与格式优化，大幅减轻 Base64 上下文压力
            const compressedBuffer = await sharp(rawImagePath)
                .resize({
                    width: MAX_IMAGE_DIMENSION,
                    height: MAX_IMAGE_DIMENSION,
                    fit: 'inside',
                    withoutEnlargement: true
                })
                .jpeg({
                    quality: JPEG_QUALITY,
                    progressive: true
                })
                .toBuffer();

            imageFrames.push(compressedBuffer.toString('base64'));
        }

        console.log(`[PdfAttachmentService] 成功转换并压缩 ${imageFrames.length} 页图片（原 PDF 共 ${totalRendered} 页）`);
        return {
            imageFrames,
            totalPages: totalRendered,
            convertedCount: imageFrames.length
        };
    } finally {
        await fs.remove(tempDir).catch(err => {
            console.warn(`[PdfAttachmentService] 清理临时目录失败: ${tempDir}`, err.message);
        });
    }
}

/**
 * 顶层处理 PDF 附件：智能提取有效正文（剔除页眉页脚与乱码）或回退转为多模态图片
 * @param {string} cleanFilePath - 本地文件绝对路径
 * @param {string} originalName - 原始文件名
 * @param {object} options
 * @returns {Promise<{ text: string|null, imageFrames: Array<string>|null, pdfMeta: object }>}
 */
async function processPdfAttachment(cleanFilePath, originalName = '', options = {}) {
    const fileName = originalName || path.basename(cleanFilePath);
    console.log(`[PdfAttachmentService] 开始处理 PDF 附件: ${cleanFilePath} (${fileName})`);

    const pages = [];
    let numPages = 0;
    let dataBuffer = null;

    try {
        dataBuffer = await fs.readFile(cleanFilePath);
    } catch (readError) {
        console.error(`[PdfAttachmentService] 读取 PDF 文件失败: ${cleanFilePath}`, readError);
        return { text: null, imageFrames: null, pdfMeta: { error: readError.message } };
    }

    let parsedSuccess = false;
    try {
        const pdfParse = require('pdf-parse');
        const parseResult = await pdfParse(dataBuffer, {
            pagerender: async (pageData) => {
                const structured = await renderPageStructured(pageData);
                pages.push(structured);
                return structured.bodyText;
            }
        });
        numPages = parseResult.numpages || pages.length;
        parsedSuccess = true;
    } catch (parseError) {
        console.warn(`[PdfAttachmentService] pdf-parse 结构化解析异常，准备直接作为扫描件转图: ${parseError.message}`);
    }

    // 若结构化解析成功，进行多维综合判决
    if (parsedSuccess && pages.length > 0) {
        const evaluation = evaluatePdfDocument(pages, numPages);
        console.log(`[PdfAttachmentService] PDF 评估结果: isScanned=${evaluation.isScanned}, 原因: ${evaluation.reason}`);

        if (!evaluation.isScanned && evaluation.cleanFullText && evaluation.cleanFullText.trim().length > 0) {
            return {
                text: evaluation.cleanFullText,
                imageFrames: null,
                pdfMeta: {
                    isScanned: false,
                    totalPages: evaluation.totalPages,
                    totalBodyChars: evaluation.totalBodyChars,
                    reason: evaluation.reason
                }
            };
        }

        // 判定为扫描件或纯图表，转为多模态图片
        try {
            const convertResult = await convertPdfToMultiModalImages(cleanFilePath, options);
            const summaryHint = `[VChat 附件说明: 本文件为扫描版/图像型 PDF《${fileName}》（共 ${convertResult.totalPages} 页，已内联前 ${convertResult.convertedCount} 页多模态高清图像供识别）。]`;
            return {
                text: summaryHint,
                imageFrames: convertResult.imageFrames,
                pdfMeta: {
                    isScanned: true,
                    totalPages: convertResult.totalPages,
                    convertedPages: convertResult.convertedCount,
                    reason: evaluation.reason
                }
            };
        } catch (convErr) {
            console.error(`[PdfAttachmentService] 扫描件转图失败: ${convErr.message}`);
            // 若转图失败，降级返回残余文本，避免彻底空白
            const fallbackText = evaluation.cleanFullText || '[未能从该扫描版 PDF 中提取到有效文本或图像]';
            return {
                text: fallbackText,
                imageFrames: null,
                pdfMeta: {
                    isScanned: true,
                    error: `转图失败: ${convErr.message}`,
                    reason: evaluation.reason
                }
            };
        }
    }

    // 若解析完全失败（例如加密 PDF、非标准损坏文档），直接尝试转图
    try {
        console.log(`[PdfAttachmentService] 解析器失败，尝试直接进行光栅化转图...`);
        const convertResult = await convertPdfToMultiModalImages(cleanFilePath, options);
        const summaryHint = `[VChat 附件说明: PDF《${fileName}》（共 ${convertResult.totalPages} 页，已转换为多模态图像供分析）。]`;
        return {
            text: summaryHint,
            imageFrames: convertResult.imageFrames,
            pdfMeta: {
                isScanned: true,
                totalPages: convertResult.totalPages,
                convertedPages: convertResult.convertedCount,
                reason: '解析器未读取到有效文本层，直接转图'
            }
        };
    } catch (fallbackConvErr) {
        console.error(`[PdfAttachmentService] 降级转图亦失败: ${fallbackConvErr.message}`);
        return {
            text: `[无法读取该 PDF 文件《${fileName}》的内容]`,
            imageFrames: null,
            pdfMeta: {
                isScanned: true,
                error: fallbackConvErr.message
            }
        };
    }
}

module.exports = {
    HEADER_FOOTER_RATIO,
    SCAN_PAGE_CHAR_THRESHOLD,
    MAX_IMAGE_PAGES,
    MAX_IMAGE_DIMENSION,
    JPEG_QUALITY,
    PAGE_NUMBER_REGEX,
    SCAN_METADATA_HEADER_REGEX,
    isGibberishText,
    renderPageStructured,
    evaluatePdfDocument,
    convertPdfToMultiModalImages,
    processPdfAttachment
};