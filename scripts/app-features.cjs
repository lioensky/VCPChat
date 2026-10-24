#!/usr/bin/env node
'use strict';

// 按 modules/*/feature.json 的声明跑功能模块自己的构建步骤，package.json 里不写具体功能：
//
//   node scripts/app-features.cjs install     npm install 之后（postinstall）：跑各功能的 scripts.install
//   node scripts/app-features.cjs package     打包之前（pack / dist）：跑各功能的 scripts.package，任一失败就中止打包
//   node scripts/app-features.cjs test [名字]  跑功能系统本身的测试，再加各功能声明的 tests（给名字就只跑那个功能的）
//
// 清单格式见 docs/app-features.md。

const path = require('path');
const { spawnSync } = require('child_process');
const { readFeatureManifests } = require('../modules/appFeatures.js');

const projectRoot = path.resolve(__dirname, '..');

// 功能模块赖以挂接的宿主契约：加载器、主进程钩子、设置扩展、审批事件
const HOST_TESTS = [
    'tests/app-features.test.mjs',
    'tests/host-hooks.test.js',
    'tests/settings-extensions.test.mjs',
    'tests/settings-extension-hosts.test.mjs',
    'tests/notification-tool-approval-events.test.js',
];

function run(args) {
    const result = spawnSync(process.execPath, args, { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
    if (result.error) console.error(result.error.message);
    return result.status === 0;
}

function features() {
    const list = readFeatureManifests({ projectRoot });
    for (const feature of list) {
        if (feature.error) console.warn(`[app-features] 跳过 ${feature.folder}：${feature.error}`);
    }
    return list.filter((feature) => !feature.error);
}

function runHook(hook) {
    let ok = true;
    for (const feature of features()) {
        const args = feature.scripts[hook];
        if (!args) continue;
        console.log(`[app-features] ${feature.name} ${hook}: node ${args.join(' ')}`);
        if (!run(args)) {
            console.error(`[app-features] ${feature.name} 的 ${hook} 失败`);
            ok = false;
        }
    }
    return ok;
}

function runTests(only) {
    const selected = features().filter((feature) => !only || feature.name === only || feature.folder === only);
    if (only && !selected.length) {
        console.error(`[app-features] 没有这个功能：${only}`);
        return false;
    }
    const files = [...new Set([...(only ? [] : HOST_TESTS), ...selected.flatMap((feature) => feature.tests)])];
    if (!files.length) return true;
    return run(['--test', ...files]);
}

const [command, arg] = process.argv.slice(2);
const commands = {
    install: () => runHook('install'),
    package: () => runHook('package'),
    test: () => runTests(arg),
};
if (!commands[command]) {
    console.error('用法：node scripts/app-features.cjs <install|package|test> [功能名]');
    process.exit(2);
}
process.exitCode = commands[command]() ? 0 : 1;
