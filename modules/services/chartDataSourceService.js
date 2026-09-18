'use strict';

const fs = require('fs').promises;
const path = require('path');
const { fileURLToPath } = require('url');

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_SQL_ROWS = 10000;

function createError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function resolveLocalSource(source) {
    if (typeof source !== 'string' || !source.trim()) {
        throw createError('本地数据源缺少 source。', 'CHART_DATA_SOURCE_REQUIRED');
    }
    const value = source.trim();
    let filePath;
    if (/^file:/i.test(value)) {
        try {
            filePath = fileURLToPath(value);
        } catch (error) {
            throw createError(
                `无效 file URL：${error.message}`,
                'CHART_DATA_SOURCE_INVALID_URL'
            );
        }
    } else {
        if (!path.isAbsolute(value)) {
            throw createError(
                '本地数据源必须使用绝对路径或 file:// URL。',
                'CHART_DATA_SOURCE_ABSOLUTE_REQUIRED'
            );
        }
        filePath = path.resolve(value);
    }
    return filePath;
}

async function assertReadableFile(filePath, maxBytes) {
    let realPath;
    try {
        realPath = await fs.realpath(filePath);
        const stat = await fs.stat(realPath);
        if (!stat.isFile()) {
            throw createError(
                `数据源不是普通文件：${filePath}`,
                'CHART_DATA_SOURCE_NOT_FILE'
            );
        }
        if (stat.size > maxBytes) {
            throw createError(
                `数据源大小 ${stat.size} 字节，超过限制 ${maxBytes} 字节。`,
                'CHART_DATA_SOURCE_TOO_LARGE',
                { size: stat.size, maxBytes }
            );
        }
        return { realPath, stat };
    } catch (error) {
        if (error.code?.startsWith?.('CHART_')) throw error;
        if (error.code === 'ENOENT') {
            throw createError(
                `数据源文件不存在：${filePath}`,
                'CHART_DATA_SOURCE_NOT_FOUND'
            );
        }
        throw error;
    }
}

function parseCsv(text, options = {}) {
    const delimiter = typeof options.delimiter === 'string' && options.delimiter.length === 1
        ? options.delimiter
        : ',';
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quoted) {
            if (char === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                field += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === delimiter) {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field.replace(/\r$/, ''));
            rows.push(row);
            row = [];
            field = '';
        } else {
            field += char;
        }
    }
    if (quoted) {
        throw createError('CSV 存在未闭合引号。', 'CHART_DATA_SOURCE_INVALID_CSV');
    }
    if (field || row.length) {
        row.push(field.replace(/\r$/, ''));
        rows.push(row);
    }

    if (options.header === false) return rows;
    const headers = rows.shift() || [];
    return rows
        .filter(values => values.some(value => value !== ''))
        .map(values => Object.fromEntries(headers.map((header, index) => [
            header || `column_${index + 1}`,
            values[index] ?? '',
        ])));
}

