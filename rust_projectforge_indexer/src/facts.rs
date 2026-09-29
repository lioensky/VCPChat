//! 链路事实提取（P3）：对 JS/TS/TSX 文件与 HTML 页面提取"语言层面"的事实，不做任何跨文件推断。
//!
//! JS/TS/TSX：
//! - `requires` / `imports`：`require('x')`、`import … from 'x'`、`export … from 'x'`、`import('x')`；
//! - `ipc`：`ipcMain.handle|handleOnce|on|once`（register）、`ipcRenderer.invoke|send|sendSync|on|once|sendToHost|postMessage`（call）、
//!   `*.webContents.send` / `*.sender.send` / `event.reply`（push）。通道参数按字面量 → 同文件常量（`const CH = {…}` / `Object.freeze`）→ dynamic 解析；
//! - `bridge`：preload 桥接全局（默认 chatAPI / utilityAPI / desktopAPI / electronAPI，可由调用方传入）的成员访问，含 `window.chatAPI.x`；
//! - `globalsDefined`：`window.X = …` / `globalThis.X = …`，以及顶层 function / class / var / let / const（是否真为全局由调用方按 script 类型判断）；
//! - `globalsUsed`：`window.X` / `globalThis.X` 的读取（不含赋值左值）；
//! - `exposes`：`contextBridge.exposeInMainWorld('name', { … })` 的名字与键。
//!
//! HTML：按出现顺序列出 `<script>`（src / module / inline），忽略 HTML 注释中的脚本；内联脚本按 JS 提取事实，行号换算为 HTML 文件行号。
//!
//! 行号 1 起算，基于去 BOM、LF 归一化后的文本（与 outline 口径一致）；`symbol` 为包含该行的最内层符号限定名。

use std::collections::HashMap;

use serde::Serialize;
use tree_sitter::{Node, Parser};

use crate::lang::Lang;
use crate::symbols::{normalize_source, outline_from_tree, parse, Symbol};

pub const DEFAULT_BRIDGE_GLOBALS: &[&str] = &["chatAPI", "utilityAPI", "desktopAPI", "electronAPI"];
const WINDOW_NAMES: &[&str] = &["window", "globalThis"];
const MAX_EXPR_CHARS: usize = 80;

fn is_false(b: &bool) -> bool {
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
            && self.scripts.is_empty()
    }

    fn merge(&mut self, o: FileFacts) {
        self.has_error |= o.has_error;
        self.requires.extend(o.requires);
        self.imports.extend(o.imports);
        self.ipc.extend(o.ipc);
        self.bridge.extend(o.bridge);
        self.bridge_aliases.extend(o.bridge_aliases);
        self.globals_defined.extend(o.globals_defined);
        self.globals_used.extend(o.globals_used);
        self.exposes.extend(o.exposes);
        self.scripts.extend(o.scripts);
    }
}

/// 非递归先序遍历（TreeCursor），不受语法树深度影响。
fn dfs<'t>(root: Node<'t>, mut f: impl FnMut(Node<'t>)) {
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

fn squeeze(s: &str) -> String {
    s.split_whitespace().collect::<String>().replace("?.", ".")
}

fn nth_arg<'t>(args: Node<'t>, n: usize) -> Option<Node<'t>> {
    let mut cursor = args.walk();
    let found = args.named_children(&mut cursor).filter(|k| k.kind() != "comment").nth(n);
    found
}

fn enclosing_fn(n: Node) -> Option<Node> {
    let mut cur = n.parent();
    while let Some(p) = cur {
        if matches!(
            p.kind(),
            "function_declaration" | "generator_function_declaration" | "function_expression" | "function" | "arrow_function" | "method_definition"
        ) {
            return Some(p);
        }
        cur = p.parent();
    }
    None
}

struct Walker<'a> {
    src: &'a [u8],
    bridge: &'a [String],
    symbols: &'a [Symbol],
    consts: HashMap<String, String>,
    /// 别名 → 根桥接全局
    aliases: HashMap<String, String>,
    /// 转发包装函数名 → (side, method, 通道参数下标)
    wrappers: HashMap<String, (&'static str, String, usize)>,
    /// 包装函数内部的透传记录：(ipc 下标, 包装函数名, 参数表达式)；包装函数未被字面量调用时降级为 dynamic
    pending_params: Vec<(usize, String, String)>,
    offset: usize,
    out: FileFacts,
}

