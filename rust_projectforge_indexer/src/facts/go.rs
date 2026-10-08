use tree_sitter::Node;

use crate::facts::c_cpp::unquote;
use crate::facts::types::{dfs, FfiExport, FileFacts, GlobalDef, ModuleRef};

/// 纯净 Go 语言事实提取器（微内核解耦）
pub fn extract_go_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    // 针对 go.mod 纯模块声明文件的极简文本探测
    for (idx, line) in source.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("module ") {
            let mod_name = trimmed["module ".len()..].trim();
            if !mod_name.is_empty() {
                facts.globals_defined.push(GlobalDef {
                    name: format!("module {}", mod_name),
                    how: "module",
                    line: idx + 1,
                    symbol: None,
                });
            }
        }
    }

    dfs(root, |n| {
        if n.kind() == "function_declaration" {
            // 支持 Go 汇编外部链接函数声明（无函数体，由 Plan 9 汇编实现的导出符号）
            let has_body = n.child_by_field_name("body").is_some();
            if !has_body {
                if let Some(name_node) = n.child_by_field_name("name") {
                    let fn_name = text_of(name_node).trim();
                    if !fn_name.is_empty() {
                        facts.ffi_exports.push(FfiExport {
                            name: fn_name.to_string(),
                            line: line_of(n),
                            lang: "go",
                        });
                    }
                }
            }
        } else if n.kind() == "import_spec" {
            if let Some(path_node) = n.child_by_field_name("path") {
                let spec = unquote(text_of(path_node));
                // 提取 cgo 伪包前置连续导言区注释中的 C 头文件与 FFI 函数声明
                if spec == "C" {
                    let mut comment_nodes = Vec::new();
                    let mut cur_p = n.prev_sibling();
                    while let Some(p) = cur_p {
                        if p.kind() == "comment" {
                            comment_nodes.push(p);
                        } else if p.kind() != "line_comment" && p.kind() != "block_comment" && !p.kind().contains("comment") {
                            break;
                        }
                        cur_p = p.prev_sibling();
                    }
                    if comment_nodes.is_empty() {
                        if let Some(parent) = n.parent() {
                            let mut cur_p = parent.prev_sibling();
                            while let Some(p) = cur_p {
                                if p.kind() == "comment" {
                                    comment_nodes.push(p);
                                } else if p.kind() != "line_comment" && p.kind() != "block_comment" && !p.kind().contains("comment") {
                                    break;
                                }
                                cur_p = p.prev_sibling();
                            }
                        }
                    }
                    for comment_node in comment_nodes {
                        let c_code = text_of(comment_node);
                        for line in c_code.lines() {
                            let trimmed = line.trim().trim_start_matches("/*").trim_end_matches("*/").trim_start_matches('*').trim();
                            if (trimmed.starts_with("extern") || trimmed.contains("void") || trimmed.contains("int")) && trimmed.contains('(') && trimmed.ends_with(';') {
                                let sig = trimmed.trim_end_matches(';').trim();
                                if let Some(open) = sig.find('(') {
                                    let before_paren = sig[..open].trim();
                                    let fn_name = before_paren.split_whitespace().last().unwrap_or("").trim_start_matches('*').trim();
                                    if !fn_name.is_empty() && !matches!(fn_name, "void" | "int" | "char" | "bool") {
                                        facts.ffi_exports.push(FfiExport {
                                            name: fn_name.to_string(),
                                            line: line_of(comment_node),
                                            lang: "c",
                                        });
                                    }
                                }
                            } else if trimmed.starts_with("#include") {
                                let inc_spec = trimmed.trim_start_matches("#include").trim();
                                let clean_spec = unquote(inc_spec);
                                if !clean_spec.is_empty() {
                                    facts.imports.push(ModuleRef {
                                        spec: clean_spec,
                                        line: line_of(comment_node),
                                        dynamic: false,
                                    });
                                }
                            }
                        }
                    }
                } else {
                    facts.imports.push(ModuleRef {
                        spec,
                        line: line_of(n),
                        dynamic: false,
                    });
                }
            }
        }
    });
}