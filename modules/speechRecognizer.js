const path = require('path');
const fs = require('fs');

let browser = null;
let page = null;
let isProcessing = false; // State lock to prevent race conditions
let textCallback = null; // Store the callback function globally within the module
let lastResolvedConfigSignature = '';
let recognizerConfig = {
    browserPath: '',
    recognizerPagePath: path.join(__dirname, '..', 'Voicechatmodules', 'recognizer.html')
};

// --- Private Functions ---

function getDefaultRecognizerPagePath() {
    return path.join(__dirname, '..', 'Voicechatmodules', 'recognizer.html');
}

function resolveRecognizerPagePath(customPagePath = '') {
    const candidate = String(customPagePath || '').trim();
    if (!candidate) {
        return getDefaultRecognizerPagePath();
    }

    if (path.isAbsolute(candidate)) {
        return candidate;
    }

    return path.join(__dirname, '..', candidate);
}

function resolveRecognizerPageUrl(customPagePath = '') {
    const resolvedPath = resolveRecognizerPagePath(customPagePath);
    return `file://${resolvedPath.replace(/\\/g, '/')}`;
}

function resolveBrowserExecutablePath(puppeteer, customBrowserPath = '') {
    const customPath = String(customBrowserPath || '').trim();
    if (customPath) {
        if (fs.existsSync(customPath)) {
            console.log(`[SpeechRecognizer] Using custom browser path: ${customPath}`);
            return customPath;
        }
        console.warn(`[SpeechRecognizer] Custom browser path does not exist: ${customPath}. Falling back to auto detection.`);
    }

    let executablePath = puppeteer.executablePath();
    const platform = process.platform;
    if (platform === 'win32') {
        const chromePaths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null
        ].filter(Boolean);

        for (const p of chromePaths) {
            if (fs.existsSync(p)) {
                executablePath = p;
                console.log(`[SpeechRecognizer] Using system Chrome: ${p}`);
                break;
            }
        }
    }

    return executablePath;
}

function normalizeConfig(config = {}) {
    return {
        browserPath: String(config.browserPath || '').trim(),
        recognizerPagePath: resolveRecognizerPagePath(config.recognizerPagePath)
    };
}

function getConfigSignature(config) {
    return JSON.stringify({
        browserPath: config.browserPath || '',
        recognizerPagePath: config.recognizerPagePath || ''
    });
}

async function ensureConfigApplied(nextConfig = {}) {
    const normalized = normalizeConfig(nextConfig);
    const nextSignature = getConfigSignature(normalized);

    recognizerConfig = normalized;

    if (browser && nextSignature !== lastResolvedConfigSignature) {
        console.log('[SpeechRecognizer] Configuration changed, restarting browser instance.');
        await shutdown();
    }

    lastResolvedConfigSignature = nextSignature;
}

async function initializeBrowser() {
    if (browser) return; // Already initialized

    console.log('[SpeechRecognizer] Initializing Puppeteer browser...');
    const puppeteer = require('puppeteer'); // Lazy load
    const executablePath = resolveBrowserExecutablePath(puppeteer, recognizerConfig.browserPath);

    browser = await puppeteer.launch({
        executablePath,
        headless: true, // Set to false for debugging
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--use-fake-ui-for-media-stream',
            '--disable-gpu',
        ],
    });

    page = await browser.newPage();

    // Grant microphone permissions
    const context = browser.defaultBrowserContext();
    try {
        // Use 'file://' as origin for local files
        await context.overridePermissions('file://', ['microphone']);
    } catch (e) {
        console.warn('[SpeechRecognizer] Failed to override permissions for file://, trying specific path', e);
        await context.overridePermissions(`file://${path.join(__dirname, '..')}`, ['microphone']);
    }

    // Expose the callback function once
    await page.exposeFunction('sendTextToElectron', (text) => {
        if (textCallback && typeof textCallback === 'function') {
            textCallback(text);
        }
    });

    await page.exposeFunction('sendErrorToElectron', (error) => {
        console.error('[SpeechRecognizer] Browser Error:', error);
    });

    console.log('[SpeechRecognizer] Functions exposed.');

    const recognizerPageUrl = resolveRecognizerPageUrl(recognizerConfig.recognizerPagePath);
    console.log(`[SpeechRecognizer] Loading recognizer page: ${recognizerPageUrl}`);
    await page.goto(recognizerPageUrl);

    console.log('[SpeechRecognizer] Browser and page initialized.');
}


// --- Public API ---

async function start(callback, config = {}) {
    if (isProcessing) {
        console.log('[SpeechRecognizer] Already processing a request.');
        return;
    }
    isProcessing = true;

    try {
        // Store the callback
        if (callback) {
            textCallback = callback;
        }

        await ensureConfigApplied({
            browserPath: config.browserPath,
            recognizerPagePath: config.recognizerPagePath
        });

        // Initialize browser if it's not already running
        await initializeBrowser();

        // Start recognition on the page
        if (page) {
            await page.evaluate(() => window.startRecognition());
            console.log('[SpeechRecognizer] Recognition started on page.');
        } else {
            throw new Error("Page is not available.");
        }

    } catch (error) {
        console.error('[SpeechRecognizer] Failed to start recognition:', error);
        await shutdown(); // If start fails catastrophically, shut down everything.
    } finally {
        isProcessing = false;
    }
}

async function stop() {
    if (isProcessing || !page) {
        console.log('[SpeechRecognizer] Not running or already processing.');
        return;
    }
    isProcessing = true;

    console.log('[SpeechRecognizer] Stopping recognition on page...');
    try {
        if (page && !page.isClosed()) {
            await page.evaluate(() => window.stopRecognition());
            console.log('[SpeechRecognizer] Recognition stopped on page.');
        }
    } catch (error) {
        console.error('[SpeechRecognizer] Error stopping recognition on page:', error);
    } finally {
        isProcessing = false;
    }
}

async function shutdown() {
    console.log('[SpeechRecognizer] Shutting down Puppeteer browser...');
    if (browser) {
        try {
            await browser.close();
        } catch (error) {
            console.error('[SpeechRecognizer] Error closing browser:', error);
        }
    }
    browser = null;
    page = null;
    textCallback = null;
    isProcessing = false;
    console.log('[SpeechRecognizer] Puppeteer shut down.');
}

module.exports = {
    start,
    stop,
    shutdown // Expose the new shutdown function
};