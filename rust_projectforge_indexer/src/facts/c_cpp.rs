use tree_sitter::Node;

use crate::facts::types::{dfs, FfiExport, FileFacts, GlobalDef, ModuleRef};
use crate::lang::Lang;

pub fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"'))
        || (s.starts_with('\'') && s.ends_with('\''))
        || (s.starts_with('`') && s.ends_with('`'))
    {
        if s.len() >= 2 {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

pub fn declarator_name<'a>(src: &'a [u8], mut decl: Node) -> Option<String> {
    let text = |n: Node| -> &'a str {
        std::str::from_utf8(&src[n.start_byte()..n.end_byte()]).unwrap_or("")
    };
    loop {
        match decl.kind() {
            "identifier" | "field_identifier" | "type_identifier" | "destructor_name" | "operator_name" | "operator_cast" => {
                let s = text(decl).trim();
                return if s.is_empty() { None } else { Some(s.to_string()) };
            }
            "function_declarator" | "pointer_declarator" | "reference_declarator" | "parenthesized_declarator" => {
                decl = decl.child_by_field_name("declarator")?;
            }
            "qualified_identifier" => {
                let s: String = text(decl).split_whitespace().collect();
                return if s.is_empty() { None } else { Some(s) };
            }
            _ => return None,
        }
    }
}

/// 有界递归收集本地包含的头文件宏定义（深度上限 5，带 visited 防环，完整处理反斜杠延续行）
fn cascade_collect_header_macros(
    header_path: &std::path::Path,
    macro_defs: &mut std::collections::HashMap<String, String>,
    visited: &mut std::collections::HashSet<std::path::PathBuf>,
    depth: usize,
) {
    if depth > 5 || !header_path.is_file() || !visited.insert(header_path.to_path_buf()) {
        return;
    }
    let Ok(bytes) = std::fs::read(header_path) else { return };
    let text = String::from_utf8_lossy(&bytes);
    let parent_dir = header_path.parent();

    // 预处理反斜杠行延续
    let mut raw_lines = Vec::new();
    let mut cur_acc = String::new();
    for line in text.lines() {
        let trimmed_end = line.trim_end();
        if trimmed_end.ends_with('\\') {
            cur_acc.push_str(&trimmed_end[..trimmed_end.len() - 1].trim_end());
            cur_acc.push(' ');
        } else {
            cur_acc.push_str(trimmed_end);
            raw_lines.push(std::mem::take(&mut cur_acc));
        }
    }
    if !cur_acc.is_empty() {
        raw_lines.push(cur_acc);
    }

    for line in raw_lines {
        let trimmed = line.trim();
        if trimmed.starts_with("#define") {
            let rest = trimmed["#define".len()..].trim_start();
            let mut parts = rest.split_whitespace();
            if let Some(raw_name) = parts.next() {
                let macro_name = raw_name.split('(').next().unwrap_or("").trim().to_string();
                if !macro_name.is_empty() {
                    macro_defs.entry(macro_name).or_insert_with(|| trimmed.to_string());
                }
            }
        } else if trimmed.starts_with("#include") {
            let rest = trimmed["#include".len()..].trim();
            if (rest.starts_with('"') && rest.ends_with('"')) || (rest.starts_with('<') && rest.ends_with('>')) {
                let spec = unquote(rest);
                if let Some(dir) = parent_dir {
                    let cand = dir.join(&spec);
                    cascade_collect_header_macros(&cand, macro_defs, visited, depth + 1);
                }
            }
        }
    }
}

