'use strict';
const fsp = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

// Windows antivirus/indexers briefly hold files open; rename then fails with these codes.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Replace target with data without ever deleting the existing file first.
 * Either the old bytes or the complete new bytes are on disk; on failure the
 * old file is untouched and the temporary sibling is removed.
 * Limit: Node cannot fsync a directory on Windows nor request MOVEFILE_WRITE_THROUGH,
 * so durability of the rename itself across power loss relies on the filesystem journal.
 */
async function replaceFile(target, data, { attempts = 8 } = {}) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        const handle = await fsp.open(temporary, 'wx');
        try {
            await handle.writeFile(data, 'utf8');
            await handle.sync();
        } finally { await handle.close(); }
        for (let attempt = 1; ; attempt++) {
            try { await fsp.rename(temporary, target); return; }
            catch (error) {
                if (!TRANSIENT.has(error.code) || attempt >= attempts) throw error;
                await sleep(Math.min(20 * 2 ** (attempt - 1), 500));
            }
        }
    } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
    }
}

module.exports = { replaceFile };