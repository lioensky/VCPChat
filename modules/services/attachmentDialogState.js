const fs = require('fs-extra');
const path = require('path');

const LAST_ATTACHMENT_DIRECTORY_KEY = 'lastAttachmentDirectory';

async function resolveRememberedAttachmentDirectory(settingsManager, fsApi = fs) {
    if (!settingsManager || typeof settingsManager.readSettings !== 'function') {
        return null;
    }

    const settings = await settingsManager.readSettings();
    const rememberedDirectory = settings?.[LAST_ATTACHMENT_DIRECTORY_KEY];
    if (typeof rememberedDirectory !== 'string' || !rememberedDirectory.trim()) {
        return null;
    }

    try {
        const stats = await fsApi.stat(rememberedDirectory);
        return stats.isDirectory() ? rememberedDirectory : null;
    } catch {
        return null;
    }
}

async function rememberAttachmentDirectory(settingsManager, selectedFilePath) {
    if (
        !settingsManager
        || typeof settingsManager.updateSettings !== 'function'
        || typeof selectedFilePath !== 'string'
        || !selectedFilePath.trim()
    ) {
        return false;
    }

    const directory = path.dirname(selectedFilePath);
    await settingsManager.updateSettings(currentSettings => ({
        ...currentSettings,
        [LAST_ATTACHMENT_DIRECTORY_KEY]: directory
    }));
    return true;
}

module.exports = {
    LAST_ATTACHMENT_DIRECTORY_KEY,
    resolveRememberedAttachmentDirectory,
    rememberAttachmentDirectory
};