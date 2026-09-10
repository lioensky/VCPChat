// modules/lyrics/matchScore.js
// Song Matching and Scoring Algorithm based on Folia's matchScore
// Validates title similarity, artist similarity, and duration difference to prevent false matches.

const SCORE_WEIGHTS = {
    title: 45,
    artist: 25,
    album: 30
};

const AUTO_MATCH_COMPONENT_MISS_SCORE_CAP = 74;

/**
 * Normalizes text for comparison by removing punctuation and converting to lowercase.
 */
function normalizeLyricMatchText(value) {
    if (!value) return '';
    return String(value)
        .toLowerCase()
        .replace(/[\p{P}\p{S}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalizes title for match, preserving version tags (remix, ver, instrumental, etc.)
 * but removing standard featured artists.
 */
function normalizeTitleForMatch(value) {
    if (!value) return '';
    const versionMarkerPattern = /(instrumental|inst|off\s*vocal|karaoke|remix|mix|version|ver\.?|cover|live|edit|arrange|伴奏|カラオケ|インスト|リミックス|remaster|remastered)/i;
    return normalizeLyricMatchText(
        String(value)
            .replace(/[\(\[（【]\s*(feat|featuring|ft)\.?\s+[^\)\]）】]+[\)\]）】]/gi, '')
            .replace(/\b(feat|featuring|ft)\.?\s+.+$/i, '')
            .replace(/[\(\[（【]([^\)\]）】]+)[\)\]）】]/g, (match, content) => {
                return versionMarkerPattern.test(content) ? match : '';
            })
    );
}

/**
 * Calculates Jaccard character similarity between two strings
 */
function stringSimilarity(s1, s2, normalizer = normalizeLyricMatchText) {
    const n1 = normalizer(s1);
    const n2 = normalizer(s2);
    if (!n1 || !n2) return 0;
    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) {
        return Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
    }

    const set1 = new Set(n1);
    const set2 = new Set(n2);
    let intersection = 0;
    for (const char of set1) {
        if (set2.has(char)) intersection++;
    }
    const union = new Set([...set1, ...set2]).size;
    return union > 0 ? intersection / union : 0;
}

/**
 * Duration scoring multiplier.
 * Audio duration diff <= 1s -> 1.0
 * diff <= 3s -> 0.95
 * diff <= 5s -> 0.75
 * diff <= 10s -> 0.35
 * > 10s -> 0.1
 */
function calculateDurationScore(targetDurationMs, searchDurationMs) {
    if (!targetDurationMs || !searchDurationMs || targetDurationMs <= 0 || searchDurationMs <= 0) {
        return { multiplier: 0.9, matched: null };
    }

    const diff = Math.abs(targetDurationMs - searchDurationMs);
    if (diff <= 1000) return { multiplier: 1.0, matched: true };
    if (diff <= 3000) return { multiplier: 0.95, matched: true };
    if (diff <= 5000) return { multiplier: 0.75, matched: false };
    if (diff <= 10000) return { multiplier: 0.35, matched: false };
    return { multiplier: 0.1, matched: false };
}

function splitArtists(artistText) {
    if (!artistText) return [];
    return String(artistText)
        .split(/[,&、\/]|feat\.?|ft\.?|featuring|与/i)
        .map(a => normalizeLyricMatchText(a))
        .filter(a => a.length > 0);
}

function calculateArtistSimilarity(target, search) {
    const tArtists = splitArtists(target);
    const sArtists = splitArtists(search);

    if (tArtists.length === 0 || sArtists.length === 0) {
        return stringSimilarity(target, search);
    }

    let matchCount = 0;
    for (const a1 of tArtists) {
        for (const a2 of sArtists) {
            if (a1 === a2 || (a1.length >= 2 && a2.includes(a1)) || (a2.length >= 2 && a1.includes(a2))) {
                matchCount++;
                break;
            }
        }
    }

    const tokenSim = matchCount / Math.max(tArtists.length, sArtists.length);
    const isMainArtistMatched = tArtists[0] && sArtists[0] &&
        (tArtists[0] === sArtists[0] ||
        (tArtists[0].length >= 2 && sArtists[0].includes(tArtists[0])) ||
        (sArtists[0].length >= 2 && tArtists[0].includes(sArtists[0])));

    const mainBonus = isMainArtistMatched ? Math.max(tokenSim, 0.75) : tokenSim;
    return Math.max(mainBonus, stringSimilarity(target, search));
}

/**
 * Calculates match score between target metadata and a search result candidate.
 * target: { title, artist, durationMs, album }
 * candidate: { title, artist, durationMs, album }
 */
function calculateMatchScore(target, candidate) {
    const targetTitle = target.title || '';
    const searchTitle = candidate.title || '';
    const targetArtist = target.artist || '';
    const searchArtist = candidate.artist || '';
    const targetAlbum = target.album || '';
    const searchAlbum = candidate.album || '';

    const titleSimilarity = stringSimilarity(targetTitle, searchTitle, normalizeTitleForMatch);
    const titleScore = titleSimilarity * SCORE_WEIGHTS.title;

    const artistSimilarity = targetArtist.trim()
        ? calculateArtistSimilarity(targetArtist, searchArtist)
        : 1;
    const artistScore = artistSimilarity * SCORE_WEIGHTS.artist;

    const hasTargetAlbum = Boolean(targetAlbum.trim());
    const hasSearchAlbum = Boolean(searchAlbum.trim());
    const albumSimilarity = hasTargetAlbum && hasSearchAlbum
        ? stringSimilarity(targetAlbum, searchAlbum, normalizeTitleForMatch)
        : null;
    const albumScore = albumSimilarity === null
        ? (hasTargetAlbum ? 0 : SCORE_WEIGHTS.album)
        : albumSimilarity * SCORE_WEIGHTS.album;

    const duration = calculateDurationScore(target.durationMs, candidate.durationMs);
    const identityScore = titleScore + artistScore + albumScore;
    const titleMatched = titleSimilarity >= 0.65;
    const artistMatched = !targetArtist.trim() || artistSimilarity >= 0.5;
    const albumMatched = !hasTargetAlbum ? null : (hasSearchAlbum ? (albumSimilarity >= 0.65) : null);
    const hasReliableIdentityMatch = artistMatched || albumMatched === true;

    const cappedIdentityScore = (!titleMatched || !hasReliableIdentityMatch)
        ? Math.min(identityScore, AUTO_MATCH_COMPONENT_MISS_SCORE_CAP)
        : identityScore;

    const finalScore = Math.min(100, Math.max(0, Math.round(cappedIdentityScore * duration.multiplier)));

    return {
        score: finalScore,
        titleMatched,
        artistMatched,
        durationMatched: duration.matched,
        durationMultiplier: duration.multiplier
    };
}

module.exports = {
    normalizeLyricMatchText,
    normalizeTitleForMatch,
    stringSimilarity,
    calculateMatchScore
};