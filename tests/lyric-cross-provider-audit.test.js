const test = require('node:test');
const assert = require('node:assert/strict');

const {
    AUTO_MATCH_MIN_SCORE,
    LYRIC_QUALITY_BONUS,
    createCandidateSummary,
    createAuditedLyrics,
    rankAuditedLyrics
} = require('../modules/lyrics/lyricFetcherUnified');
const {
    normalizeTitleForMatch,
    calculateMatchScore
} = require('../modules/lyrics/matchScore');

const candidate = (source, matchScore) => ({
    source,
    id: `${source}-${matchScore}`,
    title: '审计测试歌曲',
    artist: 'VCP',
    matchScore
});

const lyricResult = ({
    source = 'netease',
    platform = null,
    wordByWord = false,
    translation = false,
    romanization = false
} = {}) => ({
    source,
    platform,
    lyrics: {
        isWordByWord: wordByWord,
        lines: [{
            fullText: '让歌词跨越平台',
            translation: translation ? 'Let lyrics cross platforms' : '',
            romanization: romanization ? 'rang ge ci kua yue ping tai' : ''
        }]
    }
});

test('cross-provider audit rejects candidates below the identity threshold', () => {
    const audited = createAuditedLyrics(
        candidate('qq', AUTO_MATCH_MIN_SCORE - 1),
        lyricResult({ source: 'qq', wordByWord: true })
    );

    assert.equal(audited, null);
});

test('cross-provider audit rejects empty or unusable lyric payloads', () => {
    const audited = createAuditedLyrics(
        candidate('netease', 100),
        {
            source: 'netease',
            lyrics: { isWordByWord: true, lines: [] }
        }
    );

    assert.equal(audited, null);
});

test('higher identity confidence beats a substantially lower-scored word-by-word lyric', () => {
    const exactLineLyric = createAuditedLyrics(
        candidate('netease', 100),
        lyricResult({ source: 'netease' })
    );
    const weakWordLyric = createAuditedLyrics(
        candidate('qq', 70),
        lyricResult({ source: 'qq', wordByWord: true })
    );

    const ranked = rankAuditedLyrics([weakWordLyric, exactLineLyric]);

    assert.equal(ranked[0].result.source, 'netease');
    assert.equal(ranked[0].matchScore, 100);
});

test('100-point line lyrics beat 90-point word lyrics despite quality bonuses', () => {
    const exactLineLyric = createAuditedLyrics(
        candidate('netease', 100),
        lyricResult({ source: 'netease' })
    );
    const closeWordLyric = createAuditedLyrics(
        candidate('qq', 90),
        lyricResult({ source: 'qq', wordByWord: true })
    );

    const ranked = rankAuditedLyrics([exactLineLyric, closeWordLyric]);

    assert.equal(ranked[0].result.source, 'netease');
    assert.equal(ranked[0].matchScore, 100);
    assert.equal(closeWordLyric.auditScore, 102);
});

test('AMLL, translation and romanization contribute bounded quality bonuses', () => {
    const audited = createAuditedLyrics(
        candidate('netease', 88),
        lyricResult({
            source: 'amll',
            platform: 'ncm',
            wordByWord: true,
            translation: true,
            romanization: true
        })
    );

    const expectedBonus =
        LYRIC_QUALITY_BONUS.wordByWord
        + LYRIC_QUALITY_BONUS.amllTtml
        + LYRIC_QUALITY_BONUS.translation
        + LYRIC_QUALITY_BONUS.romanization;

    assert.equal(audited.qualityBonus, expectedBonus);
    assert.equal(audited.auditScore, 88 + expectedBonus);
});

test('ranking uses metadata confidence before format preference when totals tie', () => {
    const higherIdentity = createAuditedLyrics(
        candidate('netease', 92),
        lyricResult({ source: 'netease' })
    );
    const lowerIdentityWordLyric = createAuditedLyrics(
        candidate('qq', 80),
        lyricResult({ source: 'qq', wordByWord: true })
    );

    const ranked = rankAuditedLyrics([lowerIdentityWordLyric, higherIdentity]);

    assert.equal(lowerIdentityWordLyric.auditScore, higherIdentity.auditScore);
    assert.equal(ranked[0].matchScore, 92);
});

test('automatic matching ignores known audio file extensions in track titles', () => {
    const target = {
        title: 'Starlight.FLAC',
        artist: 'VCP',
        album: '',
        durationMs: 180000
    };
    const platformCandidate = {
        title: 'Starlight',
        artist: 'VCP',
        album: '',
        durationMs: 180000
    };

    assert.equal(normalizeTitleForMatch(target.title), 'starlight');
    assert.equal(calculateMatchScore(target, platformCandidate).score, 100);
});

