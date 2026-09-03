import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

function setupDom() {
    const root = process.cwd();
    const dom = new JSDOM("<!doctype html><html><body><div id=\"modal-container\"></div><div id=\"globalSettingsModal\" class=\"modal\"><div class=\"modal-content\"><button class=\"close-button\">×</button><form id=\"globalSettingsForm\"></form></div></div></body></html>", { runScripts: "dangerously" });
    const helpersCode = fs.readFileSync(path.join(root, "modules/ui-helpers.js"), "utf8");
    dom.window.eval(helpersCode);
    return dom;
}

test("Stress: closeModal unconditionally closes modal under rapid dirty edits", async () => {
    const dom = setupDom();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCustomEvent = globalThis.CustomEvent;

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;

    const uiHelpers = dom.window.uiHelperFunctions;
    const modal = dom.window.document.getElementById("globalSettingsModal");
    const form = dom.window.document.getElementById("globalSettingsForm");

    try {
        for (let round = 1; round <= 30; round++) {
            modal.classList.add("active");
            form.dataset.vcpSettingsDirty = "true";
            form.dataset.vcpAutosaveState = "saving";

            let flushCalled = false;
            dom.window.VCPUISettingsBridge = {
                flush: () => new Promise(resolve => {
                    flushCalled = true;
                    setTimeout(() => {
                        resolve({ status: round % 2 === 0 ? "saved" : "error" });
                    }, 20);
                }),
                getSnapshot: () => ({ status: "saving", pendingOps: [{ path: ["userName"] }] }),
            };

            const closed = uiHelpers.closeModal("globalSettingsModal");
            assert.equal(closed, true, "Round " + round + ": closeModal must return true");
            assert.equal(modal.classList.contains("active"), false, "Round " + round + ": modal must immediately lose active class");

            await new Promise(resolve => setTimeout(resolve, 40));
            assert.equal(modal.classList.contains("active"), false, "Round " + round + ": modal must stay closed after flush settles");
            assert.equal(flushCalled, true, "Round " + round + ": flush must be triggered in background");
        }
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.CustomEvent = previousCustomEvent;
    }
});

test("Stress: rapid spamming of openModal and closeModal preserves deterministic state", async () => {
    const dom = setupDom();
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousCustomEvent = globalThis.CustomEvent;

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.CustomEvent = dom.window.CustomEvent;

    const uiHelpers = dom.window.uiHelperFunctions;
    const modal = dom.window.document.getElementById("globalSettingsModal");

    try {
        let openEvents = 0;
        let closeEvents = 0;
        dom.window.document.addEventListener("modal-visibility-changed", (e) => {
            if (e.detail.modalId === "globalSettingsModal") {
                if (e.detail.active) openEvents++;
                else closeEvents++;
            }
        });

        for (let i = 0; i < 50; i++) {
            uiHelpers.openModal("globalSettingsModal");
            assert.equal(modal.classList.contains("active"), true);
            uiHelpers.closeModal("globalSettingsModal");
            assert.equal(modal.classList.contains("active"), false);
        }

        assert.equal(openEvents, 50, "All 50 open events dispatched");
        assert.equal(closeEvents, 50, "All 50 close events dispatched");
        assert.equal(modal.classList.contains("active"), false, "Modal ends cleanly closed");
    } finally {
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.CustomEvent = previousCustomEvent;
    }
});
