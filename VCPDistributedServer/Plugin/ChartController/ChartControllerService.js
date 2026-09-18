'use strict';

let runtime = {
    chartService: null,
    logger: console,
};

function initialize(options = {}) {
    runtime = {
        chartService: options.services?.chartService || options.chartService || null,
        logger: options.logger || console,
    };
}

function requireService() {
    if (!runtime.chartService) {
        throw new Error('[ChartController] 图表服务当前不可用。');
    }
    return runtime.chartService;
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function commandOf(args) {
    return firstString(args.command, args.action, args.commandIdentifier).toLowerCase();
}

function chartIdOf(args) {
    const chartId = firstString(args.chartId, args.chart_id, args.id, args.name);
    if (!chartId) throw new Error('[ChartController] 缺少必需参数 chartId。');
    return chartId;
}

function parseJson(value, fieldName, fallback = undefined, allowArray = true) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'object') {
        if (!allowArray && Array.isArray(value)) {
            throw new Error(`[ChartController] ${fieldName} 必须是 JSON 对象。`);
        }
        return value;
    }
    if (typeof value !== 'string') {
        throw new Error(`[ChartController] ${fieldName} 必须是 JSON。`);
    }
    try {
        const parsed = JSON.parse(value);
        if (!allowArray && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
            throw new Error('根值不是对象');
        }
        return parsed;
    } catch (error) {
        throw new Error(`[ChartController] ${fieldName} 不是有效 JSON：${error.message}`);
    }
}

function optionalBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    throw new Error(`[ChartController] 布尔参数必须为 true 或 false：${value}`);
}

function optionalNumber(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`[ChartController] 数字参数无效：${value}`);
    return parsed;
}

function textResult(text, details = {}) {
    return {
        content: [{ type: 'text', text }],
        details,
    };
}

function markdownFence(content, language = '') {
    const text = String(content ?? '');
    const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1));
    const fence = '`'.repeat(longest);
    return `${fence}${language}\n${text}\n${fence}`;
}

function summarizeChart(chart) {
    return [
        `- **${chart.name || chart.id}** (\`${chart.id}\`)`,
        `  - 代码版本：${chart.codeRevision}；数据版本：${chart.dataRevision}`,
        `  - 依赖：${chart.libraries?.length ? chart.libraries.join(', ') : '标准 DOM / Canvas'}`,
        `  - 当前展示：${chart.opened ? '是' : '否'}`,
        chart.description ? `  - ${chart.description}` : '',
    ].filter(Boolean).join('\n');
}

