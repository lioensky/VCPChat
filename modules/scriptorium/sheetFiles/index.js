'use strict';
// 文坊中的表格。.csv / .tsv / .xlsx 在这里读成若干张表（每格一段文字），由页面 scriptorium-table-view.js 绘制和编辑。
// 通信名 scriptorium:sheet，命令如下：
// - read：先经过 fileAccess.allowed，上限 50 MB。
//   .csv / .tsv 识别 UTF-8（含或不含 BOM）、UTF-16，均不是时按 GB18030 读取（中文 Windows 上 Excel 保存的 csv 为此编码）；
//   .tsv 以制表符分隔，.csv 按第一行逗号与分号的数量判断分隔符。.xlsx 使用 exceljs，每张工作表一张表，单元格取显示文字
//   （公式取结果，日期按 YYYY-MM-DD 书写）。每张最多 5 万行、500 列，超出部分截去并提示。读过的文件记入最近打开。
// - save：.csv / .tsv 整张写回，分隔符、编码、BOM、换行和是否全部加引号均与原文件一致。.xlsx 只写修改过的单元格，
//   样式、合并、列宽和其他工作表保持不变；含有图表、透视表、宏等 exceljs 无法写回的部分时不允许修改（lockReason）。
//   修改时间不一致时返回 conflict。
// - stat：修改时间和大小（页面据此检查外部修改）。
const path = require('path');
const fs = require('fs-extra');
const { decodeText, encodeText, encodingLabel } = require('../textEncoding');
const { replaceWith } = require('../atomicReplace');

let deps = null;
const SHEET = /\.(csv|tsv|xlsx|xlsm)$/i;
const isSheet = (file) => SHEET.test(String(file || ''));
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 50000;
const MAX_COLS = 500;

// RFC 4180：引号里的分隔符、换行照原样，两个引号是一个引号。
function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    let truncated = false;
    let everyQuoted = true; // 全加引号的文件存回时也全加
    const endField = (at) => { if (text[at - 1] !== '"') everyQuoted = false; };
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"' && cell === '') {
            quoted = true;
        } else if (ch === delimiter) {
            endField(i);
            row.push(cell);
            cell = '';
        } else if (ch === '\n' || ch === '\r') {
            endField(i);
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
            if (rows.length >= MAX_ROWS) { truncated = i < text.length - 1; break; }
        } else cell += ch;
    }
    if (!truncated && (cell !== '' || row.length)) {
        endField(text.length);
        row.push(cell);
        rows.push(row);
    }
    return { rows: rows.map((item) => (item.length > MAX_COLS ? (truncated = true, item.slice(0, MAX_COLS)) : item)), truncated, everyQuoted: everyQuoted && rows.length > 0 };
}
function writeDelimited(rows, { delimiter = ',', eol = '\n', endsWithNewline = true, everyQuoted = false } = {}) {
    const field = (value) => {
        const text = String(value ?? '');
        return everyQuoted || text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const body = rows.map((row) => row.map(field).join(delimiter)).join(eol);
    return endsWithNewline && rows.length ? body + eol : body;
}
function delimiterOf(text, ext) {
    if (ext === '.tsv') return '\t';
    const first = text.slice(0, text.search(/\r?\n|$/));
    const count = (ch) => first.split(ch).length - 1;
    const best = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
    return count(best) ? best : ',';
}

const pad = (n) => String(n).padStart(2, '0');
function cellText(value) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) {
        const date = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
        const time = value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() ? ` ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}` : '';
        return date + time;
    }
    if (typeof value === 'object') {
        if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
        if ('result' in value || 'formula' in value || 'sharedFormula' in value) return cellText(value.result);
        if ('text' in value) return cellText(value.text);
        if ('error' in value) return String(value.error);
        return '';
    }
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e10) / 1e10);
    return String(value);
}
// exceljs 读进来再写回去会丢的部分。有这些的工作簿只看不改。
const LOST_PARTS = [
    [/^xl\/charts\//, '图表'], [/^xl\/pivotTables\//, '透视表'], [/^xl\/vbaProject\.bin$/, '宏'], [/^xl\/slicers\//, '切片器'],
    [/^xl\/externalLinks\//, '外部链接'], [/^xl\/activeX\//, '控件'], [/^xl\/ctrlProps\//, '控件'], [/^xl\/threadedComments\//, '批注'],
];
async function lockReasonOf(bytes) {
    const JSZip = require('jszip');
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    const found = [...new Set(LOST_PARTS.filter(([pattern]) => names.some((name) => pattern.test(name))).map(([, label]) => label))];
    return found.length ? `里面有${found.join('、')}，文坊写回时会丢失这些内容，因此只读` : '';
}
async function readWorkbook(bytes) {
    const ExcelJS = require('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    const sheets = [];
    book.eachSheet((sheet) => {
        if (sheet.state && sheet.state !== 'visible') return; // 藏起来的表不列
        const rows = [];
        let truncated = false;
        const width = Math.min(MAX_COLS, sheet.actualColumnCount || sheet.columnCount || 0);
        if ((sheet.columnCount || 0) > MAX_COLS) truncated = true;
        const formulas = {};
        sheet.eachRow({ includeEmpty: true }, (row, number) => {
            if (number > MAX_ROWS) { truncated = true; return; }
            const cells = [];
            for (let col = 1; col <= width; col += 1) {
                const cell = row.getCell(col);
                cells.push(cellText(cell.value));
                if (cell.formula) formulas[`${number - 1}:${col - 1}`] = `=${cell.formula}`;
            }
            rows[number - 1] = cells;
        });
        for (let k = 0; k < rows.length; k += 1) if (!rows[k]) rows[k] = [];
        // 末尾全空的行不要
        while (rows.length && rows[rows.length - 1].every((cell) => cell === '')) rows.pop();
        sheets.push({ name: sheet.name, rows, truncated, formulas });
    });
    return sheets;
}

// 格子里写的字变成 Excel 的值：= 开头是公式，原来是数字、空格子的数字还是数字，原来是日期的日期还是日期。
function cellValue(text, previous) {
    if (text === '') return null;
    if (/^=./.test(text)) return { formula: text.slice(1) };
    const plainNumber = /^[-+]?(0|[1-9]\d*)(\.\d+)?$/.test(text);
    if (plainNumber && (typeof previous === 'number' || previous === null || previous === undefined || previous?.formula)) return Number(text);
    if (previous instanceof Date) {
        const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(text);
        if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +(match[4] || 0), +(match[5] || 0)));
    }
    return text;
}
// 共享公式写回时要求主格子还在：要改的表先展开成各写各的。
function expandSharedFormulas(sheet) {
    const shared = [];
    sheet.eachRow((row) => row.eachCell((cell) => {
        if (cell.value?.sharedFormula || cell.value?.shareType === 'shared') shared.push([cell, { formula: cell.formula, result: cell.value.result }]);
    }));
    for (const [cell, value] of shared) cell.value = value;
}
async function writeWorkbook(bytes, changes) {
    const ExcelJS = require('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    for (const name of new Set(changes.map((change) => change.sheet))) {
        const sheet = book.getWorksheet(name);
        if (!sheet) throw new Error(`没有 ${name} 这张表。`);
        expandSharedFormulas(sheet);
    }
    for (const { sheet: name, row, col, text } of changes) {
        const cell = book.getWorksheet(name).getCell(row + 1, col + 1);
        cell.value = cellValue(String(text ?? ''), cell.value);
    }
    book.calcProperties = { ...book.calcProperties, fullCalcOnLoad: true }; // 文坊不算公式，Excel 打开时重算
    return Buffer.from(await book.xlsx.writeBuffer());
}

async function read(file) {
    if (!isSheet(file) || !path.isAbsolute(String(file))) throw new Error('不是表格文件。');
    const resolved = path.resolve(file);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile()) throw new Error(`找不到这个表格：${resolved}`);
    if (stat.size > MAX_BYTES) throw new Error('表格超过 50 MB，文坊不打开，请使用默认程序打开。');
    if (!(await require('../fileAccess').allowed(resolved))) throw new Error('这个表格不在文库或最近打开的文件中，文坊不打开。');
    const bytes = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    let sheets;
    let encoding = '';
    let format = null;
    let lockReason = '';
    if (ext === '.xlsx' || ext === '.xlsm') {
        try {
            sheets = await readWorkbook(bytes);
            lockReason = await lockReasonOf(bytes);
        } catch (error) {
            throw new Error(`无法解析这个 .xlsx（${error.message}），请使用默认程序打开。`);
        }
        if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [], truncated: false }];
    } else {
        const decoded = decodeText(bytes);
        encoding = encodingLabel(decoded.encoding);
        const delimiter = delimiterOf(decoded.text, ext);
        const parsed = parseDelimited(decoded.text, delimiter);
        sheets = [{ name: path.basename(resolved), rows: parsed.rows, truncated: parsed.truncated }];
        format = { delimiter, encoding: decoded.encoding, bom: decoded.bom, eol: /\r\n/.test(decoded.text) ? '\r\n' : '\n',
            endsWithNewline: /[\r\n]$/.test(decoded.text) || !decoded.text, everyQuoted: parsed.everyQuoted };
    }
    if (sheets.some((sheet) => sheet.truncated)) lockReason = '仅读取了前一部分，无法保存';
    await Promise.resolve(deps?.rememberRecentFile?.(resolved)).catch(() => {});
    return { success: true, filePath: resolved, name: path.basename(resolved), sheets, encoding, format, lockReason, mtime: stat.mtimeMs, size: stat.size };
}

