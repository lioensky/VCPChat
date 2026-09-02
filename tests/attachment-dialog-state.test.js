const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
    LAST_ATTACHMENT_DIRECTORY_KEY,
    resolveRememberedAttachmentDirectory,
    rememberAttachmentDirectory
} = require('../modules/services/attachmentDialogState');

function createSettingsManager(initialSettings = {}) {
    let settings = { ...initialSettings };
    return {
        readSettings: async () => ({ ...settings }),
        updateSettings: async updater => {
            settings = typeof updater === 'function'
                ? await updater({ ...settings })
                : { ...settings, ...updater };
            return { success: true, settings: { ...settings } };
        },
        snapshot: () => ({ ...settings })
    };
}

test('returns a remembered attachment directory when it still exists', async () => {
    const directory = path.join('C:', 'Users', 'tester', 'Documents');
    const settingsManager = createSettingsManager({
        [LAST_ATTACHMENT_DIRECTORY_KEY]: directory
    });
    const fsApi = {
        stat: async candidate => {
            assert.equal(candidate, directory);
            return { isDirectory: () => true };
        }
    };

    assert.equal(
        await resolveRememberedAttachmentDirectory(settingsManager, fsApi),
        directory
    );
});

test('ignores a remembered path that no longer exists', async () => {
    const settingsManager = createSettingsManager({
        [LAST_ATTACHMENT_DIRECTORY_KEY]: path.join('C:', 'missing')
    });
    const fsApi = {
        stat: async () => {
            const error = new Error('missing');
            error.code = 'ENOENT';
            throw error;
        }
    };

    assert.equal(
        await resolveRememberedAttachmentDirectory(settingsManager, fsApi),
        null
    );
});

test('ignores a remembered path that points to a file', async () => {
    const settingsManager = createSettingsManager({
        [LAST_ATTACHMENT_DIRECTORY_KEY]: path.join('C:', 'tmp', 'note.txt')
    });
    const fsApi = {
        stat: async () => ({ isDirectory: () => false })
    };

    assert.equal(
        await resolveRememberedAttachmentDirectory(settingsManager, fsApi),
        null
    );
});

test('persists the parent directory of the first selected attachment', async () => {
    const settingsManager = createSettingsManager({ userName: '用户' });
    const selectedFile = path.join('D:', '素材', '图片', 'sample.png');

    assert.equal(
        await rememberAttachmentDirectory(settingsManager, selectedFile),
        true
    );
    assert.deepEqual(settingsManager.snapshot(), {
        userName: '用户',
        [LAST_ATTACHMENT_DIRECTORY_KEY]: path.dirname(selectedFile)
    });
});

test('safely degrades when settings persistence is unavailable', async () => {
    assert.equal(await resolveRememberedAttachmentDirectory(null), null);
    assert.equal(
        await rememberAttachmentDirectory(null, path.join('D:', 'sample.png')),
        false
    );
});