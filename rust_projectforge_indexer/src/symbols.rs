//! 符号提取：遍历 tree-sitter 语法树，输出扁平符号列表（parent 下标表示嵌套）。
//!
//! 行号约定（全部 1 起算，基于 LF 归一化、去 BOM 后的文本，与 Node 端 normalizeEol 一致）：
//! - `start`：签名行（含 export；跳过节点内部的装饰器）；
//! - `end`：结束行；
//! - `full_start`：向上吸收紧邻的注释 / 装饰器 / `#[attr]`（遇空行即停，不吸收上一行代码的行尾注释）。
//!
//! 替换、删除、搬运整个符号时应使用 `full_start..=end`，避免留下孤立的文档注释。
//! 本模块只给出"定义及其完整区间"；引用 / 调用链不在此范围。
//!
//! 作用域规则：模块顶层的普通变量记为 variable；函数体内只记录局部函数，不记录普通局部变量。

use serde::Serialize;
use tree_sitter::{Node, Parser};

use crate::lang::{Family, Lang};

/// 语法树递归深度上限：防止压缩代码等极端嵌套耗尽线程栈。
const MAX_AST_DEPTH: usize = 400;
const MAX_SIGNATURE_CHARS: usize = 200;
/// 对象字面量向下探测几层来判断"是否含函数"（决定是否作为 object 符号展开）。
const OBJECT_PROBE_DEPTH: usize = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    pub name: String,
    pub kind: &'static str,
    /// 限定名：JS/TS/Python 用 `.` 连接（`Store.putBlob`），Rust 用 `::`（`Store::put_blob`）。
    pub qualified: String,
    pub start: usize,
    pub end: usize,
    pub full_start: usize,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<usize>,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outline {
    pub lang: &'static str,
    /// 语法树含 ERROR / MISSING 节点（文件语法暂时有误）；符号仍尽力提取。
    pub has_error: bool,
    pub line_count: usize,
    pub symbols: Vec<Symbol>,
}

/// 去 BOM，CRLF / CR 统一为 LF。
pub fn normalize_source(raw: &str) -> String {
    let s = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    if !s.contains('\r') {
        return s.to_string();
    }
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 与 Node 端 splitLines 口径一致：末尾换行不计为额外一行。
fn line_count(source: &str) -> usize {
    if source.is_empty() {
        return 0;
    }
    let n = source.matches('\n').count();
    if source.ends_with('\n') {
        n
    } else {
        n + 1
    }
}

pub fn outline(lang: Lang, raw: &str, parser: &mut Parser) -> Result<Outline, String> {
    let source = normalize_source(raw);
    let tree = parse(lang, &source, parser)?;
    Ok(outline_from_tree(lang, &source, tree.root_node()))
}

/// 以已归一化的文本解析语法树（facts 与 outline 共用一次解析）。
pub fn parse(lang: Lang, source: &str, parser: &mut Parser) -> Result<tree_sitter::Tree, String> {
    parser
        .set_language(&lang.ts_language())
        .map_err(|e| format!("加载 {} grammar 失败：{e}", lang.name()))?;
    parser.parse(source, None).ok_or_else(|| "解析被中止".to_string())
}

/// 在已解析的语法树上提取符号；`source` 必须是解析时用的同一份归一化文本。
pub fn outline_from_tree(lang: Lang, source: &str, root: Node) -> Outline {
    let mut ex = Extractor {
        src: source.as_bytes(),
        lines: source.split('\n').collect(),
        family: lang.family(),
        out: Vec::new(),
    };
    ex.walk(root, None, "", 0, 0, false);
    Outline {
        lang: lang.name(),
        has_error: root.has_error(),
        line_count: line_count(source),
        symbols: ex.out,
    }
}

/// 值所处的上下文：变量声明 / 对象成员与类字段 / 赋值语句与 export default。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ctx {
    Decl,
    Member,
    Assign,
}

struct Found<'t> {
    name: String,
    kind: &'static str,
    outer: Node<'t>,
    container: Option<Node<'t>>,
    /// 赋值式定义（`module.exports.foo = …`）直接用左值文本作限定名。
    qualified_override: Option<String>,
}

impl<'t> Found<'t> {
    fn new(name: String, kind: &'static str, outer: Node<'t>, container: Option<Node<'t>>) -> Self {
        Found {
            name,
            kind,
            outer,
            container,
            qualified_override: None,
        }
    }
}

