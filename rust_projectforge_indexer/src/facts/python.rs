use tree_sitter::Node;

use crate::facts::types::{dfs, FileFacts, ModuleRef};

/// 纯净 Python 语言事实提取器（微内核解耦）
pub fn extract_python_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    dfs(root, |n| {
        if n.kind() == "import_from_statement" {
            // from .services import chat 或 from . import helper 或 from foo import bar
            let mut base_mod = String::new();
            if let Some(m) = n.child_by_field_name("module_name") {
                base_mod = text_of(m).trim().to_string();
            } else {
                let mut cur = n.walk();
                for child in n.named_children(&mut cur) {
                    if child.kind() == "relative_import" || child.kind() == "dotted_name" {
                        base_mod = text_of(child).trim().to_string();
                        break;
                    }
                }
            }
            if base_mod.is_empty() {
                base_mod = text_of(n).trim_start_matches("from").split("import").next().unwrap_or("").trim().to_string();
            }

            let mut names = Vec::new();
            let mut cur = n.walk();
            let mut saw_import_kw = false;
            for child in n.children(&mut cur) {
                let k = child.kind();
                if k == "import" {
                    saw_import_kw = true;
                    continue;
                }
                if saw_import_kw {
                    if k == "dotted_name" {
                        names.push(text_of(child).trim().to_string());
                    } else if k == "aliased_import" {
                        if let Some(orig) = child.child_by_field_name("name") {
                            names.push(text_of(orig).trim().to_string());
                        }
                    }
                }
            }

            if !base_mod.is_empty() {
                // 1. 若 base_mod 为纯点号（如 from . import helper 或 from .. import util），
                // 说明真正导入的模块是后面的 names，此时将每个 names 拼成具体子模块
                let is_pure_dots = base_mod.chars().all(|c| c == '.');
                if is_pure_dots && !names.is_empty() {
                    for name in names {
                        let combined = format!("{}{}", base_mod, name);
                        facts.imports.push(ModuleRef {
                            spec: combined,
                            line: line_of(n),
                            dynamic: false,
                        });
                    }
                } else if base_mod.starts_with('.') && !names.is_empty() {
                    // 1.1 若 base_mod 是相对前缀（如 from .sub import leaf），
                    // 同时发射 base_mod 与其子模块下钻 candidate（如 .sub.leaf），兼顾单测断言与深层子模块寻道
                    facts.imports.push(ModuleRef {
                        spec: base_mod.clone(),
                        line: line_of(n),
                        dynamic: false,
                    });
                    for name in names {
                        let combined = format!("{}.{}", base_mod, name);
                        facts.imports.push(ModuleRef {
                            spec: combined,
                            line: line_of(n),
                            dynamic: false,
                        });
                    }
                } else {
                    // 2. 若 base_mod 为标准非点号顶层包路径，base_mod 本身即为唯一依赖实体
                    facts.imports.push(ModuleRef {
                        spec: base_mod.clone(),
                        line: line_of(n),
                        dynamic: false,
                    });
                }
            }
        } else if n.kind() == "call" {
            // 嗅探 Python __import__ 函数动态加载调用并提取模块字面量
            let mut is_dyn_import = false;
            if let Some(fn_node) = n.child_by_field_name("function") {
                let fn_txt = text_of(fn_node).trim();
                if fn_txt == "__import__" || fn_txt.ends_with(".import_module") {
                    is_dyn_import = true;
                }
            }
            if is_dyn_import {
                if let Some(args) = n.child_by_field_name("arguments") {
                    let mut cur_a = args.walk();
                    for arg in args.named_children(&mut cur_a) {
                        let arg_txt = text_of(arg).trim();
                        if arg_txt.contains('"') || arg_txt.contains('\'') {
                            let cleaned = arg_txt.trim_start_matches("f\"").trim_start_matches("f'").trim_matches('"').trim_matches('\'');
                            let mod_prefix = cleaned.split('.').next().unwrap_or("").trim();
                            if !mod_prefix.is_empty() && mod_prefix.chars().all(|c| c.is_alphanumeric() || c == '_') {
                                facts.imports.push(ModuleRef {
                                    spec: mod_prefix.to_string(),
                                    line: line_of(n),
                                    dynamic: true,
                                });
                                break;
                            }
                        }
                    }
                }
            }
        } else if n.kind() == "import_statement" {
            // import foo, bar
            let mut cur = n.walk();
            let mut found_any = false;
            for child in n.named_children(&mut cur) {
                let mod_node = if child.kind() == "aliased_import" {
                    child.child_by_field_name("name")
                } else if child.kind() == "dotted_name" {
                    Some(child)
                } else {
                    None
                };
                if let Some(m) = mod_node {
                    let s = text_of(m).trim().to_string();
                    if !s.is_empty() {
                        facts.imports.push(ModuleRef {
                            spec: s,
                            line: line_of(n),
                            dynamic: false,
                        });
                        found_any = true;
                    }
                }
            }
            if !found_any {
                let txt = text_of(n).trim_start_matches("import").trim();
                for part in txt.split(',') {
                    let s = part.split_whitespace().next().unwrap_or("").trim();
                    if !s.is_empty() {
                        facts.imports.push(ModuleRef {
                            spec: s.to_string(),
                            line: line_of(n),
                            dynamic: false,
                        });
                    }
                }
            }
        }
    });
}