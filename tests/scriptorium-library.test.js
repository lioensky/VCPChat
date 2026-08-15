'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('fs-extra');
const { JSDOM } = require('jsdom');
const libraryModule = require(
    '../ScriptoriumModules/scriptorium-library'
);
const {
    scanDocumentLibraryDirectory,
} = require('../modules/ipc/docxHandlers');

function createLibraryPayload() {
    return {
        success: true,
        extensions: [
            'vdocx', 'docx', 'vpptx', 'pptx', 'txt', 'html', 'md',
        ],
        roots: [
            {
                id: 'documents',
                label: '用户文档',
                description: 'VDOCX 与导入文档',
                path: 'AppData/ScriptoriumDocument/VDOCX',
                children: [
                    {
                        type: 'file',
                        name: '原生文稿.vdocx',
                        path: 'AppData/ScriptoriumDocument/VDOCX/原生文稿.vdocx',
                        extension: 'vdocx',
                        size: 1048576,
                    },
                    {
                        type: 'file',
                        name: 'Word文稿.docx',
                        path: 'AppData/ScriptoriumDocument/VDOCX/Word文稿.docx',
                        extension: 'docx',
                        size: 4096,
                    },
                ],
            },
            {
                id: 'presentations',
                label: '用户演示',
                description: 'VPPTX 与 PowerPoint 演示',
                path: 'ScriptoriumDocument/VPPTX',
                children: [
                    {
                        type: 'file',
                        name: '原生演示.vpptx',
                        path: 'ScriptoriumDocument/VPPTX/原生演示.vpptx',
                        extension: 'vpptx',
                        size: 8192,
                    },
                    {
                        type: 'file',
                        name: '传统演示.pptx',
                        path: 'ScriptoriumDocument/VPPTX/传统演示.pptx',
                        extension: 'pptx',
                        size: 16384,
                    },
                ],
            },
            {
                id: 'notes',
                label: '用户笔记',
                description: 'Markdown 与纯文本笔记',
                path: 'AppData/Notemodules',
                children: [
                    {
                        type: 'directory',
                        name: '项目',
                        path: 'AppData/Notemodules/项目',
                        children: [
                            {
                                type: 'file',
                                name: '计划.md',
                                path: 'AppData/Notemodules/项目/计划.md',
                                extension: 'md',
                                size: 1536,
                            },
                            {
                                type: 'directory',
                                name: '归档',
                                path: 'AppData/Notemodules/项目/归档',
                                children: [{
                                    type: 'file',
                                    name: '记录.txt',
                                    path: 'AppData/Notemodules/项目/归档/记录.txt',
                                    extension: 'txt',
                                    size: 10,
                                }],
                            },
                        ],
                    },
                    {
                        type: 'file',
                        name: '网页.html',
                        path: 'AppData/Notemodules/网页.html',
                        extension: 'html',
                        size: 2048,
                    },
                ],
            },
        ],
    };
}

function createDom() {
    return new JSDOM(`<!doctype html>
        <body>
            <button id="library-refresh-btn">刷新</button>
            <div id="document-library-tree" role="tree"></div>
        </body>`);
}

async function testDirectoryScanner() {
    const temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'scriptorium-library-')
    );
    try {
        await fs.outputFile(
            path.join(temporaryRoot, '甲目录', '深层', '计划.md'),
            '# 计划'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '甲目录', '说明.txt'),
            '说明'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '乙目录', '演示.pptx'),
            'pptx'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '原生文稿.vdocx'),
            'vdocx'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '网页.HTML'),
            '<h1>网页</h1>'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '忽略.pdf'),
            'pdf'
        );
        await fs.outputFile(
            path.join(temporaryRoot, '.隐藏.md'),
            'hidden'
        );
        await fs.ensureDir(path.join(temporaryRoot, '空目录'));

        const entries = await scanDocumentLibraryDirectory(temporaryRoot);
        assert.deepEqual(
            entries.map((entry) => entry.name),
            ['甲目录', '乙目录', '网页.HTML', '原生文稿.vdocx']
        );
        assert.equal(entries[0].type, 'directory');
        assert.equal(entries[0].children[0].name, '深层');
        assert.equal(
            entries[0].children[0].children[0].extension,
            'md'
        );
        assert.equal(entries[0].children[1].extension, 'txt');
        assert.equal(entries[1].children[0].extension, 'pptx');
        assert.equal(entries[2].extension, 'html');
        assert.equal(entries[3].extension, 'vdocx');
        assert.equal(
            entries.some((entry) => entry.name === '空目录'),
            false
        );
        assert.equal(
            entries.some((entry) => entry.name === '忽略.pdf'),
            false
        );
        assert.equal(
            entries.some((entry) => entry.name === '.隐藏.md'),
            false
        );
        return entries;
    } finally {
        await fs.remove(temporaryRoot);
    }
}