function parseOperations(args) {
    const direct = parseJson(args.operations ?? args.patch, 'operations', null);
    if (Array.isArray(direct)) return direct;

    const numbered = Object.entries(args)
        .map(([key, value]) => {
            const match = key.match(/^op(\d+)$/i);
            return match ? { index: Number(match[1]), op: value } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.index - b.index)
        .map(entry => {
            const suffix = String(entry.index);
            const operation = { op: entry.op };
            for (const [key, value] of Object.entries(args)) {
                if (!key.endsWith(suffix) || key.toLowerCase() === `op${suffix}`) continue;
                const name = key.slice(0, -suffix.length);
                operation[name] = ['value', 'items'].includes(name)
                    ? parseJson(value, `${name}${suffix}`, value)
                    : value;
            }
            return operation;
        });
    if (numbered.length) return numbered;

    const op = firstString(args.op, args.operation);
    if (!op) throw new Error('[ChartController] 缺少 operations 或 op。');
    return [{
        op,
        path: args.path ?? args.dataPath ?? '',
        value: args.value === undefined ? undefined : parseJson(args.value, 'value', args.value),
        from: args.from,
        maxItems: optionalNumber(args.maxItems),
        start: optionalNumber(args.start),
        deleteCount: optionalNumber(args.deleteCount),
        items: parseJson(args.items, 'items', undefined),
        spread: args.spread === undefined ? undefined : optionalBoolean(args.spread),
    }];
}

async function listCharts(args) {
    const charts = await requireService().listCharts({ query: args.query });
    return textResult(
        charts.length
            ? `# 图表列表\n\n${charts.map(summarizeChart).join('\n\n')}`
            : '# 图表列表\n\n当前没有图表。',
        { command: 'ListCharts', count: charts.length, charts }
    );
}

async function getChart(args) {
    const chartId = chartIdOf(args);
    const manifest = await requireService().readManifest(chartId);
    return textResult([
        `# 图表：${manifest.name} (${manifest.id})`,
        '',
        `- 描述：${manifest.description || '无'}`,
        `- Revision：${manifest.revision}`,
        `- Code Revision：${manifest.codeRevision}`,
        `- Data Revision：${manifest.dataRevision}`,
        `- 依赖：${manifest.libraries?.join(', ') || '无'}`,
        `- 尺寸：${manifest.window?.width}×${manifest.window?.height}`,
    ].join('\n'), { command: 'GetChart', manifest });
}

async function getChartData(args) {
    const chartId = chartIdOf(args);
    const service = requireService();
    const manifest = await service.readManifest(chartId);
    const data = await service.readData(chartId);
    const paths = parseJson(args.paths, 'paths', null);
    let selected = data;
    if (args.path) {
        selected = getPointerValue(data, args.path);
    } else if (Array.isArray(paths)) {
        selected = Object.fromEntries(paths.map(pointer => [pointer, getPointerValue(data, pointer)]));
    }
    if (args.tail !== undefined && Array.isArray(selected)) {
        selected = selected.slice(-Math.max(0, Number(args.tail) || 0));
    }
    return textResult([
        `# 图表数据：${manifest.name} (${manifest.id})`,
        '',
        `- Data Revision：${manifest.dataRevision}`,
        '',
        markdownFence(JSON.stringify(selected, null, 2), 'json'),
    ].join('\n'), {
        command: 'GetChartData',
        chartId: manifest.id,
        dataRevision: manifest.dataRevision,
        data: selected,
    });
}

function getPointerValue(root, pointer) {
    if (!pointer) return root;
    if (typeof pointer !== 'string' || !pointer.startsWith('/')) {
        throw new Error(`[ChartController] 无效 JSON Pointer：${pointer}`);
    }
    return pointer.slice(1).split('/').map(token =>
        token.replace(/~1/g, '/').replace(/~0/g, '~')
    ).reduce((current, token) => {
        if (current === null || current === undefined || !(token in Object(current))) {
            throw new Error(`[ChartController] 数据路径不存在：${pointer}`);
        }
        return current[token];
    }, root);
}

async function readDataSource(args) {
    const chartId = chartIdOf(args);
    const result = await requireService().readDataSource(chartId, {
        type: args.type,
        source: args.source ?? args.path ?? args.url,
        path: args.path,
        url: args.url,
        sql: args.sql,
        params: parseJson(args.params, 'params', undefined),
        headers: parseJson(args.headers, 'headers', undefined, false),
        timeoutMs: optionalNumber(args.timeoutMs),
        encoding: args.encoding,
        delimiter: args.delimiter,
        header: args.header === undefined ? undefined : optionalBoolean(args.header, true),
    });
    const preview = JSON.stringify(result.data, null, 2);
    const maxPreviewChars = 60000;
    const visible = preview.length > maxPreviewChars
        ? `${preview.slice(0, maxPreviewChars)}\n... [结果预览已截断]`
        : preview;
    return textResult([
        `# 图表只读数据源：${chartId}`,
        '',
        `- 类型：${result.type}`,
        `- 来源：${result.source}`,
        result.rowCount === undefined ? '' : `- 行数：${result.rowCount}`,
        result.byteLength === undefined ? '' : `- 文件/响应大小：${result.byteLength} 字节`,
        result.truncated ? '- 注意：结构化结果已按行数上限截断' : '',
        '',
        markdownFence(visible, result.type === 'text' ? 'text' : 'json'),
    ].filter(Boolean).join('\n'), {
        command: 'ReadDataSource',
        chartId,
        ...result,
    });
}

async function getChartSource(args) {
    const source = await requireService().getSource(
        chartIdOf(args),
        args.file || 'runtime.js',
        { lines: args.lines }
    );
    const languages = {
        'chart.json': 'json',
        'data.json': 'json',
        'template.html': 'html',
        'style.css': 'css',
        'runtime.js': 'javascript',
    };
    return textResult([
        `# 图表源码：${source.chartId} / ${source.file}`,
        '',
        `- Code Revision：${source.codeRevision}`,
        `- SHA-256：${source.hash}`,
        source.lines
            ? `- 行范围：${source.lines.actualStart}-${source.lines.actualEnd}/${source.lines.totalLines}`
            : `- 字节数：${source.totalBytes}`,
        '',
        markdownFence(source.content, languages[source.file] || ''),
    ].join('\n'), { command: 'GetChartSource', ...source });
}

async function createChart(args, executionContext) {
    const manifest = parseJson(args.manifest, 'manifest', null, false) || {
        id: args.chartId || args.id,
        name: args.name,
        description: args.description,
        libraries: parseJson(args.libraries, 'libraries', []),
        window: parseJson(args.window, 'window', undefined, false),
        access: parseJson(args.access, 'access', undefined, false),
    };
    const result = await requireService().createChart({
        manifest,
        template: args.template ?? args.html,
        style: args.style ?? args.css,
        runtime: args.runtime ?? args.js,
        initialData: args.initialData ?? args.data,
        open: optionalBoolean(args.open, true),
    }, executionContext);
    return textResult([
        `图表“${result.manifest.name}”已创建${result.opened ? '并在工作台中打开' : ''}。`,
        `- Chart ID：${result.manifest.id}`,
        `- Code Revision：${result.manifest.codeRevision}`,
        `- Data Revision：${result.manifest.dataRevision}`,
        `- 诊断：${result.diagnostics.length ? `${result.diagnostics.length} 项警告` : '通过'}`,
    ].join('\n'), { command: 'CreateChart', ...result });
}

async function openChart(args) {
    const result = await requireService().openChart(chartIdOf(args), {
        focus: optionalBoolean(args.focus, true),
    });
    return textResult(`图表 ${result.chartId} 已在图表工作台中选中。`, {
        command: 'OpenChart',
        ...result,
    });
}

async function closeChart(args) {
    const result = await requireService().closeChart(chartIdOf(args));
    return textResult(`图表 ${result.chartId} 已从当前展示区关闭；定义和数据仍然保留。`, {
        command: 'CloseChart',
        ...result,
    });
}

async function deleteChart(args, executionContext) {
    const result = await requireService().deleteChart(chartIdOf(args), {
        expectedRevision: args.expectedRevision,
    }, executionContext);
    return textResult(
        `图表 ${result.chartId} 已移入可恢复回收区。Trash ID：${result.trashId}`,
        { command: 'DeleteChart', ...result }
    );
}

async function listDeletedCharts() {
    const charts = await requireService().listDeletedCharts();
    return textResult(
        charts.length
            ? `# 已删除图表\n\n${charts.map(chart =>
                `- ${chart.name} (\`${chart.chartId}\`) · Trash ID: \`${chart.trashId}\` · ${chart.deletedAt}`
            ).join('\n')}`
            : '# 已删除图表\n\n回收区为空。',
        { command: 'ListDeletedCharts', count: charts.length, charts }
    );
}

async function restoreChart(args) {
    const trashId = firstString(args.trashId, args.trash_id);
    if (!trashId) throw new Error('[ChartController] 缺少必需参数 trashId。');
    const result = await requireService().restoreChart(trashId);
    return textResult(`图表 ${result.chartId} 已从回收区恢复。`, {
        command: 'RestoreChart',
        ...result,
    });
}

async function purgeChart(args) {
    const trashId = firstString(args.trashId, args.trash_id);
    if (!trashId) throw new Error('[ChartController] 缺少必需参数 trashId。');
    if (!optionalBoolean(args.confirm, false)) {
        throw new Error('[ChartController] 永久删除需要 confirm=true。');
    }
    const result = await requireService().purgeChart(trashId);
    return textResult(`回收项 ${trashId} 已永久删除。`, {
        command: 'PurgeChart',
        ...result,
    });
}

async function mutateData(args, executionContext) {
    const operations = parseOperations(args);
    const result = await requireService().applyDataOperations(
        chartIdOf(args),
        operations,
        {
            expectedRevision: args.expectedRevision,
            expectedDataRevision: args.expectedDataRevision,
            operationId: args.operationId,
        },
        executionContext
    );
    return textResult([
        `图表 ${result.chartId} 已完成 ${operations.length} 项增量数据操作。`,
        `- Data Revision：${result.oldDataRevision} → ${result.dataRevision}`,
        `- 变化路径：${result.changedPaths.map(value => `\`${value || '/'}\``).join(', ')}`,
    ].join('\n'), { command: 'PatchData', ...result });
}

async function setData(args, executionContext) {
    if (args.path === undefined && args.dataPath === undefined) {
        throw new Error('[ChartController] SetData 缺少 path。');
    }
    return mutateData({
        ...args,
        operations: [{
            op: args.create === true || String(args.create).toLowerCase() === 'true' ? 'set' : 'replace',
            path: args.path ?? args.dataPath,
            value: parseJson(args.value, 'value', args.value),
        }],
    }, executionContext);
}

async function replaceData(args, executionContext) {
    const result = await requireService().replaceData(
        chartIdOf(args),
        args.data,
        { expectedDataRevision: args.expectedDataRevision },
        executionContext
    );
    return textResult(
        `图表 ${result.chartId} 的完整数据已替换，Data Revision 为 ${result.dataRevision}。`,
        { command: 'ReplaceData', ...result }
    );
}

async function editChartSource(args, executionContext) {
    const result = await requireService().editSource(chartIdOf(args), {
        file: args.file,
        target: args.target,
        replace: args.replace,
        content: args.content,
        expectedCodeRevision: args.expectedCodeRevision,
        expectedRevision: args.expectedRevision,
    }, executionContext);
    return textResult([
        `图表 ${result.chartId} 的 ${result.file} 已更新。`,
        `- Code Revision：${result.oldCodeRevision} → ${result.codeRevision}`,
        result.matchCount === null ? '- 编辑方式：完整替换' : `- target 命中：${result.matchCount}`,
        `- 换行格式：${result.lineEnding}`,
        `- 诊断：${result.diagnostics.length ? `${result.diagnostics.length} 项警告` : '通过'}`,
    ].join('\n'), { command: 'EditChartSource', ...result });
}

async function rollbackChartSource(args, executionContext) {
    const result = await requireService().rollbackSource(
        chartIdOf(args),
        args.file,
        args.targetRevision,
        executionContext
    );
    return textResult(
        `图表 ${result.chartId} 的 ${result.file} 已回滚并生成新代码版本 ${result.codeRevision}。`,
        { command: 'RollbackChartSource', ...result }
    );
}

async function observeChart(args) {
    return requireService().observeChart(chartIdOf(args), {
        mode: args.mode || 'preview',
        width: optionalNumber(args.width),
        height: optionalNumber(args.height),
        format: args.format || 'png',
        quality: optionalNumber(args.quality),
        timeoutMs: optionalNumber(args.timeoutMs),
        region: parseJson(args.region, 'region', undefined, false),
        focus: optionalBoolean(args.focus, false),
    });
}

async function runtimeStatus(args) {
    const result = await requireService().getRuntimeStatus(chartIdOf(args));
    return textResult([
        `# 图表运行状态：${result.chartId}`,
        '',
        `- 状态：${result.status}`,
        `- Code Revision：${result.codeRevision}`,
        `- Data Revision：${result.dataRevision}`,
        result.message ? `- 错误：${result.message}` : '',
    ].filter(Boolean).join('\n'), { command: 'GetChartRuntimeStatus', ...result });
}