fn end_row(node: Node) -> usize {
    let end = node.end_position();
    if end.column == 0 && end.row > node.start_position().row {
        end.row - 1
    } else {
        end.row
    }
}

fn is_comment_kind(kind: &str) -> bool {
    matches!(kind, "comment" | "line_comment" | "block_comment")
}

fn is_prefix_kind(kind: &str) -> bool {
    matches!(kind, "decorator" | "attribute_item") || is_comment_kind(kind)
}

fn is_function_kind(kind: &str) -> bool {
    matches!(
        kind,
        "arrow_function"
            | "function_expression"
            | "function"
            | "generator_function"
            | "generator_function_expression"
    )
}

/// 签名行：跳过节点内部开头的装饰器 / 注释（如 JS 类装饰器、Python decorated_definition）。
fn body_start_row(outer: Node) -> usize {
    let mut cursor = outer.walk();
    for child in outer.children(&mut cursor) {
        if !is_prefix_kind(child.kind()) {
            return child.start_position().row;
        }
    }
    outer.start_position().row
}

#[allow(clippy::let_and_return)] // 迭代器借用 cursor，必须先落到局部变量
fn first_named<'t>(node: Node<'t>) -> Option<Node<'t>> {
    let mut cursor = node.walk();
    let first = node.named_children(&mut cursor).next();
    first
}

/// 剥掉括号、`as` / `satisfies` / 非空断言，取真正的值节点。
fn unwrap_value<'t>(mut node: Node<'t>) -> Node<'t> {
    while matches!(
        node.kind(),
        "parenthesized_expression" | "as_expression" | "satisfies_expression" | "non_null_expression"
    ) {
        match first_named(node) {
            Some(inner) => node = inner,
            None => break,
        }
    }
    node
}

/// 对象字面量是否含方法 / 函数值（向下探测 depth 层嵌套对象）。
fn has_callable(object: Node, depth: usize) -> bool {
    let mut cursor = object.walk();
    let children: Vec<Node> = object.named_children(&mut cursor).collect();
    children.into_iter().any(|child| match child.kind() {
        "method_definition" => true,
        "pair" => child
            .child_by_field_name("value")
            .map(unwrap_value)
            .is_some_and(|v| {
                is_function_kind(v.kind())
                    || (depth > 0 && v.kind() == "object" && has_callable(v, depth - 1))
            }),
        _ => false,
    })
}

struct Extractor<'a> {
    src: &'a [u8],
    lines: Vec<&'a str>,
    family: Family,
    out: Vec<Symbol>,
}

