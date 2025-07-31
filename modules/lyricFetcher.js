// modules/lyricFetcher.js
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const lyricApiUrl = 'https://music.163.com/api/song/lyric';
const searchApiUrl = 'https://music.163.com/api/search/get/';

async function searchSongId(title, artist) {
    if (!title) return null;
    try {
        const cleanedArtist = artist ? artist.replace(/\//g, ' ') : '';
        const response = await axios.get(searchApiUrl, {
            params: {
                s: `${title} ${cleanedArtist}`.trim(),
                type: 1,
                limit: 1,
            },
            headers: {
                'Referer': 'https://music.163.com',
                'Content-Type': 'application/json',
            },
            timeout: 8000
        });

        if (response.data.code === 200 && response.data.result && response.data.result.songs && response.data.result.songs.length > 0) {
            return response.data.result.songs[0].id;
        }
        console.warn(`[LyricFetcher] Could not find song ID for "${title} - ${artist}". API response:`, response.data);
        return null;
    } catch (error) {
        console.error(`[LyricFetcher] Error searching for song "${title} - ${artist}":`, error.message);
        return null;
    }
}

async function getLyric(songId) {
    if (!songId) return null;
    try {
        // First, try to get translated and original lyrics
        let response = await axios.get(`${lyricApiUrl}?id=${songId}&lv=1&kv=1&tv=-1`, {
            headers: { 'Referer': 'https://music.163.com' },
            timeout: 8000
        });

        if (response.data && (response.data.lrc?.lyric || response.data.tlyric?.lyric)) {
            return parseLyric(response.data);
        }
        return null;

    } catch (error) {
        console.error(`[LyricFetcher] Error fetching lyric for song ID ${songId}:`, error.message);
        return null;
    }
}

function parseLyric(lyricData) {
    if (!lyricData || !lyricData.lrc || !lyricData.lrc.lyric) {
        return null;
    }

    const lrc = lyricData.lrc.lyric;
    const tlyric = lyricData.tlyric ? lyricData.tlyric.lyric : null;

    if (!tlyric) {
        return lrc; // Return only original if no translation
    }

    const lrcLines = lrc.split('\n');
    const tlyricLines = tlyric.split('\n');
    const mergedLrc = [];

    const tlyricMap = new Map();
    for (const line of tlyricLines) {
        const match = line.match(/\[(\d{2}:\d{2}[.:]\d{2,3})\](.*)/);
        if (match && match[2].trim()) { // Ensure translation is not empty
            tlyricMap.set(match[1], match[2].trim());
        }
    }

    for (const line of lrcLines) {
        const match = line.match(/\[(\d{2}:\d{2}[.:]\d{2,3})\](.*)/);
        if (match) {
            const timestamp = match[1];
            mergedLrc.push(line); // Push original line
            const translatedText = tlyricMap.get(timestamp);
            if (translatedText) {
                // To keep sync, add translated line with same timestamp
                mergedLrc.push(`[${timestamp}]${translatedText}`);
            }
        } else {
            mergedLrc.push(line);
        }
    }

    return mergedLrc.join('\n');
}


async function fetchAndSaveLyrics(artist, title, lyricDir) {
    const songId = await searchSongId(title, artist);
    if (!songId) {
        console.log(`[LyricFetcher] Could not find song ID for "${title}".`);
        return null;
    }

    console.log(`[LyricFetcher] Found song ID: ${songId} for "${title}"`);
    const lrcContent = await getLyric(songId);

    if (lrcContent) {
        try {
            await fs.ensureDir(lyricDir);
            const sanitize = (str) => str.replace(/[\\/:"*?<>|]/g, '_').trim();
            const sanitizedTitle = sanitize(title);
            const lrcFileName = artist ? `${sanitize(artist)} - ${sanitizedTitle}.lrc` : `${sanitizedTitle}.lrc`;
            const lrcFilePath = path.join(lyricDir, lrcFileName);
            await fs.writeFile(lrcFilePath, lrcContent);
            console.log(`[LyricFetcher] Lyric saved to ${lrcFilePath}`);
            return lrcContent;
        } catch (error) {
            console.error(`[LyricFetcher] Error saving lyric file:`, error);
            return lrcContent; // Still return content even if saving fails
        }
    }
    
    console.log(`[LyricFetcher] No lyric content found for song ID ${songId}.`);
    return null;
}

module.exports = {
    fetchAndSaveLyrics
};