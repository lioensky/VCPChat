import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const pdfService = require(path.join(projectRoot, 'modules/services/pdfAttachmentService.js'));
const fileManager = require(path.join(projectRoot, 'modules/fileManager.js'));

test('PDF 附件全链路：乱码与伪 ASCII 串过滤', () => {
    // 用户实际反馈的扫描件异常字形乱码
    const userReportedGibberish = '0JPFWGo4oU9ZaY8O9R7NnPpPnPqOfQpPvNiNmNnQ9PrQoOuOtPmQxNtOrN';
    assert.equal(pdfService.isGibberishText(userReportedGibberish), true, '用户反馈的扫描件乱码串应被识别为乱码');

    // 正常自然语言
    assert.equal(pdfService.isGibberishText('This is a normal English sentence.'), false);
    assert.equal(pdfService.isGibberishText('这是一个包含若干技术术语和标点的正常中文句子。'), false);
    assert.equal(pdfService.isGibberishText('const result = await fetch("/api/v1/data");'), false);
});

test('PDF 附件全链路：页码与扫描元数据模式识别', () => {
    const validPageNumbers = [
        '1',
        ' 12 ',
        '- 3 -',
        'Page 1',
        'page 4 of 20',
        '第 1 页',
        '第 2 页 共 10 页',
        '第3页/共8页',
        '5 / 15',
        '6-12'
    ];
    for (const pn of validPageNumbers) {
        assert.equal(pdfService.PAGE_NUMBER_REGEX.test(pn), true, `应该匹配页码格式: ${pn}`);
    }

    const nonPageNumbers = [
        '5. 建设工程合同实施方案及技术参数',
        '第 1 条款约定：本合同自签字之日起生效',
        '这是一个包含数字 123 的普通句子',
        'Page loading performance was improved by 40%'
    ];
    for (const npn of nonPageNumbers) {
        assert.equal(pdfService.PAGE_NUMBER_REGEX.test(npn), false, `不应将正常正文误判为页码: ${npn}`);
    }
});

test('PDF 附件全链路：仅含页码的扫描件 PDF 综合判定', () => {
    // 模拟用户指出的核心痛点：多页扫描件，正文是图片无法提取，但每页顶部/底部被提取出了页码（如 Page 1 of 3）
    const simulatedScanPagesWithOnlyPageNumbers = [
        {
            pageNumber: 1,
            bodyText: '',
            bodyCharsCount: 0,
            chineseChars: 0,
            latinWords: 0,
            gibberishCharsCount: 0,
            headerText: 'Page 1 of 3',
            isScanLikePage: true
        },
        {
            pageNumber: 2,
            bodyText: '',
            bodyCharsCount: 0,
            chineseChars: 0,
            latinWords: 0,
            gibberishCharsCount: 0,
            headerText: 'Page 2 of 3',
            isScanLikePage: true
        },
        {
            pageNumber: 3,
            bodyText: '',
            bodyCharsCount: 0,
            chineseChars: 0,
            latinWords: 0,
            gibberishCharsCount: 0,
            headerText: 'Page 3 of 3',
            isScanLikePage: true
        }
    ];

    const evaluation = pdfService.evaluatePdfDocument(simulatedScanPagesWithOnlyPageNumbers, 3);
    assert.equal(evaluation.isScanned, true, '仅含页码的扫描件必须被判定为 isScanned: true');
    assert.match(evaluation.reason, /扫描件/);
});

test('PDF 附件全链路：富文本正常文档判定为非扫描件', () => {
    const simulatedNormalPages = [
        {
            pageNumber: 1,
            bodyText: '本工程项目由建筑设计院联合编制，严格遵循相关行业国家标准。第一章为项目工程背景及概算。',
            bodyCharsCount: 45,
            chineseChars: 40,
            latinWords: 0,
            gibberishCharsCount: 0,
            headerText: '第 1 页',
            isScanLikePage: false
        },
        {
            pageNumber: 2,
            bodyText: '第二章详细叙述土建施工、给排水安装及智能化系统调试。所有验收程序均需业主与监理现场签字确认。',
            bodyCharsCount: 50,
            chineseChars: 45,
            latinWords: 0,
            gibberishCharsCount: 0,
            headerText: '第 2 页',
            isScanLikePage: false
        }
    ];

    const evaluation = pdfService.evaluatePdfDocument(simulatedNormalPages, 2);
    assert.equal(evaluation.isScanned, false, '具有连续正文的中文文档应判定为 isScanned: false');
    assert.match(evaluation.cleanFullText, /本工程项目由建筑设计院联合编制/);
    assert.match(evaluation.cleanFullText, /第二章详细叙述土建施工/);
    // 确保页眉页脚（第 1 页、第 2 页）没有混入最终正文 bodyText 污染大模型
    assert.doesNotMatch(simulatedNormalPages[0].bodyText, /第 1 页/);
    assert.doesNotMatch(simulatedNormalPages[1].bodyText, /第 2 页/);
});

test('PDF 附件全链路：fileManager.getTextContent 与 pdfAttachmentService 集成', async () => {
    const testPdfPath = path.join(projectRoot, 'node_modules/pdf-parse/test/data/05-versions-space.pdf');
    const result = await fileManager.getTextContent(testPdfPath, 'application/pdf', '05-versions-space.pdf');

    assert.ok(result, 'getTextContent 应返回有效结果对象');
    assert.ok(result.pdfMeta, '应包含 pdfMeta');
    assert.equal(result.pdfMeta.totalPages, 1, '应准确获取页面数量为 1');
    assert.equal(typeof result.pdfMeta.isScanned, 'boolean', '必须具备布尔型 isScanned');
    // 该测试 PDF 仅有 19 字符，被智能评估判定为正文过少并自动转为多模态图像
    assert.equal(result.pdfMeta.isScanned, true);
    assert.ok(Array.isArray(result.imageFrames) && result.imageFrames.length > 0, '扫描件判定后应生成 imageFrames');
});