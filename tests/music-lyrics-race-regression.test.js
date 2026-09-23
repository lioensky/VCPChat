const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createAuditedLyrics, rankAuditedLyrics } = require('../modules/lyrics/lyricFetcherUnified');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function setup(api = {}) {
    const context = vm.createContext({ console, setTimeout, clearTimeout });
    for (const name of ['music-lyrics.js', 'music-player.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../Musicmodules', name), 'utf8'), context);
    }
    const app = {
        lyricsRequestToken: 0, pendingLoadRequestId: 0,
        lyricsList: { innerHTML: '', style: {} },
        currentLyrics: [], lyricSpeedFactor: 1, lyricOffset: 0,
        lastKnownDuration: 999, playlist: [],
        api: {
            getMusicLyrics: async () => null,
            searchMusicLyricsCandidates: async () => ({ success: true, candidates: [] }),
            applyMusicLyricsCandidate: async () => ({ success: false }),
            ...api
        }
    };
    context.setupLyrics(app);
    context.setupPlayer(app);
    app.renderLyrics = () => {};
    return app;
}

test('unknown current duration never borrows the previous song duration', async () => {
    let query;
    const app = setup({
        searchMusicLyricsCandidates: async options => {
            query = options;
            return { success: true, candidates: [] };
        }
    });
    await app.fetchAndDisplayLyrics('artist', 'new song', { duration: 0 });
    assert.equal(query.durationMs, 0);
});

test('unsorted candidates select highest score, not lower-scored word lyrics', async () => {
    let selected;
    const app = setup({
        searchMusicLyricsCandidates: async () => ({
            success: true,
            candidates: [
                { candidateKey: 'low', matchScore: 90, isWordByWord: true },
                { candidateKey: 'high', matchScore: 100, isWordByWord: false }
            ]
        }),
        applyMusicLyricsCandidate: async options => { selected = options; return { success: false }; }
    });
    await app.fetchAndDisplayLyrics('artist', 'song');
    assert.equal(selected.candidateKey, 'high');
});

test('low confidence candidates are not automatically saved', async () => {
    let saves = 0;
    const app = setup({
        searchMusicLyricsCandidates: async () => ({
            success: true, candidates: [{ candidateKey: 'wrong', matchScore: 59 }]
        }),
        applyMusicLyricsCandidate: async () => { saves++; }
    });
    await app.fetchAndDisplayLyrics('artist', 'song');
    assert.equal(saves, 0);
});

test('switch intent invalidates old search before cancellation IPC resolves', async () => {
    const search = deferred();
    const cancel = deferred();
    let saves = 0;
    const app = setup({
        searchMusicLyricsCandidates: () => search.promise,
        cancelMusicPreload: () => cancel.promise,
        applyMusicLyricsCandidate: async () => { saves++; }
    });
    const old = app.fetchAndDisplayLyrics('artist', 'old');
    await Promise.resolve();
    const switching = app.loadTrack(0);
    search.resolve({ success: true, candidates: [{ candidateKey: 'old', matchScore: 100 }] });
    await old;
    assert.equal(saves, 0);
    // Supersede the pending load so it exits without needing a UI.
    app.pendingLoadRequestId++;
    cancel.resolve();
    await switching;
});

test('late saved lyrics cannot repaint a reset track or leave stale stage data', async () => {
    const save = deferred();
    const app = setup({
        searchMusicLyricsCandidates: async () => ({
            success: true, candidates: [{ candidateKey: 'old', matchScore: 100 }]
        }),
        applyMusicLyricsCandidate: () => save.promise
    });
    const loading = app.fetchAndDisplayLyrics('artist', 'old');
    await Promise.resolve();
    await Promise.resolve();
    app.currentLyricsData = { lines: [{ fullText: 'stale' }] };
    app.resetLyrics();
    save.resolve({ success: true, lyrics: { lines: [{ fullText: 'old' }] } });
    await loading;
    assert.equal(app.currentLyricsData, null);
    assert.equal(app.currentLyrics.length, 0);
});

test('backend ties prefer word timing, then target duration proximity', () => {
    const result = word => ({ lyrics: { isWordByWord: word, lines: [{ fullText: 'song' }] } });
    const entry = (durationMs, word) => createAuditedLyrics(
        { matchScore: 90, durationMs }, result(word), { durationMs: 180000 }
    );
    const line = entry(180000, false);
    const far = entry(182000, true);
    const near = entry(180500, true);
    assert.equal(near.durationDifference, 500);
    assert.strictEqual(rankAuditedLyrics([line, far, near])[0], near);
});