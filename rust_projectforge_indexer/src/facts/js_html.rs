use std::collections::HashMap;

use tree_sitter::{Node, Parser};

use crate::facts::types::{
    dfs, BridgeAlias, Expose, FileFacts, GlobalDef, IpcFact, MemberRef, ModuleRef, ScriptTag,
    MAX_EXPR_CHARS, WINDOW_NAMES,
};
use crate::lang::Lang;
use crate::symbols::{normalize_source, outline_from_tree, parse, Symbol};

fn squeeze(s: &str) -> String {
    s.split_whitespace().collect::<String>().replace("?.", ".")
}

fn nth_arg<'t>(args: Node<'t>, n: usize) -> Option<Node<'t>> {
    let mut cursor = args.walk();
    let res = args.named_children(&mut cursor).filter(|k| k.kind() != "comment").nth(n);
    res
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
    aliases: HashMap<String, String>,
    wrappers: HashMap<String, (&'static str, String, usize)>,
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

    fn forwarding(&self, call: Node, arg: Node) -> Option<(String, usize)> {
        if arg.kind() != "identifier" {
            return None;
        }
        let f = enclosing_fn(call)?;
        let idx = self.param_index(f, self.text(arg))?;
        Some((self.fn_name(f)?, idx))
    }

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
    dfs(root, |n| {
        let k = n.kind();
        if k == "comment" {
            let txt = std::str::from_utf8(&source.as_bytes()[n.start_byte()..n.end_byte()]).unwrap_or("").trim();
            if txt.starts_with("///") && txt.contains("<reference") && txt.contains("path=") {
                if let Some(p_start) = txt.find("path=") {
                    let after = &txt[p_start + 5..];
                    let quote = after.chars().next().unwrap_or('"');
                    if quote == '"' || quote == '\'' {
                        let rem = &after[1..];
                        if let Some(p_end) = rem.find(quote) {
                            let ref_path = &rem[..p_end];
                            if !ref_path.is_empty() {
                                w.out.imports.push(ModuleRef {
                                    spec: ref_path.to_string(),
                                    line: n.start_position().row + 1 + offset,
                                    dynamic: false,
                                });
                            }
                        }
                    }
                }
            }
        } else if k == "ambient_declaration" || k == "module" {
            let txt = std::str::from_utf8(&source.as_bytes()[n.start_byte()..n.end_byte()]).unwrap_or("").trim();
            if txt.starts_with("declare module") {
                if let Some(first_quote) = txt.find('"').or_else(|| txt.find('\'')) {
                    let quote_char = txt.chars().nth(first_quote).unwrap();
                    let after = &txt[first_quote + 1..];
                    if let Some(end_quote) = after.find(quote_char) {
                        let vmod = &after[..end_quote];
                        if !vmod.is_empty() {
                            w.out.globals_defined.push(GlobalDef {
                                name: vmod.to_string(),
                                how: "ambient_module",
                                line: n.start_position().row + 1 + offset,
                                symbol: None,
                            });
                        }
                    }
                }
            }
        }
        w.visit(n);
    });
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

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn line_at(bytes: &[u8], idx: usize) -> usize {
    bytes[..idx.min(bytes.len())].iter().filter(|&&b| b == b'\n').count() + 1
}

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