const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// The file remains a plain array for existing readers. Revisions describe
// exact disk bytes, and a missing file has a distinct initialization revision.
class GlobalPromptWarehouseStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.tail = Promise.resolve();
    }

    async read() {
        let bytes;
        try {
            bytes = await fs.readFile(this.filePath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { success: true, data: [], currentRevision: 'missing' };
            }
            throw error;
        }
        const data = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(data)) throw new Error('全局提示词仓库必须是数组');
        return { success: true, data, currentRevision: digest(bytes), bytes };
    }

    save(transaction) {
        // Snapshot before waiting for another writer.
        if (!transaction || !Array.isArray(transaction.data)
            || typeof transaction.expectedRevision !== 'string'
            || !transaction.expectedRevision) {
            return Promise.reject(new Error('全局仓库保存需要数据数组和读取版本'));
        }
        const snapshot = structuredClone(transaction);
        const operation = this.tail.catch(() => {}).then(() => this.commit(snapshot));
        this.tail = operation;
        return operation;
    }

    async commit({ data, expectedRevision, operationId }) {
        const lockPath = `${this.filePath}.lock`;
        const token = crypto.randomBytes(24).toString('hex');
        const tempPath = `${this.filePath}.${token}.tmp`;
        let locked = false;
        try {
            await fs.ensureDir(path.dirname(this.filePath));
            // Never steal or age-delete another process's lock.
            await fs.writeFile(lockPath, token, { flag: 'wx' });
            locked = true;
            const current = await this.read();
            if (current.currentRevision !== expectedRevision) {
                return {
                    success: false, status: 'conflict',
                    error: '全局仓库已被其他操作修改，草稿已保留',
                    expectedRevision, currentRevision: current.currentRevision, operationId,
                };
            }
            const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
            await fs.writeFile(tempPath, bytes, { flag: 'wx' });
            const verified = await fs.readFile(tempPath);
            if (!verified.equals(bytes) || !Array.isArray(JSON.parse(verified.toString('utf8')))) {
                throw new Error('全局仓库临时文件校验失败');
            }
            if (current.bytes) {
                const directory = `${this.filePath}.versions`;
                await fs.ensureDir(directory);
                const versionPath = path.join(directory, `${current.currentRevision}.json`);
                try {
                    await fs.writeFile(versionPath, current.bytes, { flag: 'wx' });
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    if (!(await fs.readFile(versionPath)).equals(current.bytes)) {
                        throw new Error('全局仓库恢复点校验失败');
                    }
                }
            }
            await fs.rename(tempPath, this.filePath);
            return { success: true, currentRevision: digest(bytes), operationId };
        } finally {
            await fs.remove(tempPath).catch(() => {});
            if (locked) {
                try {
                    if (await fs.readFile(lockPath, 'utf8') === token) await fs.remove(lockPath);
                } catch (error) {
                    console.warn('全局仓库锁清理失败:', error);
                }
            }
        }
    }
}

module.exports = GlobalPromptWarehouseStore;