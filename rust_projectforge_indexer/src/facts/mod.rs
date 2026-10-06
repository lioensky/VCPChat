pub mod c_cpp;
pub mod csharp_lua;
pub mod go;
pub mod java;
pub mod js_html;
pub mod python;
pub mod rust_lang;
pub mod types;

use tree_sitter::Parser;

pub use js_html::{html_facts, js_facts};
pub use types::{FileFacts, DEFAULT_BRIDGE_GLOBALS};

use crate::lang::{Family, Lang};
use crate::symbols::{normalize_source, parse};

/// 全语言链路事实提取总入口（微内核正交调度）
pub fn extract_facts(
    lang: Lang,
    raw: &str,
    parser: &mut Parser,
    bridge: &[String],
    file_path: Option<&std::path::Path>,
) -> Result<FileFacts, String> {
    if lang.family() == Family::Js {
        return js_facts(lang, raw, parser, bridge);
    }
    let source = normalize_source(raw);
    let tree = parse(lang, &source, parser)?;
    let root = tree.root_node();
    let mut facts = FileFacts {
        kind: lang.name(),
        has_error: root.has_error(),
        ..Default::default()
    };

    match lang.family() {
        Family::C | Family::Cpp => {
            c_cpp::extract_c_cpp_facts(lang, &source, root, &mut facts, file_path);
        }
        Family::Go => {
            go::extract_go_facts(&source, root, &mut facts);
        }
        Family::Rust => {
            rust_lang::extract_rust_facts(&source, root, &mut facts);
        }
        Family::Java => {
            java::extract_java_facts(&source, root, &mut facts);
        }
        Family::CSharp => {
            csharp_lua::extract_csharp_facts(&source, root, &mut facts);
        }
        Family::Python => {
            python::extract_python_facts(&source, root, &mut facts);
        }
        Family::Lua => {
            csharp_lua::extract_lua_facts(&source, root, &mut facts);
        }
        Family::Js => unreachable!(),
    }

    Ok(facts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::types::IpcFact;

    fn bridge() -> Vec<String> {
        DEFAULT_BRIDGE_GLOBALS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    fn ipc<'f>(f: &'f FileFacts, side: &str) -> Vec<&'f IpcFact> {
        f.ipc.iter().filter(|i| i.side == side).collect()
    }

    #[test]
    fn js_ipc_modules_bridge_and_globals() {
        let src = "const { ipcMain } = require('electron');
const helper = require('./helper');
import x from '../x.js';
const CHANNELS = Object.freeze({ READY: 'window-ready' });
function register(win) {
    ipcMain.handle('save-settings', async () => 1);
    ipcMain.on(CHANNELS.READY, () => {});
    ipcMain.handle(`tpl-ch`, () => {});
    ipcMain.handle(dyn, () => {});
    win.webContents.send('settings-changed', 1);
}
async function renderer(ch) {
    await window.chatAPI.saveSettings({});
    electronAPI.onThemeUpdated(() => {});
    window.messageRenderer = { init() {} };
    window.messageRenderer.init();
    ipcRenderer.invoke(ch);
    const m = await import('./lazy.js');
}
contextBridge.exposeInMainWorld('myAPI', { a: 1, b() {}, c });
";
        let mut p = Parser::new();
        let f = js_facts(Lang::JavaScript, src, &mut p, &bridge()).unwrap();
        assert_eq!(
            f.requires.iter().map(|r| r.spec.as_str()).collect::<Vec<_>>(),
            ["electron", "./helper"]
        );
        assert_eq!(f.imports.len(), 2);
        assert!(f.imports.iter().any(|i| i.spec == "./lazy.js" && i.dynamic));

        let reg = ipc(&f, "register");
        assert_eq!(reg.len(), 4);
        assert_eq!(
            (reg[0].channel.as_deref(), reg[0].via, reg[0].line),
            (Some("save-settings"), "literal", 6)
        );
        assert_eq!(reg[0].symbol.as_deref(), Some("register"));
        assert_eq!(
            (reg[1].channel.as_deref(), reg[1].via, reg[1].expr.as_deref()),
            (Some("window-ready"), "const", Some("CHANNELS.READY"))
        );
        assert_eq!(reg[2].channel.as_deref(), Some("tpl-ch"));
        assert_eq!((reg[3].channel.as_deref(), reg[3].via), (None, "dynamic"));
        let push = ipc(&f, "push");
        assert_eq!(
            (push[0].channel.as_deref(), push[0].line),
            (Some("settings-changed"), 10)
        );
        let call = ipc(&f, "call");
        assert_eq!(
            (call[0].via, call[0].expr.as_deref()),
            ("dynamic", Some("ch"))
        );

        let names: Vec<_> = f
            .bridge
            .iter()
            .map(|b| (b.object.as_str(), b.name.as_str()))
            .collect();
        assert_eq!(
            names,
            [("chatAPI", "saveSettings"), ("electronAPI", "onThemeUpdated")]
        );
        assert!(f
            .globals_defined
            .iter()
            .any(|g| g.name == "messageRenderer" && g.how == "window" && g.line == 15));
        assert!(f
            .globals_defined
            .iter()
            .any(|g| g.name == "register" && g.how == "function"));
        assert!(f
            .globals_defined
            .iter()
            .any(|g| g.name == "CHANNELS" && g.how == "const"));
        assert_eq!(
            f.globals_used
                .iter()
                .map(|g| (g.name.as_str(), g.line))
                .collect::<Vec<_>>(),
            [("messageRenderer", 16)]
        );
        assert_eq!(f.exposes[0].name, "myAPI");
        assert_eq!(f.exposes[0].keys, ["a", "b", "c"]);
    }

    #[test]
    fn bridge_aliases_and_forwarding_wrappers() {
        let src = "const api = window.utilityAPI || window.electronAPI;
const electronAPI = window.chatAPI;
const result = chatAPI.watcherBegin;
function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => fn(...args));
}
const sendTo = (win, ch, data) => win.webContents.send(ch, data);
function register() {
    handle('git:status', () => 1);
    sendTo(win, 'git:changed', 1);
    handle(someVar, () => 1);
}
api.projectForgeListProjects({});
electronAPI.saveSettings();
result.x;
";
        let mut p = Parser::new();
        let f = js_facts(Lang::JavaScript, src, &mut p, &bridge()).unwrap();
        assert_eq!(
            f.bridge_aliases
                .iter()
                .map(|a| (a.name.as_str(), a.object.as_str(), a.top_level))
                .collect::<Vec<_>>(),
            [
                ("api", "utilityAPI", true),
                ("electronAPI", "chatAPI", true)
            ]
        );
        let b: Vec<_> = f
            .bridge
            .iter()
            .map(|b| (b.object.as_str(), b.alias.as_deref(), b.name.as_str()))
            .collect();
        assert_eq!(
            b,
            [
                ("chatAPI", None, "watcherBegin"),
                ("utilityAPI", Some("api"), "projectForgeListProjects"),
                ("chatAPI", Some("electronAPI"), "saveSettings"),
            ]
        );
        let reg = ipc(&f, "register");
        assert_eq!(
            reg.iter()
                .map(|i| (i.channel.as_deref(), i.via))
                .collect::<Vec<_>>(),
            [
                (None, "param"),
                (Some("git:status"), "wrapper"),
                (None, "dynamic"),
            ]
        );
        assert_eq!(
            (reg[1].line, reg[1].method.as_str(), reg[1].symbol.as_deref()),
            (9, "handle", Some("register"))
        );
        let push = ipc(&f, "push");
        assert!(push
            .iter()
            .any(|i| i.channel.as_deref() == Some("git:changed")
                && i.via == "wrapper"
                && i.line == 10));
    }

    #[test]
    fn html_scripts_in_order_with_inline_facts() {
        let src = "\u{feff}<!doctype html>\r\n<html><head>\r\n<!-- <script src=\"old.js\"></script> -->\r\n<script src=\"a.js\"></script>\r\n<script type=\"module\" src='./b.mjs' defer></script>\r\n<script>\r\n  window.inlineGlobal = 1;\r\n  chatAPI.ping();\r\n</script>\r\n<script type=\"text/template\"><div></div></script>\r\n<SCRIPT SRC=c.js></SCRIPT>\r\n</head></html>\r\n";
        let mut p = Parser::new();
        let f = html_facts(src, &mut p, &bridge());
        let order: Vec<_> = f
            .scripts
            .iter()
            .map(|s| (s.src.as_deref(), s.module, s.inline, s.line))
            .collect();
        assert_eq!(
            order,
            [
                (Some("a.js"), false, false, 4),
                (Some("./b.mjs"), true, false, 5),
                (None, false, true, 6),
                (Some("c.js"), false, false, 11),
            ]
        );
        assert_eq!(f.globals_defined[0].name, "inlineGlobal");
        assert_eq!(f.globals_defined[0].line, 7);
        assert_eq!((f.bridge[0].name.as_str(), f.bridge[0].line), ("ping", 8));
    }

    #[test]
    fn multilang_dependencies_and_ffi_exports() {
        let mut p = Parser::new();

        let cpp_src = "#include <vector>\n#include \"my_math.h\"\nextern \"C\" void native_compute(int x);\nNODE_API_MODULE(vcp_addon, Init)\n";
        let cpp_facts = extract_facts(Lang::Cpp, cpp_src, &mut p, &[], None).unwrap();
        assert_eq!(cpp_facts.imports.len(), 2);
        assert_eq!(cpp_facts.imports[0].spec, "<vector>");
        assert_eq!(cpp_facts.imports[1].spec, "my_math.h");
        assert_eq!(cpp_facts.ffi_exports.len(), 2);
        assert_eq!(cpp_facts.ffi_exports[0].name, "native_compute");
        assert_eq!(cpp_facts.ffi_exports[1].name, "vcp_addon");
        assert_eq!(cpp_facts.ffi_exports[1].lang, "napi");

        let export_src = r#"
extern "C" VCP_EXPORT int VCP_CALL vcp_core_engine_init(const char* config_path);
extern "C" VCP_EXPORT void* (VCP_CALL *get_engine_proc(int id))(void);
extern "C" void plain_export_function(int code);
extern "C" {
    void engine_step_a(void), engine_step_b(int code), engine_step_c(float dt);
}
"#;
        let export_facts = extract_facts(Lang::Cpp, export_src, &mut p, &[], None).unwrap();
        let export_names: Vec<&str> = export_facts
            .ffi_exports
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert!(export_names.contains(&"vcp_core_engine_init"));
        assert!(export_names.contains(&"get_engine_proc"));
        assert!(export_names.contains(&"plain_export_function"));
        assert!(export_names.contains(&"engine_step_a"));
        assert!(export_names.contains(&"engine_step_b"));
        assert!(export_names.contains(&"engine_step_c"));

        let go_src = "package main\nimport \"net/http\"\nimport \"./internal/handler\"\n";
        let go_facts = extract_facts(Lang::Go, go_src, &mut p, &[], None).unwrap();
        assert_eq!(go_facts.imports.len(), 2);
        assert_eq!(go_facts.imports[0].spec, "net/http");
        assert_eq!(go_facts.imports[1].spec, "./internal/handler");

        let rs_src = r#"
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use crate::pipeline::{executor, runner};
#[no_mangle]
pub extern "C" fn vcp_audio_process() -> i32 { 0 }
"#;
        let rs_facts = extract_facts(Lang::Rust, rs_src, &mut p, &[], None).unwrap();
        let rs_specs: Vec<&str> = rs_facts.imports.iter().map(|i| i.spec.as_str()).collect();
        assert!(rs_specs.contains(&"std::sync::Arc"));
        assert!(rs_specs.contains(&"std::sync::atomic::AtomicBool"));
        assert!(rs_specs.contains(&"std::sync::atomic::Ordering"));
        assert!(rs_specs.contains(&"crate::pipeline::executor"));
        assert!(rs_specs.contains(&"crate::pipeline::runner"));
        assert_eq!(rs_facts.ffi_exports.len(), 1);
        assert_eq!(rs_facts.ffi_exports[0].name, "vcp_audio_process");

        let typedef_src = r#"
extern "C" {
    typedef void (*engine_event_callback)(int event_id, void* user_data);
    void register_engine_listener(engine_event_callback cb);
    struct VcpApiTable {
        int (*init)(void);
    };
}
"#;
        let typedef_facts = extract_facts(Lang::Cpp, typedef_src, &mut p, &[], None).unwrap();
        let exp_names: Vec<&str> = typedef_facts
            .ffi_exports
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(exp_names, ["register_engine_listener"]);

        let java_src = "package com.vcp;\nimport java.util.List;\nimport com.vcp.util.Helper;\npublic class B extends A implements I {}\n";
        let java_facts = extract_facts(Lang::Java, java_src, &mut p, &[], None).unwrap();
        let java_specs: Vec<&str> = java_facts.imports.iter().map(|i| i.spec.as_str()).collect();
        assert!(java_specs.contains(&"A"), "java_specs was: {:?}", java_specs);
        assert!(java_specs.contains(&"I"), "java_specs was: {:?}", java_specs);
        let mod_info_src = "module com.vcp.core {\n    requires transitive com.vcp.util;\n    requires java.base;\n    exports com.vcp.core;\n}";
        let mod_facts = extract_facts(Lang::Java, mod_info_src, &mut p, &[], None).unwrap();
        assert!(mod_facts
            .imports
            .iter()
            .any(|i| i.spec == "com.vcp.util"));

        let rust_macro_src = "macro_rules! export_plugin { ($name:ident) => { #[no_mangle] pub extern \"C\" fn $name() {} }; }\nexport_plugin!(macro_generated_ffi_kernel);\n";
        let rust_macro_facts = extract_facts(Lang::Rust, rust_macro_src, &mut p, &[], None).unwrap();
        assert!(rust_macro_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "macro_generated_ffi_kernel"));

        let x_macro_src = "#define VCP_COMMAND_TABLE(X) \\\n    X(audio_play, int c) \\\n    X(audio_stop, int c)\n#define DECLARE_EXTERN_C(name, ...) extern \"C\" void vcp_cmd_##name(__VA_ARGS__);\nVCP_COMMAND_TABLE(DECLARE_EXTERN_C)\n";
        let x_macro_facts = extract_facts(Lang::Cpp, x_macro_src, &mut p, &[], None).unwrap();
        assert!(x_macro_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "vcp_cmd_audio_play"));

        let cgo_src = "package main\n/*\n#include <stdlib.h>\nextern void cgo_callback_bridge(int code);\n*/\nimport \"C\"\n";
        let cgo_facts = extract_facts(Lang::Go, cgo_src, &mut p, &[], None).unwrap();
        assert!(cgo_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "cgo_callback_bridge"));
        assert!(cgo_facts.imports.iter().any(|i| i.spec == "<stdlib.h>"));

        let coro_deep_src = "extern \"C\" {\n    [[nodiscard, gnu::always_inline]] extern \"C\" auto deep_nodiscard_bridge(void* ptr) noexcept -> void*;\n}\n";
        let coro_deep_facts = extract_facts(Lang::Cpp, coro_deep_src, &mut p, &[], None).unwrap();
        assert!(coro_deep_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "deep_nodiscard_bridge"));

        let rust_abi_src = "#[no_mangle]\npub extern \"system\" fn vcp_win32_system_dispatch(hwnd: usize) -> isize { 0 }\npub extern \"win64\" fn vcp_x64_fast_kernel(id: u64) -> u64 { id }\n";
        let rust_abi_facts = extract_facts(Lang::Rust, rust_abi_src, &mut p, &[], None).unwrap();
        assert!(rust_abi_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "vcp_win32_system_dispatch"));
        assert!(rust_abi_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "vcp_x64_fast_kernel"));

        let cpp_tpl_src = "template<> struct NativeBridgeRegistry<int> { extern \"C\" static void specialized_native_entry_i32(int payload) {} };\n";
        let cpp_tpl_facts = extract_facts(Lang::Cpp, cpp_tpl_src, &mut p, &[], None).unwrap();
        assert!(cpp_tpl_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "specialized_native_entry_i32"));

        let go_asm_src = "package main\n//go:noescape\nfunc vcp_avx512_vector_matmul(a, b, c uintptr, n int)\n";
        let go_asm_facts = extract_facts(Lang::Go, go_asm_src, &mut p, &[], None).unwrap();
        assert!(go_asm_facts
            .ffi_exports
            .iter()
            .any(|e| e.name == "vcp_avx512_vector_matmul"));

        let java_sealed_src = "public sealed interface PluginRegistry permits DefaultPlugin, AdvancedPlugin {}\n";
        let java_sealed_facts = extract_facts(Lang::Java, java_sealed_src, &mut p, &[], None).unwrap();
        assert!(java_sealed_facts
            .imports
            .iter()
            .any(|i| i.spec == "DefaultPlugin"));
        assert!(java_sealed_facts
            .imports
            .iter()
            .any(|i| i.spec == "AdvancedPlugin"));

        let py_src =
            "import os, sys\nfrom .services import chat\nfrom ..core.util import helper\n";
        let py_facts = extract_facts(Lang::Python, py_src, &mut p, &[], None).unwrap();
        let py_specs: Vec<&str> = py_facts.imports.iter().map(|i| i.spec.as_str()).collect();
        assert!(py_specs.contains(&"os"));
        assert!(py_specs.contains(&"sys"));
        assert!(py_specs.contains(&".services"));
        assert!(py_specs.contains(&"..core.util"));
    }

    #[test]
    fn test_cpp_nested_macro_invoke_ffi() {
        let mut p = Parser::new();
        let src = "#define DECLARE_SYS_KERNEL(name) extern \"C\" void vcp_sys_##name(int code);\n#define VCP_INVOKE(m) m\nVCP_INVOKE(DECLARE_SYS_KERNEL(task_alpha))\n";
        let facts = extract_facts(Lang::Cpp, src, &mut p, &[], None).unwrap();
        let names: Vec<&str> = facts.ffi_exports.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"vcp_sys_task_alpha"),
            "未能提取嵌套实参宏展开符号: {:?}",
            names
        );
    }
}