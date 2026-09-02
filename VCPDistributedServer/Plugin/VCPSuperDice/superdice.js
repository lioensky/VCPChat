const readline = require('readline');

const ALLOWED_THEMES = new Set([
    'default',
    'gemstone',
    'rock',
    'rust',
    'smooth',
    'blueGreenMetal',
    'diceOfRolling',
    'gemstoneMarble',
    'wooden',
]);

const ALLOWED_MAGIC = new Set([
    'normal',
    'moon',
    'storm',
    'lead',
    'bounce',
]);

const PHYSICS_LIMITS = Object.freeze({
    gravity: [0.15, 2.5],
    mass: [0.25, 6],
    friction: [0.05, 1],
    restitution: [0, 0.95],
    linearDamping: [0.05, 0.9],
    angularDamping: [0.05, 0.9],
    spinForce: [1, 18],
    throwForce: [1, 10],
    startingHeight: [3, 14],
    settleTimeout: [2500, 10000],
});

function normalizePhysics(value) {
    let source = value;

    if (typeof source === 'string') {
        try {
            source = JSON.parse(source);
        } catch {
            return {};
        }
    }

    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return {};
    }

    return Object.entries(PHYSICS_LIMITS).reduce((normalized, [key, [min, max]]) => {
        const number = Number(source[key]);
        if (Number.isFinite(number)) {
            normalized[key] = Math.min(max, Math.max(min, number));
        }
        return normalized;
    }, {});
}

function normalizeRequest(requestArgs) {
    if (!requestArgs || typeof requestArgs !== 'object' || Array.isArray(requestArgs)) {
        throw new Error('工具参数必须是一个对象。');
    }

    const notation = String(requestArgs.notation || '').trim();
    if (!notation || notation.length > 80) {
        throw new Error('notation 必须是长度不超过 80 的骰子表达式。');
    }

    const normalized = {
        ...requestArgs,
        notation,
        magic: ALLOWED_MAGIC.has(requestArgs.magic) ? requestArgs.magic : 'normal',
        physics: normalizePhysics(requestArgs.physics),
    };

    if (ALLOWED_THEMES.has(requestArgs.theme)) {
        normalized.theme = requestArgs.theme;
    } else {
        delete normalized.theme;
    }

    if (typeof requestArgs.themecolor === 'string'
        && /^#[0-9a-f]{6}$/i.test(requestArgs.themecolor.trim())) {
        normalized.themecolor = requestArgs.themecolor.trim();
    } else {
        delete normalized.themecolor;
    }

    return normalized;
}

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

// 监听从主VCP服务器传来的数据
rl.on('line', (line) => {
    try {
        // 解析并规范化主题、魔法与物理参数；宿主侧还会执行最终安全校验。
        const requestArgs = normalizeRequest(JSON.parse(line));

        // SuperDice 的实际 3D 投掷由宿主 handleDiceControl 处理。
        // 此 stdio 插件负责向宿主转发经过白名单过滤的调用参数。
        process.stdout.write(JSON.stringify(requestArgs) + '\n');

    } catch (error) {
        // 如果发生错误，也以JSON格式报告错误
        const errorResult = {
            status: 'error',
            error: `SuperDice plugin failed to process stdio line: ${error.message}`
        };
        process.stdout.write(JSON.stringify(errorResult) + '\n');
    }
});