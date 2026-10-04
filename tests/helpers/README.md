# Electron integration entries

The six `scriptorium-*-electron.test.js` files run through the ordinary Node test command:

```powershell
node --test tests/scriptorium-markdown-linebreak-electron.test.js
```

At startup they delegate to `electron-test-entry.cjs`. Node owns one test result and launches the repository's installed Electron. `electron-test-main.cjs` sets fresh userData, sessionData and logs paths before loading the entry. Each BrowserWindow stays hidden; the parent waits for the actual exit status, kills only its own process tree on timeout/abort, and removes only its fresh temporary profile. Direct Electron invocation without the isolated bootstrap is rejected. No user document or settings directory is used.

The entry must finish with `app.exit(0)` on success and `app.exit(1)` on failure. Do not call `app.quit()` in an earlier `finally`: it may terminate before a rejected promise reports its failure. `app.exitCode` is not a supported exit-status setter.

The Markdown test uses a test-only preload to call Chromium's `webContents.insertText()` on its own window. A synthetic `beforeinput` event does not perform the browser's default DOM edit. The assertions check committed document text, placeholder cleanup and selection, rather than whether ordinary typing was prevented. The controlled IME sequence remains a separate component scenario; it does not prove physical IME behavior on every platform.

To capture the two editor fixtures while running them:

```powershell
$env:VCP_ELECTRON_TEST_OUTPUT = 'C:\path\to\test-artifacts'
node --test tests/scriptorium-markdown-linebreak-electron.test.js tests/scriptorium-quote-layout-electron.test.js
```

The network-font entry intentionally exercises a live external font request. A failure there must be reported as a network/font integration result, not silently replaced with a local stub or skipped. The minimal Scriptorium IPC fixtures cover the behavior asserted by these tests; they do not validate every production IPC handler.