async function run() {
    const scannedEntries = await testDirectoryScanner();
    assert.equal(libraryModule.formatFileSize(0), '0 B');
    assert.equal(libraryModule.formatFileSize(1536), '1.5 KB');
    assert.equal(libraryModule.formatFileSize(1048576), '1.0 MB');
    assert.equal(libraryModule.countFiles([]), 0);
    assert.equal(
        libraryModule.countFiles(createLibraryPayload().roots[2].children),
        3
    );
    assert.equal(libraryModule.ROOT_ICONS.fonts, 'F');
    assert.equal(libraryModule.ROOT_ICONS.styles, 'S');
    assert.equal(libraryModule.ROOT_ICONS.graphics, 'G');
    assert.throws(
        () => libraryModule.validateLibraryResult({ success: true }),
        /无效数据/
    );
    assert.throws(
        () => libraryModule.validateLibraryResult({
            success: true,
            roots: [{ id: 'broken' }],
        }),
        /无效根节点/
    );

    const dom = createDom();
    const document = dom.window.document;
    const elements = {
        'library-refresh-btn':
            document.getElementById('library-refresh-btn'),
        'document-library-tree':
            document.getElementById('document-library-tree'),
    };
    const openedPaths = [];
    let requests = 0;
    const controller = libraryModule.createLibraryController({
        document,
        elements,
        persistencePort: {
            async listDocumentLibrary() {
                requests += 1;
                return createLibraryPayload();
            },
        },
        openPath(filePath) {
            openedPaths.push(filePath);
        },
    });

    controller.bind();
    assert.equal(await controller.refresh(), true);
    assert.equal(requests, 1);
    assert.equal(
        elements['document-library-tree'].hasAttribute('aria-busy'),
        false
    );
    assert.equal(elements['library-refresh-btn'].disabled, false);

    const roots = [
        ...document.querySelectorAll('.library-root'),
    ];
    assert.equal(roots.length, 3);
    assert.deepEqual(
        roots.map((root) =>
            root.querySelector('.library-root-copy strong').textContent
        ),
        ['用户文档', '用户演示', '用户笔记']
    );
    assert.deepEqual(
        roots.map((root) =>
            root.querySelector('.library-root-icon').textContent
        ),
        ['D', 'P', 'N']
    );
    assert.ok(roots.every((root) => root.open));

    const directories = [
        ...document.querySelectorAll('.library-directory'),
    ];
    assert.equal(directories.length, 2);
    assert.equal(
        directories[0].querySelector('.library-directory-count').textContent,
        '2'
    );
    assert.equal(
        directories[1].querySelector('.library-directory-count').textContent,
        '1'
    );

    const files = [
        ...document.querySelectorAll('.library-file'),
    ];
    assert.equal(files.length, 7);
    assert.deepEqual(
        files.map((file) => file.dataset.extension).sort(),
        ['docx', 'html', 'md', 'pptx', 'txt', 'vdocx', 'vpptx']
    );
    assert.deepEqual(
        files.map((file) =>
            file.querySelector('.library-file-badge').textContent
                .toLowerCase()
        ).sort(),
        ['docx', 'html', 'md', 'pptx', 'txt', 'vdocx', 'vpptx']
    );
    assert.equal(
        files.find((file) => file.dataset.extension === 'md')
            .querySelector('.library-file-copy small').textContent,
        '1.5 KB'
    );

    files.find((file) => file.dataset.extension === 'pptx').click();
    assert.deepEqual(openedPaths, [
        'ScriptoriumDocument/VPPTX/传统演示.pptx',
    ]);

    elements['library-refresh-btn'].click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(requests, 2);

    controller.dispose();
    elements['library-refresh-btn'].click();
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    assert.equal(requests, 2);
    assert.equal(await controller.refresh(), false);

    const failureDom = createDom();
    const failureDocument = failureDom.window.document;
    const failureHost = failureDocument.getElementById(
        'document-library-tree'
    );
    const failureController = libraryModule.createLibraryController({
        document: failureDocument,
        elements: {
            'library-refresh-btn': failureDocument.getElementById(
                'library-refresh-btn'
            ),
            'document-library-tree': failureHost,
        },
        persistencePort: {
            async listDocumentLibrary() {
                return { success: true, roots: null };
            },
        },
        openPath() {},
    });
    assert.equal(await failureController.refresh(), false);
    assert.match(
        failureHost.querySelector('.library-error').textContent,
        /文档目录读取失败/
    );
    assert.equal(failureHost.hasAttribute('aria-busy'), false);

    console.log('[ScriptoriumLibrary] PASSED', {
        scannedEntries: scannedEntries.length,
        roots: roots.length,
        directories: directories.length,
        files: files.length,
        refreshRequests: requests,
    });
}

run().catch((error) => {
    console.error('[ScriptoriumLibrary] FAILED', error);
    process.exitCode = 1;
});