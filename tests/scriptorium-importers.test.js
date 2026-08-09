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
            <w:r><w:t>这是从 DOCX 导入的正文。</w:t></w:r>
        </w:p>
        <w:p>
            <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
            <w:r><w:t>设计原则</w:t></w:r>
        </w:p>
        <w:p>
            <w:r><w:rPr><w:b/></w:rPr><w:t>人类创作</w:t></w:r>
            <w:r><w:t>，AI 排版。</w:t></w:r>
        </w:p>
        <w:sectPr/>
    </w:body>
</w:document>`);
    zip.folder('word').file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:style w:type="paragraph" w:styleId="Heading1">
        <w:name w:val="Heading 1"/>
    </w:style>
    <w:style w:type="paragraph" w:styleId="Heading2">
        <w:name w:val="Heading 2"/>
    </w:style>
</w:styles>`);
    zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    return zip.generateAsync({ type: 'nodebuffer' });
}

async function run() {
    const markdown = await importer.importBuffer(
        '思想.md',
        Buffer.from(`# 总论

人类负责**创作**，AI 负责排版。

## 数学

行内公式 $E=mc^2$。

$$
\\int_0^1 x^2\\,dx
$$`)
    );
    assert.equal(markdown.kind, 'markdown');
    assert.match(markdown.html, /<h1>总论<\/h1>/);
    assert.match(markdown.html, /<h2>数学<\/h2>/);
    assert.match(markdown.html, /<strong>创作<\/strong>/);
    assert.match(markdown.html, /data-vdoc-math="E%3Dmc%5E2"/);
    assert.match(markdown.html, /data-vdoc-display="true"/);
    assert.equal(markdown.importMetadata.sourceFormat, 'markdown');

    const text = await importer.importBuffer(
        '手稿.txt',
        Buffer.from('第一段。\n仍在第一段。\n\n第二段。')
    );
    assert.equal(text.kind, 'text');
    assert.match(text.html, /<p>第一段。<br>仍在第一段。<\/p>/);
    assert.match(text.html, /<p>第二段。<\/p>/);

    const rtf = await importer.importBuffer(
        '旧稿.rtf',
        Buffer.from(String.raw`{\rtf1\ansi 标题\par 正文\u20013?内容。}`)
    );
    assert.equal(rtf.kind, 'rtf');
    assert.match(rtf.html, /<p>标题<\/p>/);
    assert.match(rtf.html, /正文中内容/);

    const docx = await importer.importBuffer('旧文档.docx', await createMinimalDocx());
    assert.equal(docx.kind, 'docx');
    assert.match(docx.html, /<h1>第一章 原生共笔<\/h1>/);
    assert.match(docx.html, /<h2>设计原则<\/h2>/);
    assert.match(docx.html, /<p>这是从 DOCX 导入的正文。<\/p>/);
    assert.match(docx.html, /<strong>人类创作<\/strong>/);
    assert.equal(docx.importMetadata.sourceFormat, 'docx');
    assert.match(docx.importMetadata.importer, /semantic-import-v1/);

    console.log('[ScriptoriumImporters] PASSED', {
        markdownMathNodes: (markdown.html.match(/data-vdoc-math=/g) || []).length,
        docxWarnings: docx.importMetadata.warnings.length,
    });
}

run().catch((error) => {
    console.error('[ScriptoriumImporters] FAILED', error);
    process.exitCode = 1;
});