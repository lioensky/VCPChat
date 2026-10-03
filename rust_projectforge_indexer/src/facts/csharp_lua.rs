use tree_sitter::Node;

use crate::facts::c_cpp::unquote;
use crate::facts::types::{dfs, FileFacts, ModuleRef};

/// 纯净 C# 与 Lua 语言事实提取器（微内核解耦）
pub fn extract_csharp_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    dfs(root, |n| {
        if n.kind() == "using_directive" {
            let raw = text_of(n).trim().trim_end_matches(';').trim();
            let mut target_spec = String::new();
            if raw.contains('=') {
                if let Some(right) = raw.split('=').nth(1) {
                    target_spec = right.trim().to_string();
                }
            } else if let Some(name_node) = n.child_by_field_name("name") {
                target_spec = text_of(name_node).trim().to_string();
            } else {
                let clean = raw.trim_start_matches("global").trim().trim_start_matches("using").trim();
                target_spec = clean.to_string();
            }
            if !target_spec.is_empty() {
                facts.imports.push(ModuleRef {
                    spec: target_spec,
                    line: line_of(n),
                    dynamic: false,
                });
            }
        }
    });
}

pub fn extract_lua_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    dfs(root, |n| {
        if n.kind() == "function_call" {
            let mut cur = n.walk();
            let kids: Vec<Node> = n.named_children(&mut cur).collect();
            if let Some(first) = kids.first() {
                if text_of(*first) == "require" {
                    if let Some(arg) = kids.get(1) {
                        let raw_arg = text_of(*arg).trim();
                        let clean = raw_arg.trim_matches(|c: char| c == '(' || c == ')' || c == '"' || c == '\'').trim();
                        let spec = clean.replace('.', "/");
                        if !spec.is_empty() {
                            facts.requires.push(ModuleRef {
                                spec,
                                line: line_of(n),
                                dynamic: false,
                            });
                        }
                    }
                }
            }
        }
    });
}