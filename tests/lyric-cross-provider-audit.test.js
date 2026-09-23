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