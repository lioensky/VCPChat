#!/usr/bin/env node

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveProjectStateRoot } = require('../modules/bootstrap/launch-protocol');
const { createRepairPlan, executeRepairPlan } = require('../modules/bootstrap/repair-planner');
const { createProgressEvent, encodeProgressEvent } = require('../modules/bootstrap/progress-protocol');

function parseArguments(argv) {
    const options = {
        apply: false,
        confirmed: false,
        json: false,
        full: false,
        includeRust: false,
        repairVendor: false,
        projectRoot: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--apply') options.apply = true;
        else if (argument === '--yes') options.confirmed = true;
        else if (argument === '--json') options.json = true;
        else if (argument === '--full') options.full = true;
        else if (argument === '--include-rust') options.includeRust = true;
        else if (argument === '--repair-vendor') options.repairVendor = true;
        else if (argument === '--project-root') options.projectRoot = argv[++index] || null;
        else throw new Error(`未知参数：${argument}`);
    }
    return options;
}

function printablePlan(plan) {
    return {
        schemaVersion: plan.schemaVersion,
        projectRoot: plan.projectRoot,
        episodeId: plan.episode.id,
        attempts: plan.attempts,
        budgetRemaining: plan.budgetRemaining,
        stages: plan.stages.map(stage => ({
            id: stage.id,
            mutates: stage.mutates,
            optional: Boolean(stage.optional),
            command: stage.kind === 'command' ? [stage.command, ...stage.args] : null,
        })),
    };
}

export async function runRepairCli({ argv = process.argv.slice(2), env = process.env, io = process } = {}) {
    const options = parseArguments(argv);
    const root = path.resolve(options.projectRoot || path.dirname(path.dirname(fileURLToPath(import.meta.url))));
    const stateRoot = resolveProjectStateRoot({ projectRoot: root, env });
    const plan = createRepairPlan({
        projectRoot: root,
        stateRoot,
        includeRust: options.includeRust,
        repairVendor: options.repairVendor,
        full: options.full,
    });
    if (!options.apply) {
        const output = printablePlan(plan);
        if (options.json) io.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        else {
            io.stdout.write(`VCPChat 受控修复计划（episode ${output.episodeId.slice(0, 12)}）\n`);
            output.stages.forEach(stage => io.stdout.write(`- ${stage.mutates ? '[修改]' : '[检查]'} ${stage.id}\n`));
            io.stdout.write(`剩余硬修复预算：${output.budgetRemaining}\n`);
            io.stdout.write('当前仅展示计划；执行需要 --apply --yes。\n');
        }
        return 0;
    }
    if (!options.confirmed) {
        io.stderr.write('拒绝执行：受控修复会修改项目依赖或构建产物，请同时传入 --apply --yes。\n');
        return 2;
    }
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);
    try {
        const result = await executeRepairPlan({
            plan,
            signal: controller.signal,
            onEvent(event) {
                if (options.json) io.stdout.write(encodeProgressEvent(createProgressEvent({
                    type: event.type,
                    operationId: event.operationId,
                    stage: event.stage,
                    detail: event.result || (event.text ? { stream: event.stream, text: event.text } : null),
                })));
                else if (event.type === 'stage-started') io.stdout.write(`→ ${event.stage}\n`);
                else if (event.type === 'stage-output') io.stdout.write(event.text);
                else if (event.type === 'stage-completed') io.stdout.write(`✓ ${event.stage}\n`);
            },
        });
        if (options.json) io.stdout.write(encodeProgressEvent(createProgressEvent({
            type: 'operation-completed',
            operationId: result.operationId,
            detail: { ok: result.ok, stages: result.results.map(item => item.stage) },
        })));
        else io.stdout.write('VCPChat 受控修复完成，并已发布环境指纹。\n');
        return 0;
    } catch (error) {
        io.stderr.write(`VCPChat 受控修复失败：${error.code || 'E_REPAIR_STAGE_FAILED'} ${error.message}\n`);
        return 1;
    } finally {
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onInterrupt);
    }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
    runRepairCli().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 2;
    });
}

export { parseArguments, printablePlan };