test('title normalization preserves ordinary dotted song names', () => {
    assert.equal(normalizeTitleForMatch('No.9'), 'no9');
    assert.equal(normalizeTitleForMatch('No.9.opus'), 'no9');
});

test('a 90-point lyric visible to manual search is also eligible for automatic audit', () => {
    const sharedCandidate = candidate('qq', 90);
    const sharedResult = lyricResult({
        source: 'qq',
        wordByWord: true,
        translation: true
    });

    const manualSummary = createCandidateSummary(sharedCandidate, sharedResult);
    const automaticEntry = createAuditedLyrics(sharedCandidate, sharedResult);

    assert.ok(manualSummary);
    assert.equal(manualSummary.matchScore, 90);
    assert.equal(manualSummary.isWordByWord, true);
    assert.ok(automaticEntry);
    assert.equal(automaticEntry.matchScore, manualSummary.matchScore);
    assert.equal(automaticEntry.features.isWordByWord, manualSummary.isWordByWord);
});

test('decodeKrcLanguageTag and calculateMatchScore handle null/empty inputs safely', () => {
    const { decodeKrcLanguageTag } = require('../modules/lyrics/krcDecrypt');
    assert.deepEqual(decodeKrcLanguageTag(null), { translations: [], romanizations: [] });
    assert.deepEqual(decodeKrcLanguageTag(''), { translations: [], romanizations: [] });
    assert.deepEqual(decodeKrcLanguageTag('[language:e30=]'), { translations: [], romanizations: [] });
    const score = calculateMatchScore(null, null);
    assert.equal(typeof score.score, 'number');
    assert.equal(score.titleMatched, false);
});

test('Batch 58: parserCore guards null inputs, saveSelectedLyrics sanitizes whitespace artist atomically, and completionsUrl trims URL', async () => {
    const os = require('node:os');
    const path = require('node:path');
    const fs = require('node:fs');
    const { parseYRC, parseQRC, parseKRC, parseLRC } = require('../modules/lyrics/parserCore');
    for (const [fn, wbyw] of [[parseYRC, true], [parseQRC, true], [parseKRC, true], [parseLRC, false]]) {
        assert.deepEqual(fn(null), { lines: [], isWordByWord: wbyw });
        assert.deepEqual(fn(undefined), { lines: [], isWordByWord: wbyw });
        assert.deepEqual(fn(123), { lines: [], isWordByWord: wbyw });
    }

    const { saveSelectedLyrics } = require('../modules/lyrics/lyricFetcherUnified');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmusic-b58-lyric-'));
    try {
        const sum = createCandidateSummary(candidate('netease', 95), lyricResult({ source: 'netease', wordByWord: true }));
        const saved = await saveSelectedLyrics({
            candidateKey: sum.candidateKey,
            artist: '   ',
            title: 'Starlight',
            lyricDir: tmpDir
        });
        assert.equal(saved.success, true);
        const files = fs.readdirSync(tmpDir).sort();
        assert.deepEqual(files, ['Starlight.json', 'Starlight.lrc'], 'whitespace artist produces clean Title filename with zero leftover .tmp');

        const sum2 = createCandidateSummary(candidate('netease', 95), lyricResult({ source: 'netease' }));
        const bad = await saveSelectedLyrics({ candidateKey: sum2.candidateKey, artist: 'A', title: '   ', lyricDir: tmpDir });
        assert.equal(bad.success, false, 'blank title is rejected cleanly');

        const { completionsUrl, createLyricsTranslator } = require('../modules/musicLyricsTranslate');
        assert.equal(completionsUrl('  http://127.0.0.1:6005/v1/chatvcp/completions  '), 'http://127.0.0.1:6005/v1/chat/completions');
        const trDir = path.join(tmpDir, 'translations');
        const translator = createLyricsTranslator({
            getSettings: async () => ({ vcpServerUrl: ' http://127.0.0.1:6005/v1/chat/completions ', topicSummaryModel: 'm1' }),
            getCacheDir: () => trDir,
            fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '["星光"]' } }] }) })
        });
        const trRes = await translator.translate({ lines: ['Starlight'] });
        assert.equal(trRes.status, 'success');
        const trFiles = fs.readdirSync(trDir);
        assert.equal(trFiles.length, 1);
        assert.ok(trFiles[0].endsWith('.json'), 'atomic translation cache leaves no .tmp files');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});