async function save(payload) {
    if (!isSheet(payload.path) || !path.isAbsolute(String(payload.path))) throw new Error('不是表格文件。');
    const resolved = path.resolve(payload.path);
    if (!(await require('../fileAccess').allowed(resolved))) throw new Error('这个表格不在文库或最近打开的文件中，文坊不修改它。');
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat && !payload.force && Number.isFinite(payload.mtime) && Math.abs(stat.mtimeMs - payload.mtime) > 1) {
        return { success: false, conflict: true, mtime: stat.mtimeMs };
    }
    const data = payload.format
        ? encodeText(writeDelimited(payload.rows, payload.format), payload.format)
        : await writeWorkbook(await fs.readFile(resolved), payload.changes || []);
    const temporary = `${resolved}.scriptorium-writing-${process.pid}-${Date.now()}`;
    try {
        await fs.writeFile(temporary, data);
        await replaceWith(temporary, resolved);
    } finally {
        await fs.remove(temporary).catch(() => {});
    }
    const after = await fs.stat(resolved);
    return { success: true, mtime: after.mtimeMs, size: after.size };
}

async function act(_event, payload = {}) {
    switch (payload.command) {
        case 'read': return read(payload.path);
        case 'save': return save(payload);
        case 'stat': {
            const stat = await fs.stat(path.resolve(String(payload.path || ''))).catch(() => null);
            return stat ? { mtime: stat.mtimeMs, size: stat.size } : { missing: true };
        }
        default: throw new Error(`未知的表格操作：${payload.command}`);
    }
}

function register(ipcMain, value) {
    deps = value;
    ipcMain.removeHandler('scriptorium:sheet');
    ipcMain.handle('scriptorium:sheet', (event, payload) => act(event, payload));
}

module.exports = { register, isSheet, parseDelimited, writeDelimited, cellValue, writeWorkbook, lockReasonOf, _act: act };
