// desktop-remote.js
// DesktopRemote 插件的数据管道与参数校验层。
// 从 stdin 读取一个 JSON 对象，规范化后把命令载荷打印到 stdout。
// 实际的桌面控制由主进程 modules/ipc/desktopRemoteHandlers.js 执行。
//
// 工具参数经 VCP 解析后多为字符串，因此对象/数组类参数（configPatch、rules、
// metricsOptions、options）一律先尝试 JSON.parse。

'use strict';

const VALID_COMMANDS = "'SetWallpaper', 'QueryDesktop', 'QueryDock', 'ViewWidgetSource', 'CreateWidget', 'SetStyleAutomation', 'GetStyleAutomationStatus'";

/**
 * 取第一个有值的键。保留 0 与 false，跳过 undefined / null / 空字符串。
 * @param {object} args
 * @param {...string} keys
 * @returns {*} 未命中时返回 undefined
 */
function _pick(args, ...keys) {
    for (const key of keys) {
        const value = args[key];
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

/**
 * @param {*} val
 * @returns {number|null}
 */
function _parseNumber(val) {
    if (val === undefined || val === null || val === '') return null;
    const num = Number(val);
    return Number.isFinite(num) ? num : null;
}

/**
 * @param {*} val
 * @returns {boolean}
 */
function _parseBoolean(val) {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.trim().toLowerCase() === 'true';
    return !!val;
}

/**
 * 对象或数组参数：已是对象则原样返回，字符串则 JSON.parse。
 * @param {*} val
 * @param {string} name 参数名，用于报错
 * @returns {*} 未提供时返回 null
 */
function _parseJsonLike(val, name) {
    if (val === undefined || val === null) return null;
    if (typeof val !== 'string') return val;
    const text = val.trim();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (err) {
        throw new Error(`The '${name}' parameter must be valid JSON: ${err.message}`);
    }
}

function _isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
}

function buildSetWallpaper(args) {
    const wallpaperSource = _pick(args, 'wallpaperSource', 'wallpapersource', 'WallpaperSource',
        'source', 'Source', 'url', 'URL', 'content', 'Content');
    if (!wallpaperSource) {
        throw new Error("The 'wallpaperSource' parameter is required for SetWallpaper command.");
    }
    return { command: 'SetWallpaper', wallpaperSource };
}

function buildViewWidgetSource(args) {
    const widgetId = _pick(args, 'widgetId', 'widgetid', 'WidgetId', 'widget_id', 'id', 'Id');
    if (!widgetId) {
        throw new Error("The 'widgetId' parameter is required for ViewWidgetSource command.");
    }
    return { command: 'ViewWidgetSource', widgetId: String(widgetId) };
}

function buildCreateWidget(args) {
    const htmlContent = _pick(args, 'htmlContent', 'htmlcontent', 'HtmlContent', 'html', 'Html', 'content', 'Content');
    const builtinWidgetKey = _pick(args, 'builtinWidgetKey', 'builtinwidgetkey', 'BuiltinWidgetKey', 'builtin_widget_key', 'builtinKey');
    const metricComponent = _pick(args, 'metricComponent', 'metriccomponent', 'MetricComponent', 'metric_component');

    if (!htmlContent && !builtinWidgetKey && !metricComponent) {
        throw new Error("CreateWidget requires one of 'htmlContent', 'builtinWidgetKey' or 'metricComponent'.");
    }

    const payload = { command: 'CreateWidget' };
    if (htmlContent) payload.htmlContent = htmlContent;
    if (builtinWidgetKey) payload.builtinWidgetKey = String(builtinWidgetKey);
    if (metricComponent) payload.metricComponent = String(metricComponent);

    // 位置与尺寸：0 是合法值
    const numberFields = {
        x: ['x', 'X', 'posX', 'positionX'],
        y: ['y', 'Y', 'posY', 'positionY'],
        width: ['width', 'Width', 'w'],
        height: ['height', 'Height', 'h'],
    };
    for (const [field, keys] of Object.entries(numberFields)) {
        const num = _parseNumber(_pick(args, ...keys));
        if (num !== null) payload[field] = num;
    }

    const widgetId = _pick(args, 'widgetId', 'widgetid', 'WidgetId', 'widget_id', 'id', 'Id');
    if (widgetId) payload.widgetId = String(widgetId);

    // 复用已有归档目录，避免收藏时重复建夹
    const preSavedId = _pick(args, 'preSavedId', 'presavedid', 'PreSavedId', 'pre_saved_id');
    if (preSavedId) payload.preSavedId = String(preSavedId);

    // 透传给渲染端，内置挂件 spawn 时会用到
    const options = _parseJsonLike(_pick(args, 'options', 'Options'), 'options');
    if (options !== null) {
        if (!_isPlainObject(options)) {
            throw new Error("The 'options' parameter must be a JSON object.");
        }
        payload.options = options;
    }

    if (_parseBoolean(_pick(args, 'autoSave', 'autosave', 'AutoSave', 'auto_save'))) payload.autoSave = true;
    const saveName = _pick(args, 'saveName', 'savename', 'SaveName', 'save_name', 'name', 'Name');
    if (saveName) payload.saveName = String(saveName);

    // 外部脚本：保存为挂件目录下的 app.js，因此强制持久化
    const scriptCode = _pick(args, 'scriptFiles', 'scriptfiles', 'ScriptFiles', 'script_files',
        'scriptCode', 'scriptcode', 'ScriptCode', 'script_code');
    if (typeof scriptCode === 'string' && scriptCode.trim().length > 0) {
        payload.scriptCode = scriptCode;
        payload.autoSave = true;
        if (!payload.saveName) payload.saveName = 'AI Widget';
    }

    return payload;
}

function buildSetStyleAutomation(args) {
    // 以调用方传入的 configPatch 为底，顶层字段覆盖其上
    const base = _parseJsonLike(_pick(args, 'configPatch', 'ConfigPatch', 'config_patch'), 'configPatch');
    if (base !== null && !_isPlainObject(base)) {
        throw new Error("The 'configPatch' parameter must be a JSON object.");
    }
    const configPatch = base ? { ...base } : {};

    const enabledRaw = _pick(args, 'enabled', 'Enabled', 'enable', 'Enable');
    if (enabledRaw !== undefined) configPatch.enabled = _parseBoolean(enabledRaw);

    const intervalMs = _parseNumber(_pick(args, 'intervalMs', 'IntervalMs', 'interval', 'Interval', 'pollIntervalMs', 'PollIntervalMs'));
    if (intervalMs !== null) configPatch.intervalMs = intervalMs;

    const metricsOptions = _parseJsonLike(_pick(args, 'metricsOptions', 'MetricsOptions', 'metrics_options'), 'metricsOptions');
    if (metricsOptions !== null) {
        if (!_isPlainObject(metricsOptions)) {
            throw new Error("The 'metricsOptions' parameter must be a JSON object.");
        }
        configPatch.metricsOptions = metricsOptions;
    }

    const rules = _parseJsonLike(_pick(args, 'rules', 'Rules'), 'rules');
    if (rules !== null) configPatch.rules = rules;
    if (configPatch.rules !== undefined && !Array.isArray(configPatch.rules)) {
        throw new Error("The 'rules' parameter must be a JSON array.");
    }

    const persist = _parseBoolean(_pick(args, 'persist', 'Persist', 'save', 'Save', 'persistConfig', 'PersistConfig'));

    return { command: 'SetStyleAutomation', configPatch, persist };
}

/**
 * 把工具参数规范化为主进程可执行的命令载荷。
 * @param {object} args
 * @returns {object}
 */
function buildPayload(args) {
    if (!_isPlainObject(args)) {
        throw new Error('Input must be a JSON object.');
    }
    const command = _pick(args, 'command', 'Command', 'action', 'Action');
    if (!command) {
        throw new Error(`The 'command' parameter is required. Valid commands: ${VALID_COMMANDS}.`);
    }

    switch (String(command).toLowerCase()) {
        case 'setwallpaper':
        case 'set_wallpaper':
            return buildSetWallpaper(args);
        case 'querydesktop':
        case 'query_desktop':
        case 'query':
            return { command: 'QueryDesktop' };
        case 'querydock':
        case 'query_dock':
        case 'listapps':
        case 'list_apps':
            return { command: 'QueryDock' };
        case 'viewwidgetsource':
        case 'view_widget_source':
        case 'viewsource':
            return buildViewWidgetSource(args);
        case 'createwidget':
        case 'create_widget':
        case 'create':
            return buildCreateWidget(args);
        case 'setstyleautomation':
        case 'set_style_automation':
        case 'styleautomation':
        case 'style_automation':
            return buildSetStyleAutomation(args);
        case 'getstyleautomationstatus':
        case 'get_style_automation_status':
        case 'styleautomationstatus':
        case 'style_automation_status':
            return { command: 'GetStyleAutomationStatus' };
        default:
            throw new Error(`Unknown command: '${command}'. Valid commands: ${VALID_COMMANDS}.`);
    }
}

module.exports = { buildPayload };

if (require.main === module) {
    let inputBuffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        inputBuffer += chunk;
    });
    process.stdin.on('end', () => {
        try {
            if (!inputBuffer.trim()) {
                throw new Error('No input received.');
            }
            const payload = buildPayload(JSON.parse(inputBuffer));
            console.log(JSON.stringify(payload));
        } catch (error) {
            console.error(error.message);
            process.exit(1);
        }
    });
}