impl Extractor<'_> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.src).unwrap_or("").to_string()
    }

    /// 名字节点文本；字符串键（`'a': …`、`declare module "x"`）去掉引号。
    fn name_of(&self, node: Node) -> String {
        let raw = self.text(node);
        let trimmed = raw.trim();
        if matches!(node.kind(), "string" | "string_literal") {
            return trimmed
                .trim_matches(|c| c == '"' || c == '\'' || c == '`')
                .to_string();
        }
        trimmed.to_string()
    }

    fn field_text(&self, node: Node, field: &str) -> Option<String> {
        let child = node.child_by_field_name(field)?;
        let name = self.name_of(child);
        (!name.is_empty()).then_some(name)
    }

    /// 进入后视为函数作用域：其中的普通局部变量不再作为符号。
    fn opens_scope(&self, kind: &str) -> bool {
        match self.family {
            Family::Js => {
                is_function_kind(kind) || matches!(kind, "statement_block" | "class_static_block")
            }
            Family::Python => kind == "lambda",
            Family::Rust => matches!(kind, "block" | "closure_expression"),
        }
    }

    fn walk<'t>(
        &mut self,
        node: Node<'t>,
        parent: Option<usize>,
        prefix: &str,
        depth: usize,
        ast_depth: usize,
        scope_fn: bool,
    ) {
        if ast_depth > MAX_AST_DEPTH {
            return;
        }
        let parent_kind = parent.map(|i| self.out[i].kind);
        let mut cursor = node.walk();
        let children: Vec<Node<'t>> = node.named_children(&mut cursor).collect();
        for child in children {
            match self.extract(child, parent_kind, scope_fn) {
                Some(found) => {
                    let idx = self.push(&found, parent, prefix, depth);
                    if let Some(container) = found.container {
                        let qualified = self.out[idx].qualified.clone();
                        let inner_fn = scope_fn || matches!(found.kind, "function" | "method");
                        self.walk(container, Some(idx), &qualified, depth + 1, ast_depth + 1, inner_fn);
                    }
                }
                None => {
                    let inner_fn = scope_fn || self.opens_scope(child.kind());
                    self.walk(child, parent, prefix, depth, ast_depth + 1, inner_fn);
                }
            }
        }
    }

    fn push(&mut self, f: &Found, parent: Option<usize>, prefix: &str, depth: usize) -> usize {
        let sep = if self.family == Family::Rust { "::" } else { "." };
        let qualified = match &f.qualified_override {
            Some(q) => q.clone(),
            None if prefix.is_empty() => f.name.clone(),
            None => format!("{prefix}{sep}{}", f.name),
        };
        let start_row = body_start_row(f.outer);
        let end = self.symbol_end_row(f.outer).max(start_row);
        let full_start_row = self.full_start_row(f.outer).min(start_row);
        let signature: String = self
            .lines
            .get(start_row)
            .map(|l| l.trim().chars().take(MAX_SIGNATURE_CHARS).collect())
            .unwrap_or_default();
        self.out.push(Symbol {
            name: f.name.clone(),
            kind: f.kind,
            qualified,
            start: start_row + 1,
            end: end + 1,
            full_start: full_start_row + 1,
            depth,
            parent,
            signature,
        });
        self.out.len() - 1
    }

    fn is_leading(&self, node: Node) -> bool {
        let kind = node.kind();
        if !is_prefix_kind(kind) {
            return false;
        }
        if is_comment_kind(kind) {
            // Rust 内部文档注释（//! /*!）属于所在模块，不属于下一个条目。
            let text = self.text(node);
            if text.starts_with("//!") || text.starts_with("/*!") {
                return false;
            }
        }
        true
    }

    fn full_start_row(&self, outer: Node) -> usize {
        let mut start = outer.start_position().row;
        let mut cur = outer;
        while let Some(prev) = cur.prev_named_sibling() {
            if !self.is_leading(prev) || end_row(prev) + 1 < start {
                break;
            }
            if is_comment_kind(prev.kind()) {
                // 与上一段代码同行的是行尾注释，不属于本符号。
                if let Some(before) = prev.prev_sibling() {
                    if end_row(before) >= prev.start_position().row {
                        break;
                    }
                }
            }
            start = prev.start_position().row;
            cur = prev;
        }
        start
    }

    fn extract<'t>(
        &self,
        node: Node<'t>,
        parent_kind: Option<&'static str>,
        scope_fn: bool,
    ) -> Option<Found<'t>> {
        match self.family {
            Family::Js => self.extract_js(node, scope_fn),
            Family::Python => self.extract_py(node, parent_kind, scope_fn),
            Family::Rust => self.extract_rs(node, parent_kind),
        }
    }

    // ---------------- JavaScript / TypeScript / TSX ----------------

    fn extract_js<'t>(&self, node: Node<'t>, scope_fn: bool) -> Option<Found<'t>> {
        let named = |kind: &'static str, body: Option<Node<'t>>| -> Option<Found<'t>> {
            let name = self.field_text(node, "name")?;
            Some(Found::new(name, kind, node, body))
        };
        let body = node.child_by_field_name("body");
        match node.kind() {
            "function_declaration" | "generator_function_declaration" | "function_signature" => {
                named("function", body)
            }
            "class_declaration" | "abstract_class_declaration" => named("class", body),
            "interface_declaration" => named("interface", body),
            "enum_declaration" => named("enum", None),
            "type_alias_declaration" => named("type", None),
            "internal_module" | "module" => named("namespace", body),
            "method_definition" | "method_signature" | "abstract_method_signature" => {
                named("method", body)
            }
            "field_definition" | "public_field_definition" => {
                let key = node
                    .child_by_field_name("property")
                    .or_else(|| node.child_by_field_name("name"))?;
                let value = node.child_by_field_name("value")?;
                self.valued(self.name_of(key), value, node, Ctx::Member, scope_fn)
            }
            "pair" => {
                let key = node.child_by_field_name("key")?;
                let value = node.child_by_field_name("value")?;
                self.valued(self.name_of(key), value, node, Ctx::Member, scope_fn)
            }
            "lexical_declaration" | "variable_declaration" => {
                // 单个声明符时以整条语句为区间（含 const 与分号）；多个时交给 variable_declarator。
                let mut cursor = node.walk();
                let decls: Vec<Node<'t>> = node
                    .named_children(&mut cursor)
                    .filter(|n| n.kind() == "variable_declarator")
                    .collect();
                if decls.len() != 1 {
                    return None;
                }
                self.declarator(decls[0], node, scope_fn)
            }
            "variable_declarator" => self.declarator(node, node, scope_fn),
            "export_statement" => {
                if let Some(decl) = node.child_by_field_name("declaration") {
                    let mut found = self.extract_js(decl, scope_fn)?;
                    found.outer = node;
                    return Some(found);
                }
                let value = node.child_by_field_name("value")?;
                let name = self
                    .field_text(unwrap_value(value), "name")
                    .unwrap_or_else(|| "default".to_string());
                self.valued(name, value, node, Ctx::Assign, scope_fn)
            }
            "expression_statement" => {
                // 赋值式定义：module.exports.foo = …、Foo.prototype.bar = …、window.X = class …
                if scope_fn {
                    return None;
                }
                let expr = first_named(node)?;
                if expr.kind() != "assignment_expression" {
                    return None;
                }
                let left = expr.child_by_field_name("left")?;
                if left.kind() != "member_expression" {
                    return None;
                }
                let path: String = self.text(left).split_whitespace().collect();
                if path.starts_with("this.") {
                    return None;
                }
                let right = expr.child_by_field_name("right")?;
                let name = if path == "module.exports" {
                    path.clone()
                } else {
                    self.field_text(left, "property")?
                };
                let mut found = self.valued(name, right, node, Ctx::Assign, scope_fn)?;
                if found.kind == "function" && path.contains(".prototype.") {
                    found.kind = "method";
                }
                found.qualified_override = Some(path);
                Some(found)
            }
            _ => None,
        }
    }

    fn declarator<'t>(&self, decl: Node<'t>, outer: Node<'t>, scope_fn: bool) -> Option<Found<'t>> {
        let name_node = decl.child_by_field_name("name")?;
        if name_node.kind() != "identifier" {
            return None; // 解构声明不作为符号
        }
        let value = decl.child_by_field_name("value")?;
        self.valued(self.name_of(name_node), value, outer, Ctx::Decl, scope_fn)
    }

    fn is_require(&self, call: Node) -> bool {
        call.child_by_field_name("function")
            .is_some_and(|f| self.text(f) == "require")
    }

    /// 按值的形态决定符号类型：函数 / 类 / 含方法的对象 / 顶层普通变量。
    fn valued<'t>(
        &self,
        name: String,
        value: Node<'t>,
        outer: Node<'t>,
        ctx: Ctx,
        scope_fn: bool,
    ) -> Option<Found<'t>> {
        if name.is_empty() {
            return None;
        }
        let value = unwrap_value(value);
        let kind = value.kind();
        if is_function_kind(kind) {
            let k = if ctx == Ctx::Member { "method" } else { "function" };
            return Some(Found::new(name, k, outer, value.child_by_field_name("body")));
        }
        match kind {
            "class" => Some(Found::new(name, "class", outer, value.child_by_field_name("body"))),
            "object" if has_callable(value, OBJECT_PROBE_DEPTH) => {
                Some(Found::new(name, "object", outer, Some(value)))
            }
            "call_expression" if self.is_require(value) => None,
            _ if ctx == Ctx::Decl && !scope_fn => {
                Some(Found::new(name, "variable", outer, Some(value)))
            }
            _ => None,
        }
    }

    // ---------------- Python ----------------

    fn extract_py<'t>(
        &self,
        node: Node<'t>,
        parent_kind: Option<&'static str>,
        scope_fn: bool,
    ) -> Option<Found<'t>> {
        match node.kind() {
            "function_definition" => {
                let name = self.field_text(node, "name")?;
                let kind = if parent_kind == Some("class") { "method" } else { "function" };
                Some(Found::new(name, kind, node, node.child_by_field_name("body")))
            }
            "class_definition" => {
                let name = self.field_text(node, "name")?;
                Some(Found::new(name, "class", node, node.child_by_field_name("body")))
            }
            "decorated_definition" => {
                let def = node.child_by_field_name("definition")?;
                let mut found = self.extract_py(def, parent_kind, scope_fn)?;
                found.outer = node;
                Some(found)
            }
            "expression_statement" if !scope_fn => {
                let assign = first_named(node)?;
                if assign.kind() != "assignment" {
                    return None;
                }
                let left = assign.child_by_field_name("left")?;
                if left.kind() != "identifier" {
                    return None;
                }
                let right_kind = assign.child_by_field_name("right").map(|r| r.kind());
                let kind = match (right_kind, parent_kind) {
                    (Some("lambda"), Some("class")) => "method",
                    (Some("lambda"), _) => "function",
                    (_, Some("class")) => "field",
                    (_, None) => "variable",
                    _ => return None,
                };
                Some(Found::new(self.name_of(left), kind, node, None))
            }
            _ => None,
        }
    }

    // ---------------- Rust ----------------

    fn extract_rs<'t>(&self, node: Node<'t>, parent_kind: Option<&'static str>) -> Option<Found<'t>> {
        let in_type = matches!(parent_kind, Some("impl") | Some("trait"));
        let fn_kind = if in_type { "method" } else { "function" };
        let (kind, body) = match node.kind() {
            "function_item" => (fn_kind, node.child_by_field_name("body")),
            "function_signature_item" => (fn_kind, None),
            "struct_item" => ("struct", None),
            "enum_item" => ("enum", None),
            "union_item" => ("union", None),
            "trait_item" => ("trait", node.child_by_field_name("body")),
            "mod_item" => ("module", node.child_by_field_name("body")),
            "const_item" | "static_item" => ("constant", None),
            "type_item" => ("type", None),
            "macro_definition" => ("macro", None),
            "impl_item" => {
                // impl<T> Foo<T> / impl Trait for Foo：以类型名作为限定前缀（Foo::method）。
                let ty = node.child_by_field_name("type")?;
                let raw = self.text(ty);
                let name = raw.split('<').next().unwrap_or("").trim().to_string();
                if name.is_empty() {
                    return None;
                }
                return Some(Found::new(name, "impl", node, node.child_by_field_name("body")));
            }
            _ => return None,
        };
        let name = self.field_text(node, "name")?;
        Some(Found::new(name, kind, node, body))
    }

    fn symbol_end_row(&self, outer: Node) -> usize {
        if self.family == Family::Python {
            py_end_row(outer, outer.start_position().column)
        } else {
            end_row(outer)
        }
    }
}