/// 纯净 C/C++ 语言事实提取器（微内核解耦）
pub fn extract_c_cpp_facts(
    lang: Lang,
    source: &str,
    root: Node,
    facts: &mut FileFacts,
    file_path: Option<&std::path::Path>,
) {
    let src_bytes = source.as_bytes();
    let line_of = |n: Node| -> usize { n.start_position().row + 1 };
    let text_of = |n: Node| -> &str {
        std::str::from_utf8(&src_bytes[n.start_byte()..n.end_byte()]).unwrap_or("")
    };

    // 1. 预处理宏定义收集与级联展开器
    let mut macro_defs: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    // 1.1 若存在宿主文件路径，按 #include 级联优先预热本地头文件的宏词典
    if let Some(cur_file) = file_path {
        if let Some(cur_dir) = cur_file.parent() {
            let mut visited = std::collections::HashSet::new();
            visited.insert(cur_file.to_path_buf());
            for line in source.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("#include") {
                    let rest = trimmed["#include".len()..].trim();
                    if rest.starts_with('"') && rest.ends_with('"') {
                        let spec = unquote(rest);
                        let cand = cur_dir.join(&spec);
                        cascade_collect_header_macros(&cand, &mut macro_defs, &mut visited, 1);
                    }
                }
            }
        }
    }

    // 1.2 收集当前源文件自身的预处理宏定义（覆盖或增量扩充）
    let mut cur = root.walk();
    for child in root.named_children(&mut cur) {
        if child.kind() == "preproc_def" || child.kind() == "preproc_function_def" {
            if let Some(name_node) = child.child_by_field_name("name") {
                let macro_name = text_of(name_node).trim().to_string();
                let raw_txt = text_of(child);
                macro_defs.insert(macro_name, raw_txt.to_string());
            }
        }
    }
    let is_export_macro = |name: &str| -> bool {
        let mut cur_name = name.to_string();
        let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
        visited.insert(cur_name.clone());
        for _ in 0..10 {
            if let Some(body) = macro_defs.get(&cur_name) {
                if body.contains("\"C\"") || body.contains("dllexport") || body.contains("visibility") {
                    return true;
                }
                let mut found_next = false;
                for other in macro_defs.keys() {
                    if other != &cur_name && body.contains(other) && !visited.contains(other) {
                        visited.insert(other.clone());
                        cur_name = other.clone();
                        found_next = true;
                        break;
                    }
                }
                if !found_next { break; }
            } else { break; }
        }
        false
    };

    // 策略 A：X-Macro 列表生成宏展开
    for (table_name, table_def) in &macro_defs {
        if let Some(p_start) = table_def.find('(') {
            if let Some(p_end) = table_def.find(')') {
                let table_param = table_def[p_start + 1..p_end].trim();
                let pat = format!("{}(", table_name);
                let mut search_from = 0;
                while let Some(call_pos) = source[search_from..].find(&pat) {
                    let abs_call = search_from + call_pos;
                    search_from = abs_call + pat.len();
                    let line_start = source[..abs_call].rfind('\n').map(|p| p + 1).unwrap_or(0);
                    let line_prefix = source[line_start..abs_call].trim_start();
                    if line_prefix.starts_with("#define") || line_prefix.starts_with("//") { continue; }
                    let before_text = &source[..abs_call];
                    if let Some(last_block_start) = before_text.rfind("/*") {
                        if !before_text[last_block_start..].contains("*/") {
                            continue;
                        }
                    }
                    if let Some(close_pos) = source[abs_call..].find(')') {
                        let arg_raw = source[abs_call + pat.len()..abs_call + close_pos].trim();
                        let action_name = arg_raw.split(',').next().unwrap_or("").trim();
                        if let Some(action_def) = macro_defs.get(action_name) {
                            if action_def.contains("\"C\"") || action_def.contains("dllexport") || is_export_macro(action_name) {
                                let prefix = if let Some(idx) = action_def.find("##") {
                                    let before = &action_def[..idx];
                                    before.split_whitespace().last().unwrap_or("").trim()
                                } else { "" };
                                for line in table_def.lines() {
                                    let trimmed = line.trim().trim_end_matches('\\').trim();
                                    if trimmed.starts_with("#define") { continue; }
                                    if let Some(s_paren) = trimmed.find('(') {
                                        if let Some(e_paren) = trimmed.rfind(')') {
                                            let args_str = &trimmed[s_paren + 1..e_paren];
                                            let first_arg = args_str.split(',').next().unwrap_or("").trim();
                                            if !first_arg.is_empty() && first_arg != table_param && first_arg.chars().all(|c| c.is_alphanumeric() || c == '_') {
                                                let final_sym = format!("{}{}", prefix, first_arg);
                                                let line_num = source[..abs_call].matches('\n').count() + 1;
                                                facts.ffi_exports.push(FfiExport {
                                                    name: final_sym,
                                                    line: line_num,
                                                    lang: lang.name(),
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 策略 B：实参位置声明宏嵌套展开
    // 策略 B：实参位置声明宏嵌套展开（已接入 is_export_macro 递归展开引擎）
    for (macro_name, def) in &macro_defs {
        if def.contains("##") {
            // 只要定义体自身或其引用的前置宏蕴含 C-ABI / 导出语义，即确立为导出生成宏
            let has_export_semantic = def.contains("\"C\"")
                || def.contains("dllexport")
                || is_export_macro(macro_name)
                || def.split_whitespace().any(|tok| {
                    let clean_tok = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    !clean_tok.is_empty() && is_export_macro(clean_tok)
                });

            if has_export_semantic {
                let call_pat = format!("{}(", macro_name);
                let mut search_idx = 0;
                while let Some(pos) = source[search_idx..].find(&call_pat) {
                    let abs_pos = search_idx + pos;
                    search_idx = abs_pos + call_pat.len();
                    let line_start = source[..abs_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
                    let line_prefix = source[line_start..abs_pos].trim_start();
                    if line_prefix.starts_with("#define") || line_prefix.starts_with("//") { continue; }
                    let before_text = &source[..abs_pos];
                    if let Some(last_block_start) = before_text.rfind("/*") {
                        if !before_text[last_block_start..].contains("*/") {
                            continue;
                        }
                    }
                    if let Some(end_paren) = source[abs_pos + call_pat.len()..].find(')') {
                        let inner_arg = source[abs_pos + call_pat.len()..abs_pos + call_pat.len() + end_paren].trim();
                        let call_args: Vec<&str> = inner_arg.split(',').map(|s| s.trim()).collect();

                        // 提取宏形参列表，如 BIND_SYS_CALL(prefix, name)
                        let mut param_names = Vec::new();
                        if let Some(p_start) = def.find('(') {
                            if let Some(p_end) = def.find(')') {
                                if p_end > p_start {
                                    param_names = def[p_start + 1..p_end].split(',').map(|s| s.trim()).collect();
                                }
                            }
                        }

                        let full_sym = if !param_names.is_empty() {
                            // 代入形参并执行 ## 词法拼接
                            let body_part = if let Some(p_end) = def.find(')') {
                                def[p_end + 1..].trim()
                            } else {
                                def.as_str()
                            };
                            let mut subst = body_part.to_string();
                            for (idx, p) in param_names.iter().enumerate() {
                                if *p != "..." && *p != "__VA_ARGS__" && idx < call_args.len() {
                                    subst = subst.replace(p, call_args[idx]);
                                }
                            }
                            let mut sym = String::new();
                            for tok in subst.split_whitespace() {
                                if tok.contains("##") {
                                    let before_paren = tok.split('(').next().unwrap_or("").trim();
                                    let clean: String = before_paren
                                        .replace("##", "")
                                        .trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
                                        .to_string();
                                    if !clean.is_empty() {
                                        sym = clean;
                                        break;
                                    }
                                }
                            }
                            if sym.is_empty() {
                                let prefix = if let Some(idx) = def.find("##") {
                                    let before = &def[..idx];
                                    before.split_whitespace().last().unwrap_or("").trim()
                                } else { "" };
                                let sym_token = call_args.first().copied().unwrap_or("");
                                format!("{}{}", prefix, sym_token)
                            } else {
                                sym
                            }
                        } else {
                            let prefix = if let Some(idx) = def.find("##") {
                                let before = &def[..idx];
                                before.split_whitespace().last().unwrap_or("").trim()
                            } else { "" };
                            let sym_token = call_args.first().copied().unwrap_or("");
                            format!("{}{}", prefix, sym_token)
                        };

                        if !full_sym.is_empty() && full_sym.chars().all(|c| c.is_alphanumeric() || c == '_') {
                            let line_num = source[..abs_pos].matches('\n').count() + 1;
                            if !facts.ffi_exports.iter().any(|e| e.name == full_sym) {
                                facts.ffi_exports.push(FfiExport {
                                    name: full_sym,
                                    line: line_num,
                                    lang: lang.name(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. 遍历 AST 提取头文件包含与 FFI 声明
    dfs(root, |n| {
        // 顶层宏调用展开（例如 MACRO_C(triple_macro_export);）
        if (n.kind() == "call_expression" || n.kind() == "expression_statement") && n.parent().map_or(false, |p| p.kind() == "translation_unit") {
            let call_node = if n.kind() == "expression_statement" {
                n.child(0).unwrap_or(n)
            } else {
                n
            };
            if call_node.kind() == "call_expression" {
                if let Some(func_node) = call_node.child_by_field_name("function") {
                    let fn_name = text_of(func_node).trim();
                    if is_export_macro(fn_name) {
                        if let Some(args_node) = call_node.child_by_field_name("arguments") {
                            let mut cur_a = args_node.walk();
                            for arg in args_node.named_children(&mut cur_a) {
                                let export_sym = text_of(arg).trim();
                                if !export_sym.is_empty() && !matches!(export_sym, "void" | "int" | "char" | "bool") {
                                    facts.ffi_exports.push(FfiExport {
                                        name: export_sym.to_string(),
                                        line: line_of(n),
                                        lang: lang.name(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        let k = n.kind();
        if k == "preproc_include" {
            if let Some(path_node) = n.child_by_field_name("path") {
                facts.imports.push(ModuleRef {
                    spec: unquote(text_of(path_node)),
                    line: line_of(n),
                    dynamic: false,
                });
            }
        } else if k == "module_import_declaration" || (k == "export_declaration" && text_of(n).trim_start().starts_with("export import")) {
            let txt = text_of(n).trim().trim_end_matches(';').trim();
            let raw = if let Some(idx) = txt.find("import") {
                txt[idx + 6..].trim()
            } else {
                txt
            };
            let clean = raw.trim();
            if !clean.is_empty() {
                facts.imports.push(ModuleRef {
                    spec: clean.to_string(),
                    line: line_of(n),
                    dynamic: false,
                });
            }
        } else if k == "module_declaration" || (k == "export_declaration" && text_of(n).trim_start().starts_with("export module")) {
            let txt = text_of(n).trim().trim_end_matches(';').trim();
            if let Some(idx) = txt.find("module") {
                let mod_name = txt[idx + 6..].trim();
                if !mod_name.is_empty() {
                    facts.globals_defined.push(GlobalDef {
                        name: mod_name.to_string(),
                        how: "module",
                        line: line_of(n),
                        symbol: None,
                    });
                }
            }
        } else if k == "linkage_specification" || k == "function_definition" || k == "declaration" {
            // C++ 链接性规范与类/结构体及偏特化静态导出穿透
            let mut is_dead = false;
            let mut p_opt = n.parent();
            while let Some(p) = p_opt {
                if p.kind() == "preproc_if" || p.kind() == "preproc_elif" {
                    let head = text_of(p).lines().next().unwrap_or("");
                    if head.contains("#if 0") || head.contains("#elif 0") {
                        is_dead = true;
                        break;
                    }
                }
                p_opt = p.parent();
            }
            if is_dead {
                return;
            }

            // 遇到独立函数定义且内含 extern "C" 或包含任何前置导出宏标识符（如 MAKE_C_LINKAGE [[nodiscard]] auto vcp_async_poll...）
            let has_c_linkage = (text_of(n).contains("extern") && text_of(n).contains("\"C\""))
                || text_of(n).split_whitespace().any(|tok| {
                    let clean = tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '_');
                    !clean.is_empty() && is_export_macro(clean)
                });
            if (k == "function_definition" || k == "declaration") && has_c_linkage {
                let mut decl_names = Vec::new();
                let mut stack = vec![n];
                while let Some(curr) = stack.pop() {
                    if curr.kind() == "function_declarator" {
                        let d = curr.child_by_field_name("declarator").unwrap_or(curr);
                        if let Some(name) = declarator_name(src_bytes, d) {
                            if !matches!(name.as_str(), "void" | "int" | "char" | "bool" | "float" | "double" | "auto") && !decl_names.contains(&name) {
                                decl_names.push(name);
                            }
                        }
                    }
                    let mut c = curr.walk();
                    for k in curr.named_children(&mut c) {
                        stack.push(k);
                    }
                }
                for name in decl_names {
                    facts.ffi_exports.push(FfiExport {
                        name,
                        line: line_of(n),
                        lang: lang.name(),
                    });
                }
            }
            let txt = text_of(n);
            if k == "linkage_specification" && txt.contains("\"C\"") {
                let mut raw_decls = Vec::new();
                let mut cur = n.walk();
                for child in n.named_children(&mut cur) {
                    if child.kind() == "declaration_list" {
                        let mut c2 = child.walk();
                        for d in child.named_children(&mut c2) {
                            raw_decls.push(d);
                        }
                    } else {
                        raw_decls.push(child);
                    }
                }
                for child in raw_decls {
                    if child.kind() == "type_definition" {
                        continue;
                    }
                    if child.kind() == "function_definition" || child.kind() == "declaration" || child.kind() == "ERROR" {
                        if text_of(child).trim_start().starts_with("typedef") {
                            continue;
                        }
                        let mut decl_names = Vec::new();
                        let mut cur_child = child.walk();
                        for sub in child.named_children(&mut cur_child) {
                            if sub.kind() == "function_declarator" {
                                let d = sub.child_by_field_name("declarator").unwrap_or(sub);
                                if let Some(name) = declarator_name(src_bytes, d) {
                                    if !matches!(name.as_str(), "void" | "int" | "char" | "bool" | "float" | "double") && !decl_names.contains(&name) {
                                        decl_names.push(name);
                                    }
                                }
                            } else if sub.kind() == "pointer_declarator" || sub.kind() == "attributed_declarator" {
                                if let Some(name) = declarator_name(src_bytes, sub) {
                                    if !matches!(name.as_str(), "void" | "int" | "char" | "bool" | "float" | "double") && !decl_names.contains(&name) {
                                        decl_names.push(name);
                                    }
                                }
                            }
                        }
                        if let Some(d) = child.child_by_field_name("declarator") {
                            if let Some(name) = declarator_name(src_bytes, d) {
                                if !matches!(name.as_str(), "void" | "int" | "char" | "bool" | "float" | "double") && !decl_names.contains(&name) {
                                    decl_names.push(name);
                                }
                            }
                        }
                        if decl_names.is_empty() {
                            let mut stack = vec![child];
                            while let Some(curr) = stack.pop() {
                                if curr.kind() == "type_definition" || curr.kind() == "struct_specifier" {
                                    continue;
                                }
                                if curr.kind() == "function_declarator" {
                                    let d = curr.child_by_field_name("declarator").unwrap_or(curr);
                                    if let Some(name) = declarator_name(src_bytes, d) {
                                        if !matches!(name.as_str(), "void" | "int" | "char" | "bool" | "float" | "double" | "auto") && !decl_names.contains(&name) {
                                            decl_names.push(name);
                                        }
                                    }
                                }
                                let mut c = curr.walk();
                                for k in curr.named_children(&mut c) {
                                    stack.push(k);
                                }
                            }
                        }
                        for fn_name in decl_names {
                            facts.ffi_exports.push(FfiExport {
                                name: fn_name,
                                line: line_of(child),
                                lang: lang.name(),
                            });
                        }
                    }
                }
            }
        } else if n.kind() == "call_expression" {
            let txt = text_of(n);
            if txt.starts_with("NODE_API_MODULE") || txt.starts_with("NODE_SET_METHOD") {
                if let Some(args) = n.child_by_field_name("arguments") {
                    let mut cur = args.walk();
                    let kids: Vec<Node> = args.named_children(&mut cur).collect();
                    if let Some(first) = kids.first() {
                        let name = unquote(text_of(*first));
                        if !name.is_empty() {
                            facts.ffi_exports.push(FfiExport {
                                name,
                                line: line_of(n),
                                lang: "napi",
                            });
                        }
                    }
                }
            }
        }
    });
}