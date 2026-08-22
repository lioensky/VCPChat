import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = path.join(root, 'apps', 'bootstrap-installer');

test('standalone installer preserves Hermes MIT attribution and native identity', () => {
    const license = fs.readFileSync(path.join(installer, 'LICENSE-HERMES'), 'utf8');
    const notices = fs.readFileSync(path.join(installer, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(installer, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    assert.match(license, /MIT License/);
    assert.match(license, /Nous Research/);
    assert.match(notices, /Hermes Agent/);
    assert.equal(config.identifier, 'com.vcpchat.setup');
    assert.equal(config.productName, 'VCPChat Setup');
    assert.deepEqual(config.bundle.targets, ['app']);
});

test('installer lifecycle has one owner, cancellation, and terminal event seams', () => {
    const source = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const processOwner = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'process.rs'), 'utf8');
    assert.match(source, /struct AppState/);
    assert.match(source, /AtomicBool/);
    assert.match(source, /active_child: process::ActiveChild/);
    assert.match(source, /fn cancel_installer/);
    assert.match(source, /process::cancel\(&state\.active_child\)/);
    assert.match(source, /CloseRequested/);
    assert.match(source, /api\.prevent_close\(\)/);
    assert.match(source, /slot\.is_none\(\)/);
    assert.match(processOwner, /taskkill\.exe/);
    assert.match(processOwner, /format!\("-\{pid\}"\)/);
    assert.doesNotMatch(processOwner, /\.join\(\)/);
    for (const event of ['Manifest', 'Stage', 'Log', 'Complete', 'Failed']) {
        assert.match(source, new RegExp(`\\b${event}\\b`));
    }
    assert.doesNotMatch(source, /require\(['"]electron['"]\)/);
});

test('installer UI exposes explainable progress and recoverable terminal states', () => {
    const readInstaller = relative => fs.readFileSync(path.join(installer, relative), 'utf8');
    const rust = readInstaller('src-tauri/src/lib.rs');
    const app = readInstaller('src/app.tsx');
    const store = readInstaller('src/store.ts');
    const styles = readInstaller('src/styles.css');
    const theme = readInstaller('src/theme.ts');

    assert.match(rust, /struct StageInfo/);
    assert.match(rust, /duration_ms: Option<u64>/);
    assert.match(rust, /Cancelled/);
    assert.match(rust, /fn open_log_directory/);
    assert.match(store, /'cancelled'/);
    assert.match(store, /computed\(\$stages/);
    assert.match(app, /aria-valuenow=\{percent\}/);
    assert.match(app, /打开诊断记录/);
    assert.match(app, /正在安全停止/);
    assert.doesNotMatch(app, /检查更新状态/);
    assert.match(theme, /onThemeChanged/);
    assert.match(styles, /prefers-reduced-motion/);
});

test('update dirty state offers named stash strategy and preserves a recoverable OID', () => {
    const rust = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    const source = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'source.rs'), 'utf8');
    const app = fs.readFileSync(path.join(installer, 'src', 'app.tsx'), 'utf8');
    const store = fs.readFileSync(path.join(installer, 'src', 'store.ts'), 'utf8');
    assert.match(rust, /--include-untracked/);
    assert.match(rust, /vcpchat-installer\//);
    assert.match(rust, /refs\/stash/);
    assert.match(rust, /stash.*apply.*--index/);
    assert.match(rust, /stash.*drop/);
    assert.match(rust, /merge.*--ff-only/);
    assert.match(rust, /run_git_cleanup/);
    assert.match(rust, /git stash apply --index \{oid\}/);
    assert.match(rust, /本地修改仍安全保存在 stash/);
    assert.match(source, /pub changes: Vec<String>/);
    assert.match(app, /更新到最新版本/);
    assert.match(app, /查看修改/);
    assert.match(app, /跳过更新，启动当前版本/);
    assert.match(app, /manualStashRecovery/);
    assert.match(store, /startInstall\(strategy\?: 'stash'\)/);
});

test('installer fails closed without source and waits for managed ready handoff', () => {
    const source = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(source, /无源码 payload 下载、发布和回滚尚未完成/);
    assert.match(source, /async fn launch_vcpchat/);
    assert.match(source, /spawn_blocking/);
    assert.match(source, /let status = tauri::async_runtime::spawn_blocking/);
    assert.match(source, /ready handoff 失败/);
});

test('Electron startup progress is presentation-only and final success follows managed ready', () => {
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const launcher = fs.readFileSync(path.join(root, 'scripts', 'vcpchat-dev-launcher.mjs'), 'utf8');
    assert.match(main, /VCP_STARTUP:/);
    assert.match(main, /reportLauncherProgress\('renderer-ready', 1/);
    assert.match(main, /publishManagedBootstrapReady\(\{[\s\S]{0,220}mainWindow: 'visible',[\s\S]{0,220}renderer: 'ready',[\s\S]{0,160}reportLauncherProgress/);
    assert.match(launcher, /VCP_LAUNCHER_PROTOCOL: '1'/);
});

test('installer uses source-first revision diagnostics without automatic git pull', () => {
    const source = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'source.rs'), 'utf8');
    const rust = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    for (const field of ['commit', 'tree_hash', 'package_lock_hash', 'electron_version', 'dirty']) assert.match(source, new RegExp(field));
    assert.match(rust, /locate-source/);
    assert.match(rust, /inspect-git/);
    assert.doesNotMatch(rust, /git pull/);
    assert.match(source, /--source-root/);
});

test('source launchers pass the repository root to the native installer', () => {
    const mac = fs.readFileSync(path.join(root, 'launchers', 'VCPChat-Launcher.command'), 'utf8');
    const linux = fs.readFileSync(path.join(root, 'launchers', 'VCPChat-Launcher.sh'), 'utf8');
    const windows = fs.readFileSync(path.join(root, 'launchers', 'VCPChat-Launcher.vbs'), 'utf8');
    assert.match(mac, /--source-root/);
    assert.match(linux, /--source-root/);
    assert.match(windows, /--source-root/);
});

test('installer CI selects platform bundles and tracks reproducible locks', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'vcpchat-installer.yml'), 'utf8');
    assert.match(workflow, /tauri:build -- --bundles "\$\{\{ matrix\.targets \}\}" --ci/);
    assert.doesNotMatch(workflow, /VCPCHAT_INSTALLER_TARGETS/);
    assert.equal(fs.existsSync(path.join(installer, 'package.json')), true);
    assert.equal(fs.existsSync(path.join(installer, 'package-lock.json')), true);
    assert.equal(fs.existsSync(path.join(installer, 'src-tauri', 'Cargo.lock')), true);
});

test('installer repair uses the Electron rebuild separator and final Doctor gate', () => {
    const manifest = fs.readFileSync(path.join(root, 'modules', 'bootstrap', 'repair-manifest.js'), 'utf8');
    const rust = fs.readFileSync(path.join(installer, 'src-tauri', 'src', 'lib.rs'), 'utf8');
    assert.match(manifest, /@electron.*rebuild.*lib.*cli\.js/);
    assert.match(rust, /run_final_doctor/);
    assert.match(rust, /"--include-rust"\.into\(\)/);
    assert.match(rust, /scripts\/vcpchat\.mjs/);
    assert.match(rust, /VCPCHAT_APP_DATA_DIR/);
    const doctor = fs.readFileSync(path.join(root, 'modules', 'bootstrap', 'environment-doctor.js'), 'utf8');
    assert.match(doctor, /new Database\(':memory:'\)/);
    assert.match(doctor, /sharp\(\{ create:/);
});

test('installer-owned native runtime does not make a repaired source tree dirty', () => {
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /^modules\/services\/chatDataService\/bin\/\*\*$/m);
    assert.match(gitignore, /^!modules\/services\/chatDataService\/bin\/README\.md$/m);
    assert.match(gitignore, /^audio_engine\/bin\/\*\*$/m);
});

test('audio runtime is built and selected per platform instead of executing a foreign legacy binary', () => {
    const cargo = fs.readFileSync(path.join(root, 'rust_audio_engine', 'Cargo.toml'), 'utf8');
    const build = fs.readFileSync(path.join(root, 'rust_audio_engine', 'build-runtime.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.match(cargo, /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*wasapi/);
    assert.match(build, /runtimeDirectoryName: `\$\{platform\}-\$\{architecture\}`/);
    assert.match(main, /audio_engine[\s\S]*platformDirectory[\s\S]*platformBinaryPath/);
});

test('installer has a documented root-level development entry', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(packageJson.scripts['installer:dev'], 'npm --prefix apps/bootstrap-installer run tauri:dev');
    assert.equal(packageJson.scripts['installer:build'], 'npm --prefix apps/bootstrap-installer run tauri:build');
    assert.match(fs.readFileSync(path.join(installer, 'README.md'), 'utf8'), /standalone Tauri installer/);
});

test('commercial delivery matrix names all platform bundle evidence without claiming signing', () => {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'vcpchat-installer.yml'), 'utf8');
    for (const target of ['macos-14', 'windows-2022', 'ubuntu-22.04', 'app,dmg', 'appimage', 'installer:portable']) {
        assert.match(workflow, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.doesNotMatch(workflow, /nsis,msi/);
    assert.match(workflow, /unsigned bundle evidence/);
    assert.match(workflow, /not a signed release/);
});