fn is_py_compound(kind: &str) -> bool {
    matches!(
        kind,
        "decorated_definition"
            | "function_definition"
            | "class_definition"
            | "block"
            | "if_statement"
            | "elif_clause"
            | "else_clause"
            | "for_statement"
            | "while_statement"
            | "try_statement"
            | "except_clause"
            | "except_group_clause"
            | "finally_clause"
            | "with_statement"
            | "match_statement"
            | "case_clause"
    )
}

/// Python 块没有闭合符，tree-sitter 可能把块后、缩进不深于定义本身的注释挂进块尾。
/// 这类注释属于下一个定义，不计入本符号的结束行。
fn py_end_row(node: Node, def_col: usize) -> usize {
    if !is_py_compound(node.kind()) {
        return end_row(node);
    }
    let mut cursor = node.walk();
    let kids: Vec<Node> = node.named_children(&mut cursor).collect();
    for kid in kids.into_iter().rev() {
        if is_comment_kind(kid.kind()) && kid.start_position().column <= def_col {
            continue;
        }
        return py_end_row(kid, def_col);
    }
    end_row(node)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lang: Lang, src: &str) -> Outline {
        let mut parser = Parser::new();
        outline(lang, src, &mut parser).expect("outline")
    }

    fn get<'o>(o: &'o Outline, qualified: &str) -> &'o Symbol {
        o.symbols
            .iter()
            .find(|s| s.qualified == qualified)
            .unwrap_or_else(|| {
                let all: Vec<_> = o.symbols.iter().map(|s| (&s.qualified, s.kind, s.start, s.end)).collect();
                panic!("缺少符号 {qualified}，实际：{all:?}")
            })
    }

    fn span(s: &Symbol) -> (usize, usize, usize) {
        (s.full_start, s.start, s.end)
    }

    #[test]
    fn javascript_classes_objects_and_assignments() {
        let src = "'use strict';
const x = require('x'); // 行尾注释
/**
 * 存储类（中文注释）
 */
class Store {
    /** 存 blob */
    putBlob(content) {
        return 1;
    }
}
const gui = {
    listProjects() {},
    async revertFileChange({ a } = {}) {
        const local = 1;
        return local;
    },
};
const add = (a, b) => a + b;
export function exported() {}
module.exports.helper = function () {};
";
        let o = run(Lang::JavaScript, src);
        assert!(!o.has_error);
        assert_eq!(o.line_count, 21);
        assert_eq!(span(get(&o, "Store")), (3, 6, 11));
        assert_eq!(get(&o, "Store").kind, "class");
        assert_eq!(span(get(&o, "Store.putBlob")), (7, 8, 10));
        assert_eq!(get(&o, "Store.putBlob").kind, "method");
        assert_eq!(get(&o, "gui").kind, "object");
        assert_eq!(span(get(&o, "gui")), (12, 12, 18));
        assert_eq!(span(get(&o, "gui.revertFileChange")), (14, 14, 17));
        assert_eq!(get(&o, "gui.revertFileChange").parent.map(|p| o.symbols[p].name.as_str()), Some("gui"));
        assert_eq!(get(&o, "add").kind, "function");
        assert_eq!(get(&o, "add").start, 19);
        assert_eq!(get(&o, "exported").start, 20);
        assert_eq!(get(&o, "module.exports.helper").kind, "function");
        // require 与函数体内的局部变量不作为符号
        assert!(o.symbols.iter().all(|s| s.name != "x" && s.name != "local"));
    }

    #[test]
    fn typescript_declarations_and_decorators() {
        let src = "@Component()
export class A {
  @Input() name: string;
  method(): void {}
}
interface I { x: number }
type T = string;
enum E { A }
";
        let o = run(Lang::TypeScript, src);
        assert_eq!(span(get(&o, "A")), (1, 2, 5));
        assert_eq!(get(&o, "A.method").kind, "method");
        assert_eq!(get(&o, "I").kind, "interface");
        assert_eq!(get(&o, "T").kind, "type");
        assert_eq!(get(&o, "E").kind, "enum");

        let tsx = run(Lang::Tsx, "const C = () => <div />;\n");
        assert_eq!(get(&tsx, "C").kind, "function");
    }

    #[test]
    fn python_decorators_classes_and_trailing_comments() {
        let src = "import os
CONST = 1


@decorator
def top(a):
    return a
# 下一个函数的注释
def second():
    pass


class Cls:
    field = 2

    @staticmethod
    def m():
        local = 1
        return local
";
        let o = run(Lang::Python, src);
        assert_eq!(get(&o, "CONST").kind, "variable");
        assert_eq!(span(get(&o, "top")), (5, 6, 7));
        assert_eq!(get(&o, "second").start, 9);
        assert_eq!(get(&o, "second").full_start, 8);
        assert_eq!(get(&o, "Cls.field").kind, "field");
        assert_eq!(span(get(&o, "Cls.m")), (16, 17, 19));
        assert_eq!(get(&o, "Cls.m").kind, "method");
        assert!(o.symbols.iter().all(|s| s.name != "local"));
    }

    #[test]
    fn rust_attributes_docs_and_impl_paths() {
        let src = "//! 模块文档
use std::fmt;

/// 文档注释
#[derive(Debug)]
pub struct Store {
    a: u32,
}

impl<T> Store {
    /// 方法
    #[inline]
    pub fn put_blob(&self) -> u32 {
        let x = 1;
        x
    }
}
";
        let o = run(Lang::Rust, src);
        let st = o.symbols.iter().find(|s| s.kind == "struct").expect("struct");
        assert_eq!(span(st), (4, 6, 8));
        let imp = o.symbols.iter().find(|s| s.kind == "impl").expect("impl");
        assert_eq!((imp.name.as_str(), imp.start, imp.end), ("Store", 10, 17));
        let m = get(&o, "Store::put_blob");
        assert_eq!(m.kind, "method");
        assert_eq!(span(m), (11, 13, 16));
    }

    #[test]
    fn bom_crlf_and_error_tolerance() {
        let o = run(Lang::JavaScript, "\u{feff}function a() {\r\n  return 1;\r\n}\r\n");
        assert_eq!(o.line_count, 3);
        assert_eq!(span(get(&o, "a")), (1, 1, 3));

        let broken = run(Lang::JavaScript, "function ok() {}\nfunction broken( {\n\nconst z = 1;\n");
        assert!(broken.has_error);
        assert_eq!(get(&broken, "ok").start, 1);
    }
}