async function processToolCall(args = {}, executionContext = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[ChartController] 无效的工具参数。');
    }
    switch (commandOf(args)) {
        case 'listcharts': return listCharts(args);
        case 'getchart': return getChart(args);
        case 'getchartdata': return getChartData(args);
        case 'readdatasource': return readDataSource(args);
        case 'getchartsources':
        case 'getchartsource': return getChartSource(args);
        case 'createchart': return createChart(args, executionContext);
        case 'openchart': return openChart(args);
        case 'closechart': return closeChart(args);
        case 'deletechart': return deleteChart(args, executionContext);
        case 'listdeletedcharts': return listDeletedCharts();
        case 'restorechart': return restoreChart(args);
        case 'purgechart': return purgeChart(args);
        case 'setdata': return setData(args, executionContext);
        case 'patchdata':
        case 'mutatedata': return mutateData(args, executionContext);
        case 'replacedata': return replaceData(args, executionContext);
        case 'editchartsource':
        case 'replacechartsource': return editChartSource(args, executionContext);
        case 'rollbackchartsource': return rollbackChartSource(args, executionContext);
        case 'observechart': return observeChart(args);
        case 'getchartruntimestatus': return runtimeStatus(args);
        default:
            throw new Error(
                '[ChartController] 不支持的 command。可用值：ListCharts、GetChart、GetChartData、ReadDataSource、GetChartSource、CreateChart、OpenChart、CloseChart、DeleteChart、ListDeletedCharts、RestoreChart、PurgeChart、SetData、PatchData、MutateData、ReplaceData、EditChartSource、RollbackChartSource、ObserveChart、GetChartRuntimeStatus。'
            );
    }
}

function resetForTests() {
    runtime = { chartService: null, logger: console };
}

module.exports = {
    initialize,
    processToolCall,
    _test: {
        commandOf,
        chartIdOf,
        parseJson,
        parseOperations,
        markdownFence,
        getPointerValue,
        resetForTests,
    },
};