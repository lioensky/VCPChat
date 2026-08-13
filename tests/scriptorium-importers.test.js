'use strict';

const assert = require('node:assert/strict');
const JSZip = require('jszip');
const importer = require('../modules/services/scriptoriumImportService');

async function createMinimalDocx() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
        <w:p>
            <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
            <w:r><w:t>第一章 原生共笔</w:t></w:r>
        </w:p>
        <w:p>
            <w:pPr><w:ind w:firstLineChars="200"/></w:pPr>
            <w:r><w:t>这是从 DOCX 导入的正文。</w:t></w:r>
        </w:p>
        <w:p>
            <w:r><w:tab/><w:t>段首 Tab 正文。</w:t></w:r>
        </w:p>
        <w:p/>
        <w:p>
            <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
            <w:r><w:t>设计原则</w:t></w:r>
        </w:p>
        <w:p>
            <w:r><w:rPr><w:b/></w:rPr><w:t>人类创作</w:t></w:r>
            <w:r><w:t>，AI 排版。</w:t></w:r>
        </w:p>
        <w:p>
            <w:pPr>
                <w:pStyle w:val="CustomSection"/>
                <w:pageBreakBefore/>
            </w:pPr>
            <w:r><w:t>继承样式章节</w:t></w:r>
        </w:p>
        <w:p>
            <w:r><w:t>分页后的连续正文。</w:t></w:r>
        </w:p>
        <w:sectPr/>
    </w:body>
</w:document>`);
    zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="Heading1">
        <w:name w:val="Heading 1"/>
        <w:pPr><w:jc w:val="center"/></w:pPr>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading2">
        <w:name w:val="Heading 2"/>
    </w:style>
    <w:style w:type="paragraph" w:styleId="CustomSection">
        <w:name w:val="自定义章节"/>
        <w:basedOn w:val="Heading2"/>
    </w:style>
</w:styles>`);
    zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    return zip.generateAsync({ type: 'nodebuffer' });
}

