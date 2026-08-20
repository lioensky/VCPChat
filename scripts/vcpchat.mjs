#!/usr/bin/env node

/**
 * Hermes-inspired one-command managed entrypoint.
 *
 * This is deliberately separate from npm start, BAT and VBS launchers. It
 * diagnoses first, shows a bounded repair plan, and only mutates the project
 * after explicit --repair --yes consent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collectDoctorReport } = require('../modules/bootstrap/environment-doctor');
const { resolveProjectStateRoot } = require('../modules/bootstrap/launch-protocol');
const { isFresh: isBootstrapMarkerFresh, writeMarker } = require('../modules/bootstrap/bootstrap-marker');
const { createRepairPlan, executeRepairPlan } = require('../modules/bootstrap/repair-planner');
import { runManagedLauncher } from './vcpchat-dev-launcher.mjs';

function parseArguments(argv) {
    const options = {
        help: false,
        applyRepair: false,
        confirmed: false,
        full: false,
        includeRust: false,
        repairVendor: false,
        json: false,
        deepDoctor: true,
        projectRoot: null,
        readyTimeoutMs: null,
        handoff: false,
        appArgs: [],
    };
    let passThrough = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (passThrough) options.appArgs.push(argument);
        else if (argument === '--') passThrough = true;
        else if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--repair') options.applyRepair = true;
        else if (argument === '--yes') options.confirmed = true;
        else if (argument === '--full') options.full = true;
        else if (argument === '--include-rust') options.includeRust = true;
        else if (argument === '--repair-vendor') options.repairVendor = true;
        else if (argument === '--json') options.json = true;
        else if (argument === '--shallow-doctor') options.deepDoctor = false;
        else if (argument === '--project-root') options.projectRoot = argv[++index] || null;
        else if (argument === '--ready-timeout-ms') options.readyTimeoutMs = Number(argv[++index]);
        else if (argument === '--handoff') options.handoff = true;
        else throw new Error(`未知参数：${argument}`);
    }
    if (options.readyTimeoutMs != null && (!Number.isFinite(options.readyTimeoutMs) || options.readyTimeoutMs <= 0)) {
        throw new Error('--ready-timeout-ms 必须是正数。');
    }
    if (options.confirmed && !options.applyRepair) throw new Error('--yes 只能与 --repair 一起使用。');
    return options;
}

function usage() {
    return [
        'VCPChat Hermes-inspired managed launcher',
        '',
        'npm run vcpchat                         diagnose then launch',
        'npm run vcpchat -- --repair --yes       repair after explicit consent, then launch',
        'npm run vcpchat -- --full --repair --yes include full optional repair stages',
        'npm run vcpchat -- -- --desktop-only    pass arguments to Electron',
        '',
        '原有 npm start、BAT 和 VBS 启动入口不会被修改。',
    ].join('\n');
}

function planSummary(plan) {
    return {
        episodeId: plan.episode.id,
        attempts: plan.attempts,
        budgetRemaining: plan.budgetRemaining,
        stages: plan.stages.map(stage => ({ id: stage.id, mutates: Boolean(stage.mutates), optional: Boolean(stage.optional) })),
    };
}

function write(io, options, value) {
    if (options.json || typeof value === 'object') io.stdout.write(`${JSON.stringify(value)}\n`);
    else io.stdout.write(`${value}\n`);
}

export async function runVcpchat({
    argv = process.argv.slice(2),
    projectRoot = null,
    env = process.env,
    io = process,
    doctor = collectDoctorReport,
    planFactory = createRepairPlan,
    repair = executeRepairPlan,
    launch = runManagedLauncher,
} = {}) {
    const options = parseArguments(argv);
    if (options.help) {
        io.stdout.write(`${usage()}\n`);
        return 0;
    }
    const root = path.resolve(projectRoot || options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const stateRoot = resolveProjectStateRoot({ projectRoot: root, env });
    const managedEnv = { ...env, VCPCHAT_STATE_DIR: stateRoot };
    const markerFresh = isBootstrapMarkerFresh({ stateRoot, projectRoot: root });
    const report = doctor({ projectRoot: root, deep: options.deepDoctor && !markerFresh, env: managedEnv });
    if (report.ok) {
        writeMarker({ stateRoot, projectRoot: root });
        write(io, options, { type: 'doctor-passed', summary: report.summary });
        const launchArgs = [];
        if (options.readyTimeoutMs != null) launchArgs.push('--ready-timeout-ms', String(options.readyTimeoutMs));
        if (options.handoff) launchArgs.push('--handoff');
        if (options.projectRoot) launchArgs.push('--project-root', root);
        launchArgs.push(...options.appArgs);
        return launch({ argv: launchArgs, projectRoot: root, env: managedEnv, io });
    }

    const plan = planFactory({
        projectRoot: root,
        stateRoot,
        doctorReport: report,
        includeRust: options.includeRust,
        repairVendor: options.repairVendor,
        full: options.full,
    });
    write(io, options, { type: 'repair-required', doctor: report.summary, plan: planSummary(plan) });
    if (!options.applyRepair || !options.confirmed) {
        io.stderr.write('VCPChat 需要修复环境；未修改任何文件。确认后使用：npm run vcpchat -- --repair --yes\n');
        return 3;
    }
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    try {
        await repair({
            plan,
            signal: controller.signal,
            onEvent(event) {
                if (options.json) write(io, options, { type: event.type, operationId: event.operationId, stage: event.stage, result: event.result || null });
                else if (event.type === 'stage-started') io.stdout.write(`→ ${event.stage}\n`);
                else if (event.type === 'stage-completed') io.stdout.write(`✓ ${event.stage}\n`);
            },
        });
    } catch (error) {
        io.stderr.write(`VCPChat 环境修复失败：${error.code || 'E_REPAIR_STAGE_FAILED'} ${error.message}\n`);
        return 1;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
    }
    const verified = doctor({ projectRoot: root, deep: true, env: managedEnv });
    if (!verified.ok) {
        io.stderr.write('VCPChat 修复后仍未通过 Doctor，已停止启动。请打开恢复界面查看证据。\n');
        return 1;
    }
    writeMarker({ stateRoot, projectRoot: root });
    const launchArgs = [];
    if (options.readyTimeoutMs != null) launchArgs.push('--ready-timeout-ms', String(options.readyTimeoutMs));
    if (options.handoff) launchArgs.push('--handoff');
    if (options.projectRoot) launchArgs.push('--project-root', root);
    launchArgs.push(...options.appArgs);
    return launch({ argv: launchArgs, projectRoot: root, env: managedEnv, io });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    runVcpchat().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`VCPChat 托管入口失败：${error.message}\n`);
        process.exitCode = 2;
    });
}

export { parseArguments, planSummary, usage };
