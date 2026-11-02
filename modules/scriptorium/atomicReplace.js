'use strict';
// Put a fully written temporary file in place of the target in one step.
// fs-extra's move(..., { overwrite: true }) removes the target first and renames after (two steps: a crash between
// them leaves no file at all), and it makes a read-only target writable to remove it; graceful-fs's rename retries for
// up to a minute while a file is held open. Node's own rename is MoveFileEx with REPLACE_EXISTING on Windows: one step,
// and a read-only target is refused. Briefly busy files (antivirus, indexing, sync clients) get two more tries.
const fs = require('node:fs');

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BUSY_MESSAGE = '文件为只读，或正被其他程序占用，未能保存；原文件未改动。';

async function replaceWith(temporary, target) {
    for (let attempt = 1; ; attempt += 1) {
        try {
            await fs.promises.rename(temporary, target);
            return;
        } catch (error) {
            if (!BUSY.has(error.code)) throw error;
            if (attempt >= 3) throw new Error(BUSY_MESSAGE);
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
        }
    }
}

module.exports = { replaceWith };