async function createMinimalPptx() {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Default Extension="png" ContentType="image/png"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
    <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);
    zip.folder('ppt').file('presentation.xml', `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:sldIdLst>
        <p:sldId id="256" r:id="rId2"/>
        <p:sldId id="257" r:id="rId1"/>
    </p:sldIdLst>
    <p:sldSz cx="12192000" cy="6858000"/>
</p:presentation>`);
    zip.folder('ppt').folder('_rels').file('presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
    <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
</Relationships>`);

    const slide = (title, includePicture, includeAnimation) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
    <p:cSld><p:spTree>
        <p:nvGrpSpPr/><p:grpSpPr/>
        <p:sp>
            <p:nvSpPr><p:cNvPr id="2" name="${title}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
            <p:spPr>
                <a:xfrm rot="900000"><a:off x="914400" y="685800"/><a:ext cx="4572000" cy="914400"/></a:xfrm>
                <a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill>
                <a:ln w="12700"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:ln>
            </p:spPr>
            <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="ctr"/>
                <a:r><a:rPr sz="2400" b="1"><a:solidFill><a:srgbClr val="445566"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${title} & 共创</a:t></a:r>
            </a:p></p:txBody>
        </p:sp>
        ${includePicture ? `<p:pic>
            <p:nvPicPr><p:cNvPr id="3" name="示例图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
            <p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill>
            <p:spPr><a:xfrm><a:off x="6096000" y="1371600"/><a:ext cx="3048000" cy="2286000"/></a:xfrm></p:spPr>
        </p:pic>` : ''}
    </p:spTree></p:cSld>
    ${includeAnimation ? '<p:transition/><p:timing><p:tnLst/></p:timing>' : ''}
</p:sld>`;

    zip.folder('ppt').folder('slides').file('slide1.xml', slide('原始第一页', false, false));
    zip.folder('ppt').folder('slides').file('slide2.xml', slide('先展示的第二页', true, true));
    zip.folder('ppt').folder('slides').folder('_rels').file('slide2.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
</Relationships>`);
    zip.folder('ppt').folder('media').file(
        'image1.png',
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
    );
    return zip.generateAsync({ type: 'nodebuffer' });
}

async function run() {
    assert.equal(importer.headingLevelFromText('第一章 原生共笔'), 1);
    assert.equal(importer.headingLevelFromText('第十三章：终幕'), 1);
    assert.equal(importer.headingLevelFromText('第 13 章 结语'), 1);
    assert.equal(importer.headingLevelFromText('这是第十三章的正文内容。'), null);

    const pageBreakParagraphs = importer.parseDocxParagraphs(`
        <w:p><w:r><w:lastRenderedPageBreak/><w:t>自动分页后的正文</w:t></w:r></w:p>
        <w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>手工分页后的正文</w:t></w:r></w:p>
    `, new Map());
    assert.equal(pageBreakParagraphs[0].pageBreakBefore, false);
    assert.equal(pageBreakParagraphs[0].pageBreakAfter, false);
    assert.equal(pageBreakParagraphs[1].pageBreakBefore, true);

    assert.deepEqual(
        importer.parseDocxParagraphFormat(
            '<w:jc w:val="center"/><w:ind w:firstLineChars="200" w:left="720"/>'
        ),
        {
            textAlign: 'center',
            textIndent: '2em',
            textIndentExplicit: true,
            marginLeft: '36pt',
            marginRight: '',
        }
    );
    assert.equal(
        importer.parseDocxParagraphFormat(
            '<w:ind w:firstLine="0"/>'
        ).textIndentExplicit,
        true
    );

    const normalizedIndentedSource = importer.htmlToHybridMarkdown([
        '<p style="text-indent:2em">两字符<strong>粗体</strong>正文。</p>',
        '<p style="text-indent:21pt">磅值<strong>粗体</strong>正文。</p>',
    ].join(''));
    assert.match(normalizedIndentedSource, /　　两字符\*\*粗体\*\*正文。/);
    assert.match(normalizedIndentedSource, /　　磅值\*\*粗体\*\*正文。/);
    assert.doesNotMatch(normalizedIndentedSource, /<p\b|<strong\b|text-indent/);

    const compositeStyledSource = importer.htmlToHybridMarkdown(
        '<p style="text-indent:2em;text-align:justify">保真<strong>粗体</strong>正文。</p>'
    );
    assert.match(
        compositeStyledSource,
        /<p style="text-indent:2em;text-align:justify">保真<strong>粗体<\/strong>正文。<\/p>/
    );

    const dominantIndentParagraphs = [
        ...Array.from({ length: 3 }, (_, index) => ({
            text: `已有缩进正文 ${index}`,
            paragraphFormat: {
                textAlign: index === 0 ? 'justify' : '',
                textIndent: '2em',
                textIndentExplicit: true,
            },
            headingLevel: null,
            hasLeadingWhitespace: false,
            hasNumbering: false,
        })),
        {
            text: '应自动补齐',
            paragraphFormat: {},
            headingLevel: null,
            hasLeadingWhitespace: false,
            hasNumbering: false,
        },
        {
            text: '　已有全角空格',
            paragraphFormat: {},
            headingLevel: null,
            hasLeadingWhitespace: true,
            hasNumbering: false,
        },
        {
            text: '显式零缩进',
            paragraphFormat: { textIndentExplicit: true },
            headingLevel: null,
            hasLeadingWhitespace: false,
            hasNumbering: false,
        },
        {
            text: '居中文本',
            paragraphFormat: { textAlign: 'center' },
            headingLevel: null,
            hasLeadingWhitespace: false,
            hasNumbering: false,
        },
        {
            text: '编号文本',
            paragraphFormat: {},
            headingLevel: null,
            hasLeadingWhitespace: false,
            hasNumbering: true,
        },
        {
            text: '标题文本',
            paragraphFormat: {},
            headingLevel: 1,
            hasLeadingWhitespace: false,
            hasNumbering: false,
        },
    ];
    importer.applyDominantDocxTextIndent(dominantIndentParagraphs);
    assert.equal(dominantIndentParagraphs[3].paragraphFormat.textIndent, '2em');
    assert.equal(dominantIndentParagraphs[3].paragraphFormat.textIndentInferred, true);
    for (const index of [4, 5, 6, 7, 8]) {
        assert.equal(dominantIndentParagraphs[index].paragraphFormat.textIndent, undefined);
    }

    const markdownSource = `# 总论\r\n\r\n人类负责**创作**，AI 负责排版。\r\n\r\n## 数学\r\n\r\n行内公式 $E=mc^2$。\r\n\r\n$$\r\n\\int_0^1 x^2\\,dx\r\n$$\r\n\r\n| 名称 | 数值 |\r\n| --- | ---: |\r\n| 创作 | 1 |\r\n\r\n\`\`\`javascript\r\nconst answer = 42;\r\n\`\`\`\r\n`;
    const markdown = await importer.importBuffer(
        '思想.md',
        Buffer.from(markdownSource)
    );
    assert.equal(markdown.kind, 'markdown');
    assert.equal(markdown.source, markdownSource);
    assert.equal(markdown.html, '');
    assert.equal(markdown.sourceFormat, 'markdown-hybrid');
    assert.equal(markdown.lineEnding, 'crlf');
    assert.equal(markdown.importMetadata.sourceFormat, 'markdown');
    assert.equal(markdown.importMetadata.documentSourceFormat, 'markdown-hybrid');
    assert.match(markdown.importMetadata.importer, /original-source-import-v6/);

    const textSource = '第一段。\n仍在第一段。\n\n第二段。';
    const text = await importer.importBuffer(
        '手稿.txt',
        Buffer.from(textSource)
    );
    assert.equal(text.kind, 'text');
    assert.equal(text.source, textSource);
    assert.equal(text.sourceFormat, 'markdown-hybrid');
    assert.equal(text.html, '');

    const rtf = await importer.importBuffer(
        '旧稿.rtf',
        Buffer.from(String.raw`{\rtf1\ansi 标题\par 正文\u20013?内容。}`)
    );
    assert.equal(rtf.kind, 'rtf');
    assert.match(rtf.source, /标题/);
    assert.match(rtf.source, /正文中内容/);
    assert.equal(rtf.sourceFormat, 'markdown-hybrid');
    assert.equal(rtf.html, '');

    const docx = await importer.importBuffer('旧文档.docx', await createMinimalDocx());
    assert.equal(docx.kind, 'docx');
    assert.match(docx.source, /第一章 原生共笔/);
    assert.match(docx.source, /## 设计原则/);
    assert.match(docx.source, /　　这是从 DOCX 导入的正文。/);
    assert.match(docx.source, /　　段首 Tab 正文。/);
    assert.doesNotMatch(docx.source, /<p style="text-indent:(?:2em|21pt)"/);
    assert.doesNotMatch(docx.source, /data-vdoc-(?:text|block|container)=/);
    assert.match(docx.source, /\*\*人类创作\*\*/);
    assert.match(docx.source, /继承样式章节/);
    assert.match(docx.source, /分页后的连续正文。/);
    assert.equal(docx.sourceFormat, 'markdown-hybrid');
    assert.equal(docx.html, '');
    assert.equal(docx.importMetadata.sourceFormat, 'docx');
    assert.match(docx.importMetadata.importer, /semantic-import-v5/);

    const pptx = await importer.importBuffer('静态演示.pptx', await createMinimalPptx());
    assert.equal(pptx.kind, 'pptx');
    assert.equal(pptx.html, '');
    assert.equal(pptx.slides.length, 2);
    assert.deepEqual(pptx.page, { width: '13.333333333333334in', height: '7.5in' });
    assert.match(pptx.slides[0].source, /先展示的第二页 &#38; 共创/);
    assert.match(pptx.slides[1].source, /原始第一页 &#38; 共创/);
    assert.equal(pptx.slides[0].name, '先展示的第二页 & 共创');
    assert.match(pptx.slides[0].source, /left:7\.50000%;top:10\.00000%/);
    assert.match(pptx.slides[0].source, /z-index:1/);
    assert.match(pptx.slides[0].source, /transform:rotate\(15deg\)/);
    assert.match(pptx.slides[0].source, /left:50\.00000%;top:20\.00000%/);
    assert.match(pptx.slides[0].source, /z-index:2/);
    assert.match(pptx.slides[0].source, /font-size:24pt/);
    assert.match(pptx.slides[0].source, /font-weight:700/);
    assert.match(pptx.slides[0].source, /font-family:&#34;Arial&#34;/);
    assert.match(pptx.slides[0].source, /data:image\/png;base64,/);
    assert.equal(pptx.slides[0].transition, 'pptx-imported');
    assert.equal(pptx.slides[0].import.sourceSlide, 'ppt/slides/slide2.xml');
    assert.equal(pptx.slides[0].import.hadNativeAnimation, true);
    assert.equal(pptx.importMetadata.warnings.length, 1);
    assert.equal(pptx.importMetadata.warnings[0].type, 'animation-not-translated');
    assert.equal(pptx.importMetadata.sourceFormat, 'pptx');
    assert.match(pptx.importMetadata.importer, /semantic-import-v5/);

    console.log('[ScriptoriumImporters] PASSED', {
        markdownBytesPreserved: markdown.source === markdownSource,
        docxWarnings: docx.importMetadata.warnings.length,
        pptxSlides: pptx.slides.length,
        pptxWarnings: pptx.importMetadata.warnings.length,
    });
}

run().catch((error) => {
    console.error('[ScriptoriumImporters] FAILED', error);
    process.exitCode = 1;
});