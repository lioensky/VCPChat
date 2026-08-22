import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(os.tmpdir(), `vcpchat-evidence-${Date.now()}.json`);
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const readEvidence = (envName, label) => {
    const configured = process.env[envName];
    if (!configured) return null;
    const filename = path.resolve(configured);
    if (!fs.existsSync(filename)) throw new Error(`${label} evidence path does not exist: ${filename}`);
    let value;
    try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { throw new Error(`${label} evidence is not valid JSON: ${filename}`, { cause: error }); }
    return { path: filename, value };
};
const mainChatEvidence = readEvidence('VCPCHAT_SEQUENCE_EVIDENCE_OUTPUT', 'main-chat');
const uiAppsEvidence = readEvidence('VCPCHAT_UI_APPS_EVIDENCE_OUTPUT', 'UI Apps');
const matrixEvidence = readEvidence('VCPCHAT_WINDOWS_MATRIX_EVIDENCE_INPUT', 'Windows matrix');
const manualSoakEvidence = readEvidence('VCPCHAT_MANUAL_SOAK_EVIDENCE_INPUT', 'manual soak');
const packagedEvidence = readEvidence('VCPCHAT_PACKAGED_ARTIFACT_EVIDENCE_INPUT', 'packaged artifact');
const mainChatPass = mainChatEvidence?.value?.kind === 'electron-main-chat-sequence'
    && mainChatEvidence.value.requiredEdges === '1/1'
    && Array.isArray(mainChatEvidence.value.coverage?.missingRequiredEdges)
    && mainChatEvidence.value.coverage.missingRequiredEdges.length === 0;
const uiAppsPass = uiAppsEvidence?.value?.kind === 'electron-ui-apps-smoke'
    && Number.isInteger(uiAppsEvidence.value.total)
    && uiAppsEvidence.value.total > 0
    && uiAppsEvidence.value.passed === uiAppsEvidence.value.total;
const matrixRows = matrixEvidence?.value?.rows;
const matrixPass = Array.isArray(matrixRows) && matrixRows.length > 0 && matrixRows.every(row => row.status === 'passed');
const manualSoakStatus = manualSoakEvidence?.value?.status || 'manual_required';
const packagedStatus = packagedEvidence?.value?.status || 'manual_required';
if (matrixEvidence && !Array.isArray(matrixRows)) throw new Error('Windows matrix evidence must contain a rows array');
if (manualSoakEvidence && !['manual_observation_required', 'passed'].includes(manualSoakStatus)) {
    throw new Error(`manual soak evidence has invalid status: ${manualSoakStatus}`);
}
if (packagedEvidence && !['passed', 'failed', 'skipped'].includes(packagedStatus)) {
    throw new Error(`packaged artifact evidence has invalid status: ${packagedStatus}`);
}
if (process.env.VCPCHAT_REAL_ELECTRON_STATUS === 'pass' && (!mainChatPass || !uiAppsPass)) {
    throw new Error('VCPCHAT_REAL_ELECTRON_STATUS=pass requires valid passing main-chat and UI Apps evidence');
}
if (process.env.VCPCHAT_REAL_ELECTRON_STATUS === 'pass') {
    if (!packagedEvidence || packagedStatus !== 'passed') {
        throw new Error(`VCPCHAT_REAL_ELECTRON_STATUS=pass requires packaged artifact status passed (received ${packagedStatus})`);
    }
    if (!matrixEvidence || !matrixPass) {
        throw new Error('VCPCHAT_REAL_ELECTRON_STATUS=pass requires a complete passing Windows matrix');
    }
    if (!manualSoakEvidence || manualSoakStatus !== 'passed') {
        throw new Error(`VCPCHAT_REAL_ELECTRON_STATUS=pass requires manual soak status passed (received ${manualSoakStatus})`);
    }
}
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* source archives may not include git metadata */ }
const graph = readJson('docs/contracts/generated/chat-event-graph.json');
const contracts = readJson('docs/contracts/chat-contracts.json');
const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    commit,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    status: process.env.VCPCHAT_REAL_ELECTRON_STATUS === 'pass' ? 'pass' : 'manual_required',
    checks: {
        contracts: contracts.length,
        generatedEvents: graph.events.length,
        dynamicSites: {
            registered: contracts.filter(contract => contract.dynamic === true).length,
            graphRegistered: graph.registeredDynamic.length,
            undiscovered: graph.undiscovered.length,
        },
        transcriptSnapshots: contracts.filter(contract => contract.kind === 'snapshot').map(contract => contract.snapshot),
        artifactPlane: 'electron-runtime-present',
        realElectronSequence: mainChatEvidence ? (mainChatPass ? 'pass' : 'fail') : 'manual_required',
        realElectronUiApps: uiAppsEvidence ? (uiAppsPass ? 'pass' : 'fail') : 'manual_required',
        windowsMatrix: matrixEvidence ? (matrixPass ? 'pass' : 'fail_or_skipped') : 'manual_required',
        manualSoak: manualSoakEvidence ? manualSoakStatus : 'manual_required',
        packagedArtifact: packagedEvidence ? packagedStatus : 'manual_required',
    },
    commands: [
        'node scripts/check-chat-contracts.mjs',
        'node scripts/run-chat-contract-invariants.mjs',
        'node scripts/test-chat-contract-invalid.mjs',
        'node scripts/test-facade-registry-invalid.mjs',
        'node scripts/test-artifact-plane-invalid.mjs',
        'node scripts/test-packaged-artifact-invalid.mjs',
        'node scripts/check-artifact-plane.mjs',
        'node scripts/test-built-artifact-smoke.mjs',
        'node scripts/test-packaged-artifact-smoke.mjs',
        'node scripts/test-chat-transcript-snapshot.mjs',
    ],
    artifacts: {
        graph: 'docs/contracts/generated/chat-event-graph.json',
        contracts: 'docs/contracts/chat-contracts.json',
        transcript: 'docs/contracts/snapshots/chat-stream.json',
        nativeRuntime: `modules/services/chatDataService/bin/${process.platform}-${process.arch}`,
        electronMainChat: mainChatEvidence?.path || null,
        electronUiApps: uiAppsEvidence?.path || null,
        windowsMatrix: matrixEvidence?.path || null,
        manualSoak: manualSoakEvidence?.path || null,
        packagedArtifact: packagedEvidence?.path || null,
    },
    manualRequired: process.env.VCPCHAT_REAL_ELECTRON_STATUS === 'pass' ? [] : [
        'test-electron-main-chat-sequences',
        'test-electron-ui-apps',
        'packaged Electron runtime launch/crash-reload',
        'cross-Windows/GPU/DPI matrix',
        '30-60 minute manual soak',
    ],
    interpretation: 'This manifest records automated evidence only; manual_required and cross-platform D7 evidence remain separate.',
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Chat evidence manifest written to ${output}`);
