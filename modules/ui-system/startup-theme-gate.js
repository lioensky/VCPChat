// Bounded startup gate for the canonical main-chat document.

export function withTimeout(promise, timeoutMs, message = 'Operation timed out', timers = globalThis) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
        timers.clearTimeout(timer);
    });
}

export async function loadSettingsWithTimeout(loadSettings, timeoutMs, message = 'Settings load timed out', timers = globalThis) {
    if (typeof loadSettings !== 'function') throw new Error('Settings API unavailable');
    return withTimeout(loadSettings(), timeoutMs, message, timers);
}

export class StartupThemeGate {
    constructor({ document = globalThis.document, applyTheme, statusElement = null } = {}) {
        if (typeof applyTheme !== 'function') throw new TypeError('StartupThemeGate requires applyTheme.');
        this.document = document;
        this.applyTheme = applyTheme;
        this.statusElement = statusElement;
        this.released = false;
    }

    release({ mode = 'system', message = '' } = {}) {
        if (!this.released) {
            this.released = true;
            this.applyTheme(mode);
        }
        if (this.statusElement && message) {
            this.statusElement.textContent = message;
            this.statusElement.hidden = false;
        }
        return this.released;
    }
}