impl<'a> Walker<'a> {
    fn text(&self, n: Node) -> &'a str {
        n.utf8_text(self.src).unwrap_or("")
    }

    fn is_bridge(&self, s: &str) -> bool {
        self.bridge.iter().any(|b| b == s)
    }

    /// (文件行号, 包含该行的最内层符号限定名)
    fn at(&self, n: Node) -> (usize, Option<String>) {
        let local = n.start_position().row + 1;
        let symbol = self
            .symbols
            .iter()
            .filter(|s| s.start <= local && local <= s.end)
            .min_by_key(|s| s.end - s.start)
            .map(|s| s.qualified.clone());
        (local + self.offset, symbol)
    }

    fn string_value(&self, n: Node) -> Option<String> {
        match n.kind() {
            "string" => {
                let t = self.text(n);
                (t.len() >= 2).then(|| t[1..t.len() - 1].to_string())
            }
            "template_string" => {
                let mut cursor = n.walk();
                if n.named_children(&mut cursor).any(|k| k.kind() == "template_substitution") {
                    return None;
                }
                let t = self.text(n);
                (t.len() >= 2).then(|| t[1..t.len() - 1].to_string())
            }
            _ => None,
        }
    }

    fn unwrap_freeze<'t>(&self, value: Node<'t>) -> Node<'t> {
        if value.kind() == "call_expression" {
            let is_freeze = value
                .child_by_field_name("function")
                .is_some_and(|f| squeeze(self.text(f)) == "Object.freeze");
            if is_freeze {
                if let Some(arg) = value.child_by_field_name("arguments").and_then(|a| nth_arg(a, 0)) {
                    return arg;
                }
            }
        }
        value
    }

    /// 桥接根：`chatAPI` / `window.chatAPI` / `a || b` / `a ?? b`（取第一个可识别的桥接全局）。
    fn bridge_root(&self, mut n: Node) -> Option<String> {
        while n.kind() == "parenthesized_expression" {
            let mut c = n.walk();
            let inner = n.named_children(&mut c).next();
            n = inner?;
        }
        match n.kind() {
            "identifier" if self.is_bridge(self.text(n)) => Some(self.text(n).to_string()),
            "member_expression" => {
                let (o, p) = (n.child_by_field_name("object")?, n.child_by_field_name("property")?);
                (self.is_window(o) && self.is_bridge(self.text(p))).then(|| self.text(p).to_string())
            }
            "binary_expression" => {
                let op = n.child_by_field_name("operator").map(|o| self.text(o))?;
                if op != "||" && op != "??" {
                    return None;
                }
                n.child_by_field_name("left")
                    .and_then(|l| self.bridge_root(l))
                    .or_else(|| n.child_by_field_name("right").and_then(|r| self.bridge_root(r)))
            }
            _ => None,
        }
    }

    /// 同文件字符串常量：`const CH = 'x'`、`const CHANNELS = { A: 'x' }`（含 Object.freeze）；同时收集桥接别名。
    fn collect_consts(&mut self, root: Node) {
        let mut consts = HashMap::new();
        let mut aliases = HashMap::new();
        let mut alias_facts = Vec::new();
        dfs(root, |n| {
            if n.kind() != "variable_declarator" {
                return;
            }
            let (Some(name), Some(value)) = (n.child_by_field_name("name"), n.child_by_field_name("value")) else {
                return;
            };
            if name.kind() != "identifier" {
                return;
            }
            let name = self.text(name);
            if let Some(root) = self.bridge_root(value) {
                let top_level = n
                    .parent()
                    .and_then(|d| d.parent())
                    .is_some_and(|p| p.kind() == "program" || (p.kind() == "export_statement" && p.parent().is_some_and(|q| q.kind() == "program")));
                let (line, _) = self.at(n);
                alias_facts.push(BridgeAlias { name: name.to_string(), object: root.clone(), line, top_level });
                aliases.insert(name.to_string(), root);
                return;
            }
            let value = self.unwrap_freeze(value);
            if let Some(v) = self.string_value(value) {
                consts.insert(name.to_string(), v);
                return;
            }
            if value.kind() != "object" {
                return;
            }
            let mut cursor = value.walk();
            for pair in value.named_children(&mut cursor) {
                if pair.kind() != "pair" {
                    continue;
                }
                let (Some(k), Some(v)) = (pair.child_by_field_name("key"), pair.child_by_field_name("value")) else {
                    continue;
                };
                let key = self.string_value(k).unwrap_or_else(|| self.text(k).to_string());
                if let Some(v) = self.string_value(v) {
                    consts.insert(format!("{name}.{key}"), v);
                }
            }
        });
        self.consts = consts;
        self.aliases = aliases;
        self.out.bridge_aliases = alias_facts;
    }

    fn param_index(&self, f: Node, name: &str) -> Option<usize> {
        let params = f.child_by_field_name("parameters").or_else(|| f.child_by_field_name("parameter"))?;
        if params.kind() == "identifier" {
            return (self.text(params) == name).then_some(0);
        }
        let mut c = params.walk();
        let list: Vec<Node> = params.named_children(&mut c).filter(|k| k.kind() != "comment").collect();
        list.iter().position(|p| {
            let id = match p.kind() {
                "identifier" => Some(*p),
                "assignment_pattern" => p.child_by_field_name("left"),
                "required_parameter" | "optional_parameter" => p.child_by_field_name("pattern"),
                _ => None,
            };
            id.is_some_and(|i| i.kind() == "identifier" && self.text(i) == name)
        })
    }

    fn fn_name(&self, f: Node) -> Option<String> {
        if f.kind() != "method_definition" {
            if let Some(n) = f.child_by_field_name("name") {
                return Some(self.text(n).to_string());
            }
        }
        let p = f.parent()?;
        (p.kind() == "variable_declarator")
            .then(|| p.child_by_field_name("name"))
            .flatten()
            .filter(|n| n.kind() == "identifier")
            .map(|n| self.text(n).to_string())
    }

    /// 通道参数是外层函数的形参：记为包装函数，返回其名字。
    fn forwarding(&self, call: Node, arg: Node) -> Option<(String, usize)> {
        if arg.kind() != "identifier" {
            return None;
        }
        let f = enclosing_fn(call)?;
        let idx = self.param_index(f, self.text(arg))?;
        Some((self.fn_name(f)?, idx))
    }

    /// 同文件对包装函数的调用：`handle('git:status', fn)` → register。
    fn wrapper_calls(&mut self, root: Node) {
        if self.wrappers.is_empty() {
            return;
        }
        let mut used = std::collections::HashSet::new();
        let mut found = Vec::new();
        dfs(root, |n| {
            if n.kind() != "call_expression" {
                return;
            }
            let (Some(f), Some(args)) = (n.child_by_field_name("function"), n.child_by_field_name("arguments")) else {
                return;
            };
            if f.kind() != "identifier" {
                return;
            }
            if let Some((side, method, idx)) = self.wrappers.get(self.text(f)) {
                if let Some(arg) = nth_arg(args, *idx) {
                    found.push((n, arg, *side, method.clone(), self.text(f).to_string()));
                }
            }
        });
        for (n, arg, side, method, wrapper) in found {
            let channel = self.string_value(arg).or_else(|| self.consts.get(&squeeze(self.text(arg))).cloned());
            if channel.is_some() {
                used.insert(wrapper.clone());
            }
            let (line, symbol) = self.at(n);
            let (via, expr) = match &channel {
                Some(_) => ("wrapper", format!("{wrapper}()")),
                None => ("dynamic", format!("{wrapper}({})", squeeze(self.text(arg)).chars().take(MAX_EXPR_CHARS).collect::<String>())),
            };
            self.out.ipc.push(IpcFact { side, method: method.clone(), channel, via, expr: Some(expr), line, symbol });
        }
        for (idx, wrapper, key) in std::mem::take(&mut self.pending_params) {
            if !used.contains(&wrapper) {
                if let Some(f) = self.out.ipc.get_mut(idx) {
                    f.via = "dynamic";
                    f.expr = Some(key);
                }
            }
        }
    }

    fn top_level(&mut self, root: Node) {
        let mut cursor = root.walk();
        let kids: Vec<Node> = root.named_children(&mut cursor).collect();
        for kid in kids {
            let decl = if kid.kind() == "export_statement" {
                match kid.child_by_field_name("declaration") {
                    Some(d) => d,
                    None => continue,
                }
            } else {
                kid
            };
            match decl.kind() {
                "function_declaration" | "generator_function_declaration" => self.def_named(decl, "function"),
                "class_declaration" => self.def_named(decl, "class"),
                "lexical_declaration" | "variable_declaration" => {
                    let how = if decl.kind() == "variable_declaration" {
                        "var"
                    } else if decl.child(0).is_some_and(|c| self.text(c) == "let") {
                        "let"
                    } else {
                        "const"
                    };
                    let mut c2 = decl.walk();
                    let decls: Vec<Node> = decl.named_children(&mut c2).filter(|d| d.kind() == "variable_declarator").collect();
                    for d in decls {
                        if let Some(name) = d.child_by_field_name("name").filter(|n| n.kind() == "identifier") {
                            let (line, symbol) = self.at(d);
                            self.out.globals_defined.push(GlobalDef { name: self.text(name).to_string(), how, line, symbol });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn def_named(&mut self, decl: Node, how: &'static str) {
        if let Some(name) = decl.child_by_field_name("name") {
            let (line, symbol) = self.at(decl);
            self.out.globals_defined.push(GlobalDef { name: self.text(name).to_string(), how, line, symbol });
        }
    }

    fn visit(&mut self, n: Node) {
        match n.kind() {
            "call_expression" => self.call(n),
            "import_statement" | "export_statement" => {
                if let Some(v) = n.child_by_field_name("source").and_then(|s| self.string_value(s)) {
                    let (line, _) = self.at(n);
                    self.out.imports.push(ModuleRef { spec: v, line, dynamic: false });
                }
            }
            "member_expression" => self.member(n),
            "assignment_expression" => self.assign(n),
            _ => {}
        }
    }

    fn call(&mut self, n: Node) {
        let (Some(func), Some(args)) = (n.child_by_field_name("function"), n.child_by_field_name("arguments")) else {
            return;
        };
        match func.kind() {
            "identifier" if self.text(func) == "require" => {
                if let Some(v) = nth_arg(args, 0).and_then(|a| self.string_value(a)) {
                    let (line, _) = self.at(n);
                    self.out.requires.push(ModuleRef { spec: v, line, dynamic: false });
                }
            }
            "import" => {
                if let Some(v) = nth_arg(args, 0).and_then(|a| self.string_value(a)) {
                    let (line, _) = self.at(n);
                    self.out.imports.push(ModuleRef { spec: v, line, dynamic: true });
                }
            }
            "member_expression" => {
                let (Some(obj), Some(prop)) = (func.child_by_field_name("object"), func.child_by_field_name("property")) else {
                    return;
                };
                let prop = self.text(prop);
                let obj_s = squeeze(self.text(obj));
                let tail = obj_s.rsplit('.').next().unwrap_or("");
                let side = match (tail, prop) {
                    ("ipcMain", "handle" | "handleOnce" | "on" | "once") => Some("register"),
                    ("ipcRenderer", "invoke" | "send" | "sendSync" | "on" | "once" | "sendToHost" | "postMessage") => Some("call"),
                    ("webContents" | "sender", "send") => Some("push"),
                    ("event" | "evt" | "e", "reply") => Some("push"),
                    _ => None,
                };
                if let Some(side) = side {
                    self.ipc(n, args, side, prop);
                } else if tail == "contextBridge" && prop == "exposeInMainWorld" {
                    self.expose(n, args);
                }
            }
            _ => {}
        }
    }

    fn ipc(&mut self, n: Node, args: Node, side: &'static str, method: &str) {
        let Some(arg) = nth_arg(args, 0) else { return };
        let mut pending = None;
        let (channel, via, expr) = match self.string_value(arg) {
            Some(v) => (Some(v), "literal", None),
            None => {
                let key = squeeze(self.text(arg));
                match self.consts.get(&key) {
                    Some(v) => (Some(v.clone()), "const", Some(key)),
                    None => match self.forwarding(n, arg) {
                        Some((wrapper, idx)) => {
                            self.wrappers.insert(wrapper.clone(), (side, method.to_string(), idx));
                            let short: String = key.chars().take(MAX_EXPR_CHARS).collect();
                            pending = Some((wrapper.clone(), short));
                            (None, "param", Some(format!("{key} → {wrapper}()")))
                        }
                        None => (None, "dynamic", Some(key.chars().take(MAX_EXPR_CHARS).collect())),
                    },
                }
            }
        };
        let (line, symbol) = self.at(n);
        if let Some((wrapper, key)) = pending {
            self.pending_params.push((self.out.ipc.len(), wrapper, key));
        }
        self.out.ipc.push(IpcFact { side, method: method.to_string(), channel, via, expr, line, symbol });
    }

    fn expose(&mut self, n: Node, args: Node) {
        let Some(name) = nth_arg(args, 0).and_then(|a| self.string_value(a)) else { return };
        let mut keys = Vec::new();
        if let Some(obj) = nth_arg(args, 1).filter(|o| o.kind() == "object") {
            let mut cursor = obj.walk();
            for child in obj.named_children(&mut cursor) {
                let key = match child.kind() {
                    "pair" => child.child_by_field_name("key").map(|k| self.string_value(k).unwrap_or_else(|| self.text(k).to_string())),
                    "shorthand_property_identifier" => Some(self.text(child).to_string()),
                    "method_definition" => child.child_by_field_name("name").map(|k| self.text(k).to_string()),
                    _ => None,
                };
                keys.extend(key);
            }
        }
        let (line, _) = self.at(n);
        self.out.exposes.push(Expose { name, keys, line });
    }

    fn is_assign_target(&self, n: Node) -> bool {
        n.parent().is_some_and(|p| {
            p.kind() == "assignment_expression" && p.child_by_field_name("left").is_some_and(|l| l.id() == n.id())
        })
    }

    fn is_window(&self, n: Node) -> bool {
        n.kind() == "identifier" && WINDOW_NAMES.contains(&self.text(n))
    }

    fn member(&mut self, n: Node) {
        let (Some(obj), Some(prop)) = (n.child_by_field_name("object"), n.child_by_field_name("property")) else {
            return;
        };
        if prop.kind() != "property_identifier" {
            return;
        }
        let name = self.text(prop);
        let bridge_root: Option<(String, Option<String>)> = match obj.kind() {
            "identifier" => {
                let t = self.text(obj);
                match self.aliases.get(t) {
                    Some(r) => Some((r.clone(), (r != t).then(|| t.to_string()))),
                    None if self.is_bridge(t) => Some((t.to_string(), None)),
                    None => None,
                }
            }
            "member_expression" => match (obj.child_by_field_name("object"), obj.child_by_field_name("property")) {
                (Some(o), Some(p)) if self.is_window(o) && self.is_bridge(self.text(p)) => Some((self.text(p).to_string(), None)),
                _ => None,
            },
            _ => None,
        };
        if let Some((root, alias)) = bridge_root {
            let (line, symbol) = self.at(n);
            self.out.bridge.push(MemberRef { object: root, alias, name: name.to_string(), line, symbol });
            return;
        }
        if self.is_window(obj) && !self.is_bridge(name) && !self.is_assign_target(n) {
            let (line, symbol) = self.at(n);
            self.out.globals_used.push(MemberRef { object: self.text(obj).to_string(), alias: None, name: name.to_string(), line, symbol });
        }
    }

    fn assign(&mut self, n: Node) {
        let Some(left) = n.child_by_field_name("left").filter(|l| l.kind() == "member_expression") else { return };
        let (Some(obj), Some(prop)) = (left.child_by_field_name("object"), left.child_by_field_name("property")) else {
            return;
        };
        if self.is_window(obj) && prop.kind() == "property_identifier" {
            let (line, symbol) = self.at(n);
            self.out.globals_defined.push(GlobalDef { name: self.text(prop).to_string(), how: "window", line, symbol });
        }
    }
}

fn facts_from_tree(source: &str, root: Node, symbols: &[Symbol], bridge: &[String], offset: usize) -> FileFacts {
    let mut w = Walker {
        src: source.as_bytes(), bridge, symbols, consts: HashMap::new(), aliases: HashMap::new(),
        wrappers: HashMap::new(), pending_params: Vec::new(), offset, out: FileFacts::default(),
    };
    w.collect_consts(root);
    w.top_level(root);
    dfs(root, |n| w.visit(n));
    w.wrapper_calls(root);
    w.out.has_error = root.has_error();
    w.out
}

/// JS / TS / TSX 文件事实。调用方需保证 lang 属于 JS 族。
pub fn js_facts(lang: Lang, raw: &str, parser: &mut Parser, bridge: &[String]) -> Result<FileFacts, String> {
    let source = normalize_source(raw);
    let tree = parse(lang, &source, parser)?;
    let root = tree.root_node();
    let outline = outline_from_tree(lang, &source, root);
    let mut facts = facts_from_tree(&source, root, &outline.symbols, bridge, 0);
    facts.kind = lang.name();
    Ok(facts)
}

// ---------------- HTML ----------------

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn line_at(bytes: &[u8], idx: usize) -> usize {
    bytes[..idx.min(bytes.len())].iter().filter(|&&b| b == b'\n').count() + 1
}

/// 把 `<!-- … -->` 内容替换为空格（保留换行，字节长度不变）。
fn mask_comments(bytes: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    let mut pos = 0;
    while let Some(rel) = find(&out[pos..], b"<!--") {
        let start = pos + rel;
        let end = find(&out[start + 4..], b"-->").map(|r| start + 4 + r + 3).unwrap_or(out.len());
        for b in &mut out[start..end] {
            if *b != b'\n' {
                *b = b' ';
            }
        }
        pos = end;
    }
    out
}

fn parse_attrs(b: &[u8]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let ns = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if ns == i {
            i += 1;
            continue;
        }
        let name = String::from_utf8_lossy(&b[ns..i]).to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let vs = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = String::from_utf8_lossy(&b[vs..i]).into_owned();
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = String::from_utf8_lossy(&b[vs..i]).into_owned();
            }
        }
        map.entry(name).or_insert(value);
    }
    map
}

/// HTML 页面：有序脚本列表 + 内联脚本的 JS 事实（行号为 HTML 文件行号）。
pub fn html_facts(raw: &str, parser: &mut Parser, bridge: &[String]) -> FileFacts {
    let source = normalize_source(raw);
    let bytes = source.as_bytes();
    let masked = mask_comments(bytes);
    let lower = masked.to_ascii_lowercase();
    let mut out = FileFacts { kind: "html", ..Default::default() };
    let mut pos = 0;
    while let Some(rel) = find(&lower[pos..], b"<script") {
        let start = pos + rel;
        let after = start + 7;
        let next = lower.get(after).copied().unwrap_or(b'>');
        if !(next.is_ascii_whitespace() || next == b'>' || next == b'/') {
            pos = after;
            continue;
        }
        let Some(gt_rel) = find(&lower[after..], b">") else { break };
        let gt = after + gt_rel;
        let attrs = parse_attrs(&masked[after..gt]);
        let line = line_at(bytes, start);
        let close = find(&lower[gt + 1..], b"</script").map(|r| gt + 1 + r).unwrap_or(lower.len());
        let ty = attrs.get("type").map(|t| t.trim().to_ascii_lowercase()).unwrap_or_default();
        let module = ty == "module";
        let is_js = ty.is_empty() || module || ty.contains("javascript") || ty.contains("ecmascript");
        match attrs.get("src").filter(|s| !s.trim().is_empty()) {
            Some(src) => out.scripts.push(ScriptTag { src: Some(src.trim().to_string()), module, inline: false, line }),
            None if is_js => {
                let body = std::str::from_utf8(&bytes[gt + 1..close]).unwrap_or("");
                if !body.trim().is_empty() {
                    out.scripts.push(ScriptTag { src: None, module, inline: true, line });
                    let offset = line_at(bytes, gt + 1) - 1;
                    if let Ok(tree) = parse(Lang::JavaScript, body, parser) {
                        let root = tree.root_node();
                        let ol = outline_from_tree(Lang::JavaScript, body, root);
                        out.merge(facts_from_tree(body, root, &ol.symbols, bridge, offset));
                    }
                }
            }
            None => {}
        }
        pos = (close + 8).min(lower.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Vec<String> {
        DEFAULT_BRIDGE_GLOBALS.iter().map(|s| s.to_string()).collect()
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
        assert_eq!(f.requires.iter().map(|r| r.spec.as_str()).collect::<Vec<_>>(), ["electron", "./helper"]);
        assert_eq!(f.imports.len(), 2);
        assert!(f.imports.iter().any(|i| i.spec == "./lazy.js" && i.dynamic));

        let reg = ipc(&f, "register");
        assert_eq!(reg.len(), 4);
        assert_eq!((reg[0].channel.as_deref(), reg[0].via, reg[0].line), (Some("save-settings"), "literal", 6));
        assert_eq!(reg[0].symbol.as_deref(), Some("register"));
        assert_eq!((reg[1].channel.as_deref(), reg[1].via, reg[1].expr.as_deref()), (Some("window-ready"), "const", Some("CHANNELS.READY")));
        assert_eq!(reg[2].channel.as_deref(), Some("tpl-ch"));
        assert_eq!((reg[3].channel.as_deref(), reg[3].via), (None, "dynamic"));
        let push = ipc(&f, "push");
        assert_eq!((push[0].channel.as_deref(), push[0].line), (Some("settings-changed"), 10));
        let call = ipc(&f, "call");
        assert_eq!((call[0].via, call[0].expr.as_deref()), ("dynamic", Some("ch")));

        let names: Vec<_> = f.bridge.iter().map(|b| (b.object.as_str(), b.name.as_str())).collect();
        assert_eq!(names, [("chatAPI", "saveSettings"), ("electronAPI", "onThemeUpdated")]);
        assert!(f.globals_defined.iter().any(|g| g.name == "messageRenderer" && g.how == "window" && g.line == 15));
        assert!(f.globals_defined.iter().any(|g| g.name == "register" && g.how == "function"));
        assert!(f.globals_defined.iter().any(|g| g.name == "CHANNELS" && g.how == "const"));
        assert_eq!(f.globals_used.iter().map(|g| (g.name.as_str(), g.line)).collect::<Vec<_>>(), [("messageRenderer", 16)]);
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
            f.bridge_aliases.iter().map(|a| (a.name.as_str(), a.object.as_str(), a.top_level)).collect::<Vec<_>>(),
            [("api", "utilityAPI", true), ("electronAPI", "chatAPI", true)]
        );
        let b: Vec<_> = f.bridge.iter().map(|b| (b.object.as_str(), b.alias.as_deref(), b.name.as_str())).collect();
        assert_eq!(b, [
            ("chatAPI", None, "watcherBegin"),
            ("utilityAPI", Some("api"), "projectForgeListProjects"),
            ("chatAPI", Some("electronAPI"), "saveSettings"),
        ]);
        let reg = ipc(&f, "register");
        assert_eq!(reg.iter().map(|i| (i.channel.as_deref(), i.via)).collect::<Vec<_>>(), [
            (None, "param"),
            (Some("git:status"), "wrapper"),
            (None, "dynamic"),
        ]);
        assert_eq!((reg[1].line, reg[1].method.as_str(), reg[1].symbol.as_deref()), (9, "handle", Some("register")));
        let push = ipc(&f, "push");
        assert!(push.iter().any(|i| i.channel.as_deref() == Some("git:changed") && i.via == "wrapper" && i.line == 10));
    }

    #[test]
    fn html_scripts_in_order_with_inline_facts() {
        let src = "\u{feff}<!doctype html>\r\n<html><head>\r\n<!-- <script src=\"old.js\"></script> -->\r\n<script src=\"a.js\"></script>\r\n<script type=\"module\" src='./b.mjs' defer></script>\r\n<script>\r\n  window.inlineGlobal = 1;\r\n  chatAPI.ping();\r\n</script>\r\n<script type=\"text/template\"><div></div></script>\r\n<SCRIPT SRC=c.js></SCRIPT>\r\n</head></html>\r\n";
        let mut p = Parser::new();
        let f = html_facts(src, &mut p, &bridge());
        let order: Vec<_> = f.scripts.iter().map(|s| (s.src.as_deref(), s.module, s.inline, s.line)).collect();
        assert_eq!(order, [
            (Some("a.js"), false, false, 4),
            (Some("./b.mjs"), true, false, 5),
            (None, false, true, 6),
            (Some("c.js"), false, false, 11),
        ]);
        assert_eq!(f.globals_defined[0].name, "inlineGlobal");
        assert_eq!(f.globals_defined[0].line, 7);
        assert_eq!((f.bridge[0].name.as_str(), f.bridge[0].line), ("ping", 8));
    }
}