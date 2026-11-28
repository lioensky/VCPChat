/*
 * How long a library scan takes and how much memory it holds while it runs.
 *
 *   node tests/music-library-bench/scan-bench.cjs <music folder> [--cache=<dir>] [--known=<songlist.json>]
 *       [--save=<songlist.json>] [--workers=N]
 *
 * Prints one JSON line: files, wall time, time to the first tracks, peak RSS
 * of this process (workers included), messages a window would have received.
 * Run it twice with --save / --known to measure a rescan of an unchanged folder.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanFolder } = require('../../modules/musicLibraryScanner');

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [key, value = '1'] = a.slice(2).split('=');
    return [key, value];
}));
if (!positional[0]) { console.error('usage: scan-bench.cjs <music folder>'); process.exit(2); }

(async () => {
    const cache = args.cache || fs.mkdtempSync(path.join(os.tmpdir(), 'music-scan-bench-'));
    const knownTracks = args.known && fs.existsSync(args.known) ? JSON.parse(fs.readFileSync(args.known, 'utf8')) : undefined;
    let peak = 0;
    let messages = 0;
    let firstTracksMs = null;
    const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
    const t0 = performance.now();
    const result = await scanFolder({
        folderPath: path.resolve(positional[0]),
        coverCachePath: cache,
        knownTracks,
        workerCount: args.workers ? Number(args.workers) : undefined,
        onStart: () => { messages++; },
        onProgress: () => { messages++; },
        onBatch: () => { messages++; if (firstTracksMs === null) firstTracksMs = Math.round(performance.now() - t0); }
    });
    clearInterval(sample);
    messages++; // scan-complete
    if (args.save) fs.writeFileSync(args.save, JSON.stringify(result.tracks));
    console.log(JSON.stringify({
        files: result.stats.total, parsed: result.stats.parsed, reused: result.stats.reused, failed: result.stats.failed,
        ms: Math.round(performance.now() - t0), firstTracksMs,
        peakRssMB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576), ipcMessages: messages
    }));
})();
