// modules/ipc/emoticonHandlers.js

const { ipcMain } = require('electron');
const fs = require('fs-extra');
const path = require('path');
const { URL } = require('url');

let emoticonLibrary = [];
let settingsFilePath;
let generatedListsPath;
let emoticonLibraryPath;
let degradedReason = null;
let hasWarnedForCurrentReason = false;

function setDegradedState(reason) {
    emoticonLibrary = [];
    if (degradedReason === reason && hasWarnedForCurrentReason) {
        return;
    }

    degradedReason = reason;
    hasWarnedForCurrentReason = true;
    console.warn(`[EmoticonFixer] Emoji library degraded: ${reason}`);
}

function clearDegradedState() {
    degradedReason = null;
    hasWarnedForCurrentReason = false;
}

async function initialize(paths) {
    settingsFilePath = paths.SETTINGS_FILE;
    generatedListsPath = path.join(paths.APP_DATA_ROOT_IN_PROJECT, 'generated_lists');
    emoticonLibraryPath = path.join(generatedListsPath, 'emoticon_library.json');
}

async function generateEmoticonLibrary() {
    console.log('[EmoticonFixer] Starting to generate emoticon library...');

    try {
        if (!await fs.pathExists(generatedListsPath)) {
            setDegradedState(`missing generated_lists directory at ${generatedListsPath}`);
            return [];
        }

        const settings = await fs.readJson(settingsFilePath);
        const vcpServerUrl = settings.vcpServerUrl;
        if (!vcpServerUrl) {
            setDegradedState('missing vcpServerUrl in settings.json');
            return [];
        }

        const configEnvPath = path.join(generatedListsPath, 'config.env');
        if (!await fs.pathExists(configEnvPath)) {
            setDegradedState(`missing config.env at ${configEnvPath}`);
            return [];
        }

        const configContent = await fs.readFile(configEnvPath, 'utf-8');
        const passwordMatch = configContent.match(/^\s*file_key\s*=\s*(.+)\s*$/m);
        if (!passwordMatch || !passwordMatch[1]) {
            setDegradedState(`missing file_key in ${configEnvPath}`);
            return [];
        }

        const password = passwordMatch[1].trim();
        const urlObject = new URL(vcpServerUrl);
        const baseUrl = `${urlObject.protocol}//${urlObject.host}`;
        const files = await fs.readdir(generatedListsPath);
        const txtFiles = files.filter(file => file.endsWith('表情包.txt'));

        const library = [];
        for (const txtFile of txtFiles) {
            const category = path.basename(txtFile, '.txt');
            const filePath = path.join(generatedListsPath, txtFile);
            const fileContent = await fs.readFile(filePath, 'utf-8');
            const filenames = fileContent.split('|').filter(name => name.trim() !== '');

            for (const filename of filenames) {
                const encodedFilename = encodeURIComponent(filename);
                const encodedCategory = encodeURIComponent(category);
                const fullUrl = `${baseUrl}/pw=${password}/images/${encodedCategory}/${encodedFilename}`;

                library.push({
                    url: fullUrl,
                    category,
                    filename,
                    searchKey: `${category.toLowerCase()}/${filename.toLowerCase()}`
                });
            }
        }

        await fs.writeJson(emoticonLibraryPath, library, { spaces: 2 });
        emoticonLibrary = library;
        clearDegradedState();
        console.log(`[EmoticonFixer] Successfully generated emoticon library with ${library.length} items.`);
        return library;
    } catch (error) {
        setDegradedState(error.message || 'unexpected generator error');
        return [];
    }
}

function setupEmoticonHandlers() {
    generateEmoticonLibrary();

    ipcMain.handle('get-emoticon-library', async () => {
        if (degradedReason) {
            return [];
        }

        if (emoticonLibrary.length === 0 && await fs.pathExists(emoticonLibraryPath)) {
            try {
                emoticonLibrary = await fs.readJson(emoticonLibraryPath);
            } catch (error) {
                setDegradedState(`failed to read cache ${emoticonLibraryPath}: ${error.message}`);
                return [];
            }
        }

        return emoticonLibrary;
    });

    ipcMain.on('regenerate-emoticon-library', async () => {
        clearDegradedState();
        await generateEmoticonLibrary();
    });
}

module.exports = {
    initialize,
    setupEmoticonHandlers,
    getEmoticonLibrary: () => degradedReason ? [] : emoticonLibrary
};
