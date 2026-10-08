'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * File bytes and SQLite records cannot share a transaction. Preserve the before
 * image before touching the file, compensate on failure, and retain a usable
 * recovery copy if compensation fails. The caller owns its project lock and
 * supplies the existing disk reader, trash operation and synchronous DB write.
 */
async function applyGuiRevert({ file, disk, target, content, recoveryDir, readDisk, trash, record, logger }) {
    let recoveryFile = null;
    if (disk.exists) {
        await fs.mkdir(recoveryDir, { recursive: true });
        recoveryFile = path.join(recoveryDir, `revert-${randomUUID()}.bak`);
        // An incomplete or unwritable backup must never allow the live write.
        await fs.writeFile(recoveryFile, disk.buffer, { flag: 'wx' });
    }
    const clearRecovery = async () => {
        if (!recoveryFile) return;
        try { await fs.unlink(recoveryFile); }
        catch (error) {
            // Cleanup failure cannot turn a confirmed operation into a retryable failure.
            try { logger?.warn?.(`[ProjectForge] 恢复副本清理失败：${recoveryFile} (${error.message})`); } catch {}
        }
    };
    // Saving the backup is asynchronous; recheck the live file afterwards.
    try {
        if ((await readDisk(file)).hash !== disk.hash) throw new Error('文件在处理期间被外部修改，请重新预检');
    } catch (error) {
        await clearRecovery();
        throw error;
    }
    try {
        if (target === null) await trash(file);
        else {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, content);
        }
        if ((await readDisk(file)).hash !== target) throw new Error('回退后文件内容校验失败');
        record();
    } catch (error) {
        try {
            const current = await readDisk(file);
            if (current.hash !== disk.hash) {
                // Never overwrite an editor's newer content while compensating.
                if (current.hash !== target) throw new Error('文件已再次改变，未覆盖当前内容');
                if (disk.exists) await fs.writeFile(file, disk.buffer);
                else await fs.unlink(file);
            }
            const restored = await readDisk(file);
            if (restored.hash !== disk.hash) throw new Error('恢复后文件内容校验失败');
        } catch (restoreError) {
            const recovery = recoveryFile ? `原文件副本保留在：${recoveryFile}` : '操作前文件不存在，请检查当前文件';
            throw new Error(`回退未完成，自动恢复失败：${restoreError.message}。${recovery}。原始错误：${error.message}`, { cause: error });
        }
        await clearRecovery();
        throw new Error(`回退未完成，原文件已恢复：${error.message}`, { cause: error });
    }
    await clearRecovery();
}

module.exports = { applyGuiRevert };
