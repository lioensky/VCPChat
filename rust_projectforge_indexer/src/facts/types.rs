use serde::Serialize;
use tree_sitter::Node;

pub const DEFAULT_BRIDGE_GLOBALS: &[&str] = &["chatAPI", "utilityAPI", "desktopAPI", "electronAPI"];
pub const WINDOW_NAMES: &[&str] = &["window", "globalThis"];
pub const MAX_EXPR_CHARS: usize = 80;

pub fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRef {
    pub spec: String,
    pub line: usize,
    #[serde(skip_serializing_if = "is_false")]
    pub dynamic: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcFact {
    /// register / call / push
    pub side: &'static str,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    /// literal / const / dynamic
    pub via: &'static str,
    /// const 时为常量名，dynamic 时为参数表达式（截断）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRef {
    pub object: String,
    /// 经局部别名访问时的别名（`const api = window.utilityAPI || window.electronAPI` → `api`）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    pub name: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalDef {
    pub name: String,
    /// window / function / class / var / let / const
    pub how: &'static str,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAlias {
    pub name: String,
    pub object: String,
    pub line: usize,
    /// 模块顶层声明（经典 <script> 中即为页面级全局别名，可被同页其他脚本使用）
    #[serde(skip_serializing_if = "is_false")]
    pub top_level: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Expose {
    pub name: String,
    pub keys: Vec<String>,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfiExport {
    pub name: String,
    pub line: usize,
    pub lang: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTag {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub module: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub inline: bool,
    pub line: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFacts {
    /// 语言名或 "html"
    pub kind: &'static str,
    #[serde(skip_serializing_if = "is_false")]
    pub has_error: bool,
    pub requires: Vec<ModuleRef>,
    pub imports: Vec<ModuleRef>,
    pub ipc: Vec<IpcFact>,
    pub bridge: Vec<MemberRef>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bridge_aliases: Vec<BridgeAlias>,
    pub globals_defined: Vec<GlobalDef>,
    pub globals_used: Vec<MemberRef>,
    pub exposes: Vec<Expose>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ffi_exports: Vec<FfiExport>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<ScriptTag>,
}

impl FileFacts {
    pub fn is_empty(&self) -> bool {
        self.requires.is_empty()
            && self.imports.is_empty()
            && self.ipc.is_empty()
            && self.bridge.is_empty()
            && self.bridge_aliases.is_empty()
            && self.globals_defined.is_empty()
            && self.globals_used.is_empty()
            && self.exposes.is_empty()
            && self.ffi_exports.is_empty()
            && self.scripts.is_empty()
    }

    pub fn merge(&mut self, o: FileFacts) {
        self.has_error |= o.has_error;
        self.requires.extend(o.requires);
        self.imports.extend(o.imports);
        self.ipc.extend(o.ipc);
        self.bridge.extend(o.bridge);
        self.bridge_aliases.extend(o.bridge_aliases);
        self.globals_defined.extend(o.globals_defined);
        self.globals_used.extend(o.globals_used);
        self.exposes.extend(o.exposes);
        self.ffi_exports.extend(o.ffi_exports);
        self.scripts.extend(o.scripts);
    }
}

/// 非递归先序遍历（TreeCursor），不受语法树深度影响。
pub fn dfs<'t>(root: Node<'t>, mut f: impl FnMut(Node<'t>)) {
    let mut cursor = root.walk();
    loop {
        f(cursor.node());
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}