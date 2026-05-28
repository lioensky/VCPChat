// modules/ipc/translatorHandlers.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const { PRELOAD_ROLES, resolveProjectPreload } = require('../services/preloadPaths');

let translatorWindow = null;
let mainWindow = null;
let openChildWindows = [];
let PROJECT_ROOT = null;
let APP_DATA_ROOT_IN_PROJECT = null;
let SETTINGS_FILE = null;
let isInitialized = false;

async function readTranslatorSettings() {
    try {
        if (await fs.pathExists(SETTINGS_FILE)) {
            return await fs.readJson(SETTINGS_FILE);
        }
    } catch (readError) {
        console.error('Failed to read settings file for translator window:', readError);
    }

    return {};
}

async function createOrFocusTranslatorWindow() {
    if (translatorWindow && !translatorWindow.isDestroyed()) {
        if (!translatorWindow.isVisible()) {
            translatorWindow.show();
        }
        translatorWindow.focus();
        return translatorWindow;
    }

    translatorWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        title: '翻译',
        frame: false,
        ...(process.platform === 'darwin' ? {} : { titleBarStyle: 'hidden' }),
        modal: false,
        webPreferences: {
            preload: resolveProjectPreload(PROJECT_ROOT, PRELOAD_ROLES.UTILITY),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: true
        },
        icon: path.join(PROJECT_ROOT, 'assets', 'icon.png'),
        show: false
    });

    const settings = await readTranslatorSettings();
    const vcpServerUrl = settings.vcpServerUrl || '';
    const vcpApiKey = settings.vcpApiKey || '';

    const translatorUrl = `file://${path.join(PROJECT_ROOT, 'Translatormodules', 'translator.html')}?vcpServerUrl=${encodeURIComponent(vcpServerUrl)}&vcpApiKey=${encodeURIComponent(vcpApiKey)}`;
    console.log(`[TranslatorHandlers] Attempting to load URL in translator window: ${translatorUrl.substring(0, 200)}...`);

    translatorWindow.webContents.on('did-start-loading', () => {
        console.log(`[TranslatorHandlers] translatorWindow webContents did-start-loading for URL: ${translatorUrl.substring(0, 200)}`);
    });

    translatorWindow.webContents.on('dom-ready', () => {
        if (translatorWindow && !translatorWindow.isDestroyed()) {
            console.log(`[TranslatorHandlers] translatorWindow webContents dom-ready for URL: ${translatorWindow.webContents.getURL()}`);
        }
    });

    translatorWindow.webContents.on('did-finish-load', () => {
        if (translatorWindow && !translatorWindow.isDestroyed()) {
            console.log(`[TranslatorHandlers] translatorWindow webContents did-finish-load for URL: ${translatorWindow.webContents.getURL()}`);
        }
    });

    translatorWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
        console.error(`[TranslatorHandlers] translatorWindow webContents did-fail-load: Code ${errorCode}, Desc: ${errorDescription}, URL: ${validatedURL}`);
    });

    translatorWindow.loadURL(translatorUrl)
        .then(() => {
            console.log(`[TranslatorHandlers] translatorWindow successfully initiated URL loading (loadURL resolved): ${translatorUrl.substring(0, 200)}`);
        })
        .catch((err) => {
            console.error(`[TranslatorHandlers] translatorWindow FAILED to initiate URL loading (loadURL rejected): ${translatorUrl.substring(0, 200)}`, err);
        });

    openChildWindows.push(translatorWindow);
    translatorWindow.setMenu(null);

    translatorWindow.once('ready-to-show', () => {
        if (translatorWindow && !translatorWindow.isDestroyed()) {
            console.log(`[TranslatorHandlers] translatorWindow is ready-to-show. Window Title: "${translatorWindow.getTitle()}". Calling show().`);
            translatorWindow.show();
            console.log('[TranslatorHandlers] translatorWindow show() called.');
        }
    });

    translatorWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            event.preventDefault();
            translatorWindow.hide();
        }
    });

    translatorWindow.on('closed', () => {
        console.log('[TranslatorHandlers] translatorWindow has been closed.');
        const index = openChildWindows.indexOf(translatorWindow);
        if (index > -1) {
            openChildWindows.splice(index, 1);
        }
        translatorWindow = null;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.focus();
        }
    });

    return translatorWindow;
}

function initialize(options) {
    mainWindow = options.mainWindow;
    openChildWindows = options.openChildWindows;
    PROJECT_ROOT = options.projectRoot;
    APP_DATA_ROOT_IN_PROJECT = options.APP_DATA_ROOT_IN_PROJECT;
    SETTINGS_FILE = options.SETTINGS_FILE;

    const translatorDir = path.join(APP_DATA_ROOT_IN_PROJECT, 'Translatormodules');
    fs.ensureDirSync(translatorDir);

    if (isInitialized) {
        return;
    }

    ipcMain.handle('open-translator-window', createOrFocusTranslatorWindow);

    isInitialized = true;
}

module.exports = {
    initialize,
    createOrFocusTranslatorWindow,
    getTranslatorWindow: () => translatorWindow
};