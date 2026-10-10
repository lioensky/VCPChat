'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const forge = require('../VCPDistributedServer/Plugin/ProjectForge/ProjectForgeService');
const { resolveDefaultBinaryPath } = require('../VCPDistributedServer/Plugin/ProjectForge/indexerClient');

const HAS_BIN = fs.existsSync(resolveDefaultBinaryPath());
const SKIP_BIN = HAS_BIN ? false : '未找到索引器二进制';
const quiet = { log() {}, warn() {}, error() {} };

let tmp;
let wsRoot;

const call = args => forge.processToolCall(args);

test.before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-rust-macro-exam-'));
    wsRoot = path.join(tmp, 'ws');
    fs.mkdirSync(wsRoot, { recursive: true });
    forge.initialize({
        dbPath: path.join(tmp, 'db', 'pf.db'),
        services: {
            workspaceService: {
                list: () => [{ id: 'ws1', alias: 'demo', path: wsRoot, enabled: true, status: 'ready' }],
                getActiveWorkspaceId: () => 'ws1',
            },
        },
        trash: async abs => fs.rmSync(abs, { force: true }),
        logger: quiet,
    });
});

test.after(async () => {
    await forge.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('Rust 宏调用与 FFI 导出符号提取：20题全域极限夹逼大考', { skip: SKIP_BIN }, async () => {
    const prj = await call({ command: 'CreateProject', name: 'rust_macro_20_exam', dir: 'rust_macro_20_exam' });
    const pid = prj.details.project.id;

    // 构造涵盖 20 个边界考点的超密集 Rust 测试源文件
    const rustSource = [
        '// =================== [考点 1-5: 经典负例与流行业务宏（必须 0 误报）] ===================',
        'fn test_business_macros() {',
        '    // 题 1: rusqlite::params! 参数误报',
        '    let p1 = rusqlite::params![db_id, user_name, user_age];',
        '    // 题 2: 链式方法与闭包内的宏调用与标识符',
        '    let list: Vec<_> = items.iter().map(|item| item.clone()).collect();',
        '    // 题 3: tokio::select! 内部控制流与分支模式匹配标识符',
        '    tokio::select! {',
        '        val = rx.recv() => { handle_val(val); }',
        '        _ = timeout => { on_timeout(); }',
        '    };',
        '    // 题 4: serde_json::json! 复杂嵌套键值对与宏结构',
        '    let payload = serde_json::json!({ "id": req_id, "status": "ok", "tags": [tag1, tag2] });',
        '    // 题 5: tracing/log 格式化宏与命名参数',
        '    tracing::info!(target: "net", bytes_sent = 1024, "packet dispatched to client");',
        '}',
        '',
        '// =================== [考点 6-8: 基础自证明宏正例（必须 100% 精准识别）] ===================',
        '// 题 6: 单标识符直接导出宏',
        'macro_rules! export_kernel_api {',
        '    ($fn_name:ident) => {',
        '        #[no_mangle]',
        '        pub extern "C" fn $fn_name() -> i32 { 0 }',
        '    };',
        '}',
        'export_kernel_api!(vcp_kernel_init);',
        '',
        '// 题 7: 多标识符同时导出宏',
        'macro_rules! export_dual_api {',
        '    ($entry:ident, $exit:ident) => {',
        '        #[no_mangle] pub extern "C" fn $entry() {}',
        '        #[no_mangle] pub extern "C" fn $exit() {}',
        '    };',
        '}',
        'export_dual_api!(vcp_driver_attach, vcp_driver_detach);',
        '',
        '// 题 8: 带有其他 ABI 签名的导出宏（如 extern "system" Win32 接口）',
        'macro_rules! export_sys_abi {',
        '    ($hook:ident) => {',
        '        #[no_mangle]',
        '        pub extern "system" fn $hook() -> u32 { 1 }',
        '    };',
        '}',
        'export_sys_abi!(vcp_win32_hook);',
        '',
        '// =================== [考点 9-11: 路径限定与调用形式夹逼（深水边界）] ===================',
        '// 题 9: 宏名称以 crate:: 前缀限定调用',
        'crate::export_kernel_api!(vcp_scoped_crate_api);',
        '',
        '// 题 10: 宏名称以 self:: 前缀限定调用',
        'self::export_kernel_api!(vcp_scoped_self_api);',
        '',
        '// 题 11: 宏使用大括号 {} 与方括号 [] 包裹语法',
        'export_kernel_api! { vcp_braced_kernel_api }',
        'export_kernel_api![ vcp_bracketed_kernel_api ];',
        '',
        '// =================== [考点 12-14: 宏内嵌套与复合结构夹逼] ===================',
        '// 题 12: 宏内部包含类型注解或复合模式',
        'macro_rules! export_typed_api {',
        '    ($name:ident : $ret:ty) => {',
        '        #[no_mangle]',
        '        pub extern "C" fn $name() -> $ret { 0 }',
        '    };',
        '}',
        'export_typed_api!(vcp_typed_getter : i32);',
        '',
        '// 题 13: 单一调用中带有多个虚参数，仅 ident 提取，关键字被安全过滤',
        'macro_rules! export_with_flags {',
        '    (pub extern fn $name:ident) => {',
        '        #[no_mangle]',
        '        pub extern "C" fn $name() {}',
        '    };',
        '}',
        'export_with_flags!(pub extern fn vcp_flagged_entry);',
        '',
        '// 题 14: 带有 export_name = "..." 字符串属性的宏',
        'macro_rules! export_custom_symbol {',
        '    ($sym:ident) => {',
        '        #[export_name = "vcp_custom_alias"]',
        '        pub extern "C" fn $sym() {}',
        '    };',
        '}',
        'export_custom_symbol!(vcp_original_sym);',
        '',
        '// =================== [考点 15-18: 伪导出特征防御与作用域隔离（极限防穿透）] ===================',
        '// 题 15: 宏注释中带有 no_mangle，但定义体内部实际无导出语义（纯假假象）',
        'macro_rules! fake_comment_macro {',
        '    // 注意：这里曾经打算使用 no_mangle 和 extern "C"，但后来弃用了',
        '    ($name:ident) => {',
        '        fn $name() {}',
        '    };',
        '}',
        'fake_comment_macro!(vcp_fake_not_exported);',
        '',
        '// 题 16: 宏内部的字符串字面量包含 "no_mangle"，非代码属性',
        'macro_rules! log_mangle_status {',
        '    ($msg:ident) => {',
        '        println!("checking no_mangle status for {}", stringify!($msg));',
        '    };',
        '}',
        'log_mangle_status!(vcp_dummy_log_param);',
        '',
        '// 题 17: 同名局部变量遮蔽宏（Shadowing）与宏参数名冲突',
        'fn shadow_test() {',
        '    let export_kernel_api = 100;',
        '    let dummy = export_kernel_api + 1;',
        '}',
        '',
        '// 题 18: 空宏与无参数宏调用安全防崩溃',
        'macro_rules! empty_noop_macro {',
        '    () => {};',
        '}',
        'empty_noop_macro!();',
        '',
        '// =================== [考点 19-20: 宏与原生声明并存及行号对齐] ===================',
        '// 题 19: 原生未通过宏的直接 FFI 导出符号',
        '#[no_mangle]',
        'pub extern "C" fn vcp_native_direct_export() -> i32 { 42 }',
        '',
        '// 题 20: 带有属性宏标记的普通业务函数（如 #[tokio::main] 或 #[test]）',
        '#[tokio::main]',
        'async fn async_service_start() {',
        '    println!("service started");',
        '}',
    ].join('\n');

    await call({
        command: 'CreateFile',
        projectId: pid,
        path: 'src/lib.rs',
        reason: '构建 Rust 宏 FFI 导出符号提取 20 题全域考卷',
        content: rustSource,
    });

    // 触发 Trace 全息分析
    const traceRes = await call({
        command: 'Trace',
        projectId: pid,
        target: 'file:src/lib.rs',
    });

    const outputText = traceRes.content.map(c => c.text).join('\n');

    // 软断言收集器：过筛全部 20 道考题
    const report = [];
    const assertItem = (seq, title, passed, detail) => {
        report.push({ seq, title, passed, detail });
    };

    // 正向预期集合（应被成功提取为 FFI 导出符号）
    const expectedExports = [
        'vcp_kernel_init',           // 题 6
        'vcp_driver_attach',         // 题 7
        'vcp_driver_detach',         // 题 7
        'vcp_win32_hook',            // 题 8
        'vcp_scoped_crate_api',      // 题 9
        'vcp_scoped_self_api',       // 题 10
        'vcp_braced_kernel_api',     // 题 11
        'vcp_bracketed_kernel_api',  // 题 11
        'vcp_typed_getter',          // 题 12
        'vcp_flagged_entry',         // 题 13
        'vcp_original_sym',          // 题 14
        'vcp_native_direct_export',  // 题 19
    ];
    // 题 1-5 负向拦截断言
    assertItem(1, 'rusqlite::params! 参数拦截', !['db_id', 'user_name', 'user_age'].some(s => outputText.includes(`· ${s}`)), '禁止参数作为导出符号');
    assertItem(2, 'iter / collect 链式表达式标识符拦截', !['items', 'item', 'iter', 'collect'].some(s => outputText.includes(`· ${s}`)), '禁止链式调用标识符');
    assertItem(3, 'tokio::select! 控制流标识符拦截', !['rx', 'val', 'timeout', 'handle_val'].some(s => outputText.includes(`· ${s}`)), '禁止事件分支标识符');
    assertItem(4, 'serde_json::json! 嵌套字面量参数拦截', !['req_id', 'tag1', 'tag2'].some(s => outputText.includes(`· ${s}`)), '禁止 JSON 键值变量');
    assertItem(5, 'tracing/log 命名参数拦截', !outputText.includes('· bytes_sent'), '禁止日志命名参数');
    // 题 6-8 正向断言
    assertItem(6, '基础单标识符导出宏识别', outputText.includes('vcp_kernel_init'), 'vcp_kernel_init 必须被提取');
    assertItem(7, '多标识符并行导出宏识别', outputText.includes('vcp_driver_attach') && outputText.includes('vcp_driver_detach'), 'attach/detach 双符号必须提取');
    assertItem(8, 'extern "system" ABI 宏导出识别', outputText.includes('vcp_win32_hook'), 'Win32 system ABI 符号提取');

    // 题 9-11 作用域限定与分隔符断言
    assertItem(9, 'crate:: 路径限定宏调用识别', outputText.includes('vcp_scoped_crate_api'), 'crate:: 路径宏导出符号识别');
    assertItem(10, 'self:: 路径限定宏调用识别', outputText.includes('vcp_scoped_self_api'), 'self:: 路径宏导出符号识别');
    assertItem(11, '大括号 {} 与方括号 [] 宏调用语法支持', outputText.includes('vcp_braced_kernel_api') && outputText.includes('vcp_bracketed_kernel_api'), 'brace/bracket 宏语法识别');

    // 题 12-14 复合结构与修饰符断言
    assertItem(12, '带类型注解宏提取（过滤纯类型符号）', outputText.includes('vcp_typed_getter') && !outputText.includes('· i32'), '函数名提取且排除类型');
    assertItem(13, '虚参数宏提取（排除 pub/extern/fn 关键字）', outputText.includes('vcp_flagged_entry'), '参数符号提取且排除关键字');
    assertItem(14, 'export_name 宏提取', outputText.includes('vcp_original_sym'), 'export_name 属性宏识别');

    // 题 15-18 伪装防御断言
    assertItem(15, '注释中的 no_mangle 伪装宏拦截', !outputText.includes('vcp_fake_not_exported'), '注释不应激活白名单');
    assertItem(16, '字符串字面量中的 no_mangle 伪装拦截', !outputText.includes('vcp_dummy_log_param'), '字符串文本不应激活白名单');
    assertItem(17, '同名局部变量遮蔽宏防御', !outputText.includes('· dummy'), '普通变量赋值不应被混淆');
    assertItem(18, '空参数宏防御不崩溃', true, '无参数宏未引发 Parser 异常');

    // 题 19-20 原生与属性宏对齐
    assertItem(19, '原生 no_mangle 函数符号共存', outputText.includes('vcp_native_direct_export'), '原生 FFI 符号不受干扰');
    assertItem(20, '无 FFI 导出的普通属性宏函数拦截', !outputText.includes('async_service_start'), '业务异步函数不入 FFI 导出表');

    const passCount = report.filter(r => r.passed).length;
    console.log(`\n========================================`);
    console.log(`Rust 宏与 FFI 导出 20 题全域大考得分: ${passCount} / 20 (${(passCount / 20 * 100).toFixed(1)}%)`);
    report.forEach(r => {
        console.log(`[${r.passed ? 'PASS' : 'FAIL'}] 题 ${r.seq}: ${r.title} (${r.detail})`);
    });
    console.log(`========================================\n`);

    assert.equal(passCount, 20, `20 题大考必须 100% 满分全绿，当前通过 ${passCount} 题`);
});