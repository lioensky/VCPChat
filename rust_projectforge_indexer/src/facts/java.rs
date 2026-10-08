use tree_sitter::Node;

use crate::facts::types::{dfs, FileFacts, GlobalDef, ModuleRef};

/// 纯净 Java 语言事实提取器（微内核解耦）
pub fn extract_java_facts(source: &str, root: Node, facts: &mut FileFacts) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    dfs(root, |n| {
        if n.kind() == "permits" {
            // Java 17+ 密封类与接口 permits 从句的许可子类型依赖提取
            let mut cur = n.walk();
            for child in n.named_children(&mut cur) {
                if child.kind() == "type_list" {
                    let mut c2 = child.walk();
                    for t in child.named_children(&mut c2) {
                        if t.kind() == "type_identifier" || t.kind() == "scoped_type_identifier" {
                            let type_name = text_of(t).trim();
                            if !type_name.is_empty() {
                                facts.imports.push(ModuleRef {
                                    spec: type_name.to_string(),
                                    line: line_of(t),
                                    dynamic: false,
                                });
                            }
                        }
                    }
                }
            }
        } else if n.kind() == "superclass" || n.kind() == "super_class" || n.kind() == "super_interfaces" || n.kind() == "extends_interfaces" || n.kind() == "interfaces" {
            // 提取类与接口的显式及泛型继承依赖（superclass / super_interfaces）
            let mut stack = vec![n];
            while let Some(curr) = stack.pop() {
                let k = curr.kind();
                if k == "type_identifier" || k == "scoped_type_identifier" {
                    // 若父节点是泛型类型参数则忽略（如 ArrayList<String> 忽略 String，只提取 ArrayList）
                    let is_type_arg = curr.parent().map_or(false, |p| p.kind() == "type_arguments");
                    if !is_type_arg {
                        let type_name = text_of(curr).trim();
                        if !type_name.is_empty() && !facts.imports.iter().any(|m| m.spec == type_name && m.line == line_of(curr)) {
                            facts.imports.push(ModuleRef {
                                spec: type_name.to_string(),
                                line: line_of(curr),
                                dynamic: false,
                            });
                        }
                    }
                } else {
                    let mut cur = curr.walk();
                    for child in curr.named_children(&mut cur) {
                        stack.push(child);
                    }
                }
            }
        } else if n.kind() == "formal_parameter" || n.kind() == "field_declaration" || n.kind() == "record_component" {
            // 提取方法形参、成员字段与记录组件中的自定义类型引用
            let mut stack = vec![n];
            while let Some(curr) = stack.pop() {
                let k = curr.kind();
                if k == "type_identifier" || k == "scoped_type_identifier" {
                    let is_type_arg = curr.parent().map_or(false, |p| p.kind() == "type_arguments");
                    if !is_type_arg {
                        let type_name = text_of(curr).trim();
                        // 过滤 Java 基础类型与极常见内置类型
                        const BUILTINS: &[&str] = &["int", "long", "boolean", "byte", "short", "float", "double", "char", "void", "String", "Object", "Class"];
                        if !type_name.is_empty() && !BUILTINS.contains(&type_name) && !facts.imports.iter().any(|m| m.spec == type_name && m.line == line_of(curr)) {
                            facts.imports.push(ModuleRef {
                                spec: type_name.to_string(),
                                line: line_of(curr),
                                dynamic: false,
                            });
                        }
                    }
                } else if k != "block" && k != "constructor_body" {
                    let mut cur = curr.walk();
                    for child in curr.named_children(&mut cur) {
                        stack.push(child);
                    }
                }
            }
        } else if n.kind() == "import_declaration" {
            let raw = text_of(n).trim_start_matches("import").trim().trim_end_matches(';').trim();
            let clean = raw.trim_start_matches("static").trim();
            if !clean.is_empty() {
                facts.imports.push(ModuleRef {
                    spec: clean.to_string(),
                    line: line_of(n),
                    dynamic: false,
                });
            }
        } else if n.kind() == "requires_module_directive" || n.kind() == "requires_directive" {
            // 提取 Java 9+ module-info.java 模块描述符指令（requires / exports）
            let mut found_mod = String::new();
            let mut cur = n.walk();
            for child in n.named_children(&mut cur) {
                let k = child.kind();
                if k == "scoped_identifier" || k == "identifier" {
                    let sym = text_of(child).trim();
                    if sym != "java.base" && !sym.is_empty() {
                        found_mod = sym.to_string();
                        break;
                    }
                }
            }
            if found_mod.is_empty() {
                let txt = text_of(n).trim().trim_end_matches(';').trim();
                if txt.starts_with("requires") {
                    let raw = txt.trim_start_matches("requires").trim();
                    let clean = raw.trim_start_matches("transitive").trim().trim_start_matches("static").trim();
                    if !clean.is_empty() && clean != "java.base" {
                        found_mod = clean.to_string();
                    }
                }
            }
            if !found_mod.is_empty() {
                facts.imports.push(ModuleRef {
                    spec: found_mod,
                    line: line_of(n),
                    dynamic: false,
                });
            }
        } else if n.kind() == "module_declaration" {
            let mut cur = n.walk();
            for child in n.named_children(&mut cur) {
                if child.kind() == "scoped_identifier" || child.kind() == "identifier" {
                    let mod_name = text_of(child).trim();
                    if !mod_name.is_empty() {
                        facts.globals_defined.push(GlobalDef {
                            name: format!("module {}", mod_name),
                            how: "module",
                            line: line_of(n),
                            symbol: None,
                        });
                        break;
                    }
                }
            }
        }
    });
}