function assertReadOnlySql(sql) {
    if (typeof sql !== 'string' || !sql.trim()) {
        throw createError('SQLite 查询缺少 sql。', 'CHART_SQL_REQUIRED');
    }
    const normalized = sql
        .replace(/--[^\n\r]*/g, ' ')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .trim();
    const withoutTrailing = normalized.replace(/;\s*$/, '');
    if (withoutTrailing.includes(';')) {
        throw createError(
            'SQLite 只读数据源不允许多语句查询。',
            'CHART_SQL_MULTIPLE_STATEMENTS'
        );
    }
    if (!/^(select|with)\b/i.test(withoutTrailing)) {
        throw createError(
            'SQLite 只读数据源仅允许 SELECT 或 WITH ... SELECT。',
            'CHART_SQL_READ_ONLY_REQUIRED'
        );
    }
    const forbidden = /\b(insert|update|delete|replace|create|alter|drop|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b/i;
    if (forbidden.test(withoutTrailing)) {
        throw createError(
            'SQLite 查询包含非只读关键字。',
            'CHART_SQL_READ_ONLY_REQUIRED'
        );
    }
    return withoutTrailing;
}

class ChartDataSourceService {
    constructor(options = {}) {
        this.maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
        this.timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
        this.logger = options.logger || console;
    }

    async read(request = {}) {
        const type = String(request.type || '').trim().toLowerCase();
        switch (type) {
            case 'http-json':
            case 'http':
                return this.readHttpJson(request);
            case 'json':
                return this.readLocalJson(request);
            case 'csv':
                return this.readLocalCsv(request);
            case 'text':
                return this.readLocalText(request);
            case 'sqlite':
            case 'sqlite3':
                return this.querySqlite(request);
            default:
                throw createError(
                    `不支持的图表数据源类型：${type || '(empty)'}`,
                    'CHART_DATA_SOURCE_TYPE_UNSUPPORTED'
                );
        }
    }

    async readHttpJson(request) {
        const url = String(request.url || request.source || '').trim();
        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (error) {
            throw createError(
                `无效 HTTP URL：${error.message}`,
                'CHART_DATA_SOURCE_INVALID_URL'
            );
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw createError(
                'HTTP 数据源仅支持 http:// 或 https://。',
                'CHART_DATA_SOURCE_PROTOCOL_DENIED'
            );
        }

        const controller = new AbortController();
        const timeoutMs = Math.min(
            60000,
            Math.max(500, Number(request.timeoutMs) || this.timeoutMs)
        );
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(parsedUrl, {
                method: 'GET',
                headers: request.headers && typeof request.headers === 'object'
                    ? request.headers
                    : undefined,
                signal: controller.signal,
                redirect: 'follow',
            });
            if (!response.ok) {
                throw createError(
                    `HTTP 数据源返回 ${response.status} ${response.statusText}。`,
                    'CHART_DATA_SOURCE_HTTP_ERROR',
                    { status: response.status }
                );
            }
            const declaredLength = Number(response.headers.get('content-length') || 0);
            if (declaredLength > this.maxBytes) {
                throw createError(
                    `HTTP 响应超过 ${this.maxBytes} 字节限制。`,
                    'CHART_DATA_SOURCE_TOO_LARGE'
                );
            }
            const buffer = Buffer.from(await response.arrayBuffer());
            if (buffer.length > this.maxBytes) {
                throw createError(
                    `HTTP 响应超过 ${this.maxBytes} 字节限制。`,
                    'CHART_DATA_SOURCE_TOO_LARGE'
                );
            }
            let data;
            try {
                data = JSON.parse(buffer.toString('utf8'));
            } catch (error) {
                throw createError(
                    `HTTP 响应不是有效 JSON：${error.message}`,
                    'CHART_DATA_SOURCE_INVALID_JSON'
                );
            }
            return {
                type: 'http-json',
                source: parsedUrl.toString(),
                byteLength: buffer.length,
                fetchedAt: new Date().toISOString(),
                data,
            };
        } catch (error) {
            if (error.name === 'AbortError') {
                throw createError(
                    `HTTP 数据源读取超时（${timeoutMs}ms）。`,
                    'CHART_DATA_SOURCE_TIMEOUT'
                );
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    async readBuffer(request) {
        const filePath = resolveLocalSource(request.source || request.path || request.url);
        const { realPath, stat } = await assertReadableFile(filePath, this.maxBytes);
        return {
            realPath,
            stat,
            buffer: await fs.readFile(realPath),
        };
    }

    async readLocalJson(request) {
        const { realPath, stat, buffer } = await this.readBuffer(request);
        let data;
        try {
            data = JSON.parse(buffer.toString(request.encoding || 'utf8'));
        } catch (error) {
            throw createError(
                `本地文件不是有效 JSON：${error.message}`,
                'CHART_DATA_SOURCE_INVALID_JSON'
            );
        }
        return {
            type: 'json',
            source: realPath,
            byteLength: stat.size,
            lastModified: stat.mtime.toISOString(),
            data,
        };
    }

    async readLocalText(request) {
        const { realPath, stat, buffer } = await this.readBuffer(request);
        return {
            type: 'text',
            source: realPath,
            byteLength: stat.size,
            lastModified: stat.mtime.toISOString(),
            data: buffer.toString(request.encoding || 'utf8'),
        };
    }

    async readLocalCsv(request) {
        const { realPath, stat, buffer } = await this.readBuffer(request);
        const text = buffer.toString(request.encoding || 'utf8');
        return {
            type: 'csv',
            source: realPath,
            byteLength: stat.size,
            lastModified: stat.mtime.toISOString(),
            data: parseCsv(text, {
                delimiter: request.delimiter,
                header: request.header === undefined ? true : request.header !== false,
            }),
        };
    }

    async querySqlite(request) {
        const filePath = resolveLocalSource(request.source || request.path || request.url);
        const { realPath, stat } = await assertReadableFile(filePath, this.maxBytes);
        const sql = assertReadOnlySql(request.sql);
        const params = Array.isArray(request.params)
            ? request.params
            : request.params && typeof request.params === 'object'
                ? request.params
                : [];

        let Database;
        try {
            Database = require('better-sqlite3');
        } catch (error) {
            throw createError(
                `SQLite 运行时不可用：${error.message}`,
                'CHART_SQLITE_UNAVAILABLE'
            );
        }

        const database = new Database(realPath, {
            readonly: true,
            fileMustExist: true,
            timeout: Math.min(30000, Math.max(100, Number(request.timeoutMs) || 5000)),
        });
        try {
            database.pragma('query_only = ON');
            const statement = database.prepare(sql);
            if (!statement.reader) {
                throw createError(
                    'SQLite 语句不是只读查询。',
                    'CHART_SQL_READ_ONLY_REQUIRED'
                );
            }
            const rows = Array.isArray(params)
                ? statement.all(...params)
                : statement.all(params);
            const limited = rows.slice(0, MAX_SQL_ROWS);
            return {
                type: 'sqlite',
                source: realPath,
                byteLength: stat.size,
                lastModified: stat.mtime.toISOString(),
                sql,
                rowCount: limited.length,
                truncated: rows.length > MAX_SQL_ROWS,
                columns: statement.columns().map(column => column.name),
                data: limited,
            };
        } finally {
            database.close();
        }
    }
}

module.exports = {
    ChartDataSourceService,
    _test: {
        resolveLocalSource,
        parseCsv,
        assertReadOnlySql,
        assertReadableFile,
    },
};