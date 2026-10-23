'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function durableJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(value));
        await handle.sync();
        await handle.close(); handle = null;
        await fs.rename(temporary, file);
        // Windows does not expose a portable directory fsync.
        if (process.platform !== 'win32') {
            const directory = await fs.open(path.dirname(file), 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        }
    } finally {
        await handle?.close().catch(() => {});
        await fs.rm(temporary, { force: true });
    }
}
module.exports = { durableJson };
