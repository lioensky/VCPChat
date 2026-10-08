use tree_sitter::Node;

use crate::facts::types::{dfs, FfiExport, FileFacts, ModuleRef};

pub fn flatten_rust_use_tree<'a>(src: &'a [u8], prefix: &str, node: Node, out: &mut Vec<String>) {
    let text = |n: Node| -> &'a str {
        std::str::from_utf8(&src[n.start_byte()..n.end_byte()]).unwrap_or("")
    };
    match node.kind() {
        "scoped_use_list" => {
            let mut base_prefix = prefix.to_string();
            if let Some(path_node) = node.child_by_field_name("path") {
                let p = text(path_node).trim();
                if !p.is_empty() {
                    base_prefix = if base_prefix.is_empty() {
                        p.to_string()
                    } else {
                        format!("{}::{}", base_prefix, p)
                    };
                }
            }
            if let Some(list_node) = node.child_by_field_name("list") {
                let mut cur = list_node.walk();
                for child in list_node.named_children(&mut cur) {
                    flatten_rust_use_tree(src, &base_prefix, child, out);
                }
            }
        }
        "use_list" => {
            let mut cur = node.walk();
            for child in node.named_children(&mut cur) {
                flatten_rust_use_tree(src, prefix, child, out);
            }
        }
        "use_as_clause" => {
            if let Some(path_node) = node.child_by_field_name("path") {
                flatten_rust_use_tree(src, prefix, path_node, out);
            }
        }
        "use_wildcard" => {
            if !prefix.is_empty() {
                out.push(prefix.to_string());
            }
        }
        _ => {
            let item = text(node).trim();
            if item == "*" {
                if !prefix.is_empty() {
                    out.push(prefix.to_string());
                }
            } else if !item.is_empty() && item != "self" {
                let full = if prefix.is_empty() {
                    item.to_string()
                } else {
                    format!("{}::{}", prefix, item)
                };
                out.push(full);
            } else if item == "self" && !prefix.is_empty() {
                out.push(prefix.to_string());
            }
        }
    }
}

/// 纯净 Rust 语言事实提取器（微内核解耦）
pub fn extract_rust_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    dfs(root, |n| {
        if n.kind() == "use_declaration" {
            if let Some(arg) = n.child_by_field_name("argument") {
                let mut expanded = Vec::new();
                flatten_rust_use_tree(src_bytes, "", arg, &mut expanded);
                if expanded.is_empty() {
                    facts.imports.push(ModuleRef {
                        spec: text_of(arg).trim().to_string(),
                        line: line_of(n),
                        dynamic: false,
                    });
                } else {
                    for spec in expanded {
                        facts.imports.push(ModuleRef {
                            spec,
                            line: line_of(n),
                            dynamic: false,
                        });
                    }
                }
            }
        } else if n.kind() == "mod_item" {
            if let Some(name_node) = n.child_by_field_name("name") {
                facts.imports.push(ModuleRef {
                    spec: text_of(name_node).trim().to_string(),
                    line: line_of(n),
                    dynamic: false,
                });
            }
        } else if n.kind() == "function_item" {
            let mut custom_export_name = None;
            let mut has_no_mangle = false;
            let mut first_attr_line = None;

            // 检查直接前置同级属性兄弟节点或内部子属性
            let mut cur_prev = n.prev_sibling();
            while let Some(p) = cur_prev {
                if p.kind() == "attribute_item" {
                    first_attr_line = Some(line_of(p));
                    let attr_txt = text_of(p);
                    if attr_txt.contains("no_mangle") {
                        has_no_mangle = true;
                    }
                    if attr_txt.contains("export_name") {
                        if let Some(quote_start) = attr_txt.find('"') {
                            if let Some(quote_end) = attr_txt[quote_start + 1..].find('"') {
                                custom_export_name = Some(attr_txt[quote_start + 1..quote_start + 1 + quote_end].to_string());
                            }
                        }
                    }
                    cur_prev = p.prev_sibling();
                } else if p.kind() == "line_comment" || p.kind() == "block_comment" {
                    cur_prev = p.prev_sibling();
                } else {
                    break;
                }
            }

            let mut cur = n.walk();
            for child in n.named_children(&mut cur) {
                if child.kind() == "attribute_item" {
                    if first_attr_line.is_none() {
                        first_attr_line = Some(line_of(child));
                    }
                    let attr_txt = text_of(child);
                    if attr_txt.contains("no_mangle") {
                        has_no_mangle = true;
                    }
                    if attr_txt.contains("export_name") {
                        if let Some(quote_start) = attr_txt.find('"') {
                            if let Some(quote_end) = attr_txt[quote_start + 1..].find('"') {
                                custom_export_name = Some(attr_txt[quote_start + 1..quote_start + 1 + quote_end].to_string());
                            }
                        }
                    }
                }
            }

            let txt = text_of(n);
            let has_ffi_abi = txt.contains("extern \"C\"")
                || txt.contains("extern \"system\"")
                || txt.contains("extern \"win64\"")
                || txt.contains("extern \"sysv64\"")
                || txt.contains("extern \"stdcall\"")
                || txt.contains("extern \"fastcall\"")
                || txt.contains("extern \"C-unwind\"");

            let is_ffi_export = has_no_mangle || custom_export_name.is_some() || has_ffi_abi;
            if is_ffi_export {
                let sym_name = custom_export_name.or_else(|| {
                    n.child_by_field_name("name").map(|name_node| text_of(name_node).trim().to_string())
                });
                if let Some(name) = sym_name {
                    facts.ffi_exports.push(FfiExport {
                        name,
                        line: line_of(n),
                        lang: "rust",
                    });
                }
            }
        } else if n.kind() == "macro_invocation" {
            let mut named_cur = n.walk();
            let children: Vec<_> = n.named_children(&mut named_cur).collect();
            if children.len() >= 2 {
                let macro_name = text_of(children[0]).trim();
                if !matches!(macro_name, "println" | "vec" | "format" | "panic" | "assert" | "matches" | "eprintln") {
                    let token_tree = children[1];
                    let mut tt_cur = token_tree.walk();
                    for arg in token_tree.named_children(&mut tt_cur) {
                        if arg.kind() == "identifier" {
                            let sym = text_of(arg).trim();
                            if !sym.is_empty() && !matches!(sym, "pub" | "extern" | "fn" | "mut" | "ref") {
                                facts.ffi_exports.push(FfiExport {
                                    name: sym.to_string(),
                                    line: line_of(n),
                                    lang: "rust",
                                });
                            }
                        }
                    }
                }
            }
        }
    });
}