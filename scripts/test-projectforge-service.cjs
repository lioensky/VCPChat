'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function run(program, args, env = process.env) {
    const result = spawnSync(program, args, { cwd: root, env, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
const manifest = path.join(root, 'rust_projectforge_indexer', 'Cargo.toml');
run(cargo, ['test', '--manifest-path', manifest, '--locked']);
run(cargo, ['test', '--manifest-path', manifest, '--locked',
    'validation_process::tests::actual_node_json_validation_is_hash_bound',
    '--', '--ignored', '--exact',
], { ...process.env, PF_VALIDATOR_NODE: process.execPath });
run(cargo, ['build', '--manifest-path', manifest, '--locked']);
const binaryName = process.platform === 'win32' ? 'projectforge_indexer.exe' : 'projectforge_indexer';
const debugBinary = path.join(root, 'rust_projectforge_indexer', 'target', 'debug', binaryName);
run(process.execPath, ['--test',
    'tests/project-forge-service.test.js',
    'tests/project-forge-validation-worker.test.cjs',
    'tests/project-forge.test.js',
    'tests/project-forge-robustness.test.js',
    'tests/project-forge-report-export.test.js',
    'tests/project-forge-export-ipc.test.js',
    'tests/project-forge-event-ipc.test.js',
    'tests/project-forge-ast.test.js',
], {
    ...process.env,
    PF_SERVICE_BINARY: process.env.PF_SERVICE_BINARY || debugBinary,
    PF_SERVICE_REQUIRE_BINARY: '1',
});