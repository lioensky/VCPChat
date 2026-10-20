//! Static SFC container extraction, not a Vue/Svelte compiler. Only inline,
//! top-level JS/TS scripts are indexed; no imports, preprocessors or src fetches.
//! Each script is parsed independently so even broken syntax cannot borrow a
//! closing brace from markup, CSS or another script. Coordinates remain those
//! of the normalized original component, not of a concatenated virtual file.
use crate::lang::Lang;
use crate::symbols::{self, Outline};
use std::collections::HashMap;
use tree_sitter::Parser;

struct Tag {
    name: String,
    attrs: HashMap<String, String>,
    end: usize,
    closing: bool,
    empty: bool,
    dynamic_attrs: bool,
}

fn space(b: u8) -> bool { b.is_ascii_whitespace() }
fn name(b: u8) -> bool { b.is_ascii_alphanumeric() || matches!(b, b'-' | b':' | b'_' | b'.') }

fn expression_end(source: &str, mut i: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    // Svelte closing block directives contain no JavaScript expression.
    if bytes.get(i + 1) == Some(&b'/') {
        let mut end = i + 2;
        while bytes.get(end).is_some_and(|b| b.is_ascii_alphabetic()) { end += 1; }
        if bytes.get(end) == Some(&b'}') { return Some(end + 1); }
    }
    let mut depth = 1usize;
    let mut quote = 0u8;
    let mut can_regex = true;
    let mut member_name = false;
    i += 1;
    while i < bytes.len() {
        let b = bytes[i];
        if quote != 0 {
            if b == b'\\' { i = (i + 2).min(bytes.len()); continue; }
            if b == quote { quote = 0; can_regex = false; }
        } else if bytes.get(i..i + 2) == Some(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' { i += 1; }
            continue;
        } else if bytes.get(i..i + 2) == Some(b"/*") {
            i += 2;
            while bytes.get(i..i + 2) != Some(b"*/") { bytes.get(i)?; i += 1; }
            i += 2; continue;
        } else if matches!(b, b'\'' | b'"' | b'`') { quote = b; member_name = false; }
        else if b == b'/' && can_regex {
            // A regex's braces/quotes/tags are data, not container structure.
            i += 1;
            let mut class = false;
            loop {
                let c = *bytes.get(i)?;
                if c == b'\n' || c == b'\r' { return None; }
                if c == b'\\' { bytes.get(i + 1)?; i += 2; continue; }
                if c == b'[' { class = true; }
                if c == b']' { class = false; }
                if c == b'/' && !class { break; }
                i += 1;
            }
            can_regex = false;
            member_name = false;
        } else if b >= 0x80 && source.get(i..)?.chars().next().is_some_and(|c| c.is_whitespace() || c == '\u{feff}') {
            // Preserve token state across non-ASCII JavaScript whitespace.
            i += source.get(i..)?.chars().next()?.len_utf8();
            continue;
        } else if b.is_ascii_alphabetic() || b == b'_' || b == b'$' || b >= 0x80 {
            let start = i;
            // Keep Unicode names (including combining marks) opaque as one
            // token. This scanner finds container boundaries, not JS validity.
            while let Some(c) = source.get(i..)?.chars().next() {
                if !(c.is_ascii_alphanumeric() || matches!(c, '_' | '$') ||
                    (!c.is_ascii() && !c.is_whitespace() && c != '\u{feff}')) { break; }
                i += c.len_utf8();
            }
            // Reserved words are still ordinary names after member access,
            // e.g. state.return / 2 or state?.throw / 2.
            can_regex = !member_name && matches!(&bytes[start..i], b"return" | b"throw" | b"yield" | b"case" | b"typeof" | b"void" | b"delete" | b"new" | b"in" | b"of" | b"await");
            member_name = false;
            continue;
        } else if bytes.get(i..i + 3) == Some(b"...") {
            member_name = false;
            can_regex = true;
            i += 3;
            continue;
        } else if b == b'.' || bytes.get(i..i + 2) == Some(b"?.") {
            member_name = !can_regex;
            i += if b == b'?' { 2 } else { 1 };
            continue;
        } else if matches!(b, b'+' | b'-') && bytes.get(i + 1) == Some(&b) {
            // Prefix updates still expect an operand; postfix updates end a
            // value. Preserve that distinction rather than treating each sign
            // as a binary operator that permits a following regex literal.
            member_name = false;
            i += 2;
            continue;
        } else if b == b'{' { depth += 1; can_regex = true; member_name = false; }
        else if b == b'}' { depth -= 1; if depth == 0 { return Some(i + 1); } can_regex = false; member_name = false; }
        else if !space(b) { can_regex = !b.is_ascii_digit() && !matches!(b, b')' | b']'); member_name = false; }
        i += 1;
    }
    None
}

// Quote-aware tag/attribute parsing. Dynamic attributes are deliberately not
// guessed: an ambiguous script opening is an error, never executable input.
fn tag(source: &str, start: usize, svelte_syntax: bool) -> Option<Tag> {
    let bytes = source.as_bytes();
    let mut i = start + 1;
    let closing = bytes.get(i) == Some(&b'/');
    if closing { i += 1; }
    let a = i;
    while bytes.get(i).is_some_and(|&b| name(b)) { i += 1; }
    if i == a { return None; }
    let tag_name = String::from_utf8_lossy(&bytes[a..i]).to_ascii_lowercase();
    let mut attrs = HashMap::new();
    let mut dynamic_attrs = false;
    loop {
        while bytes.get(i).is_some_and(|&b| space(b)) { i += 1; }
        if bytes.get(i) == Some(&b'>') {
            return Some(Tag { name: tag_name, attrs, end: i + 1, closing, empty: false, dynamic_attrs });
        }
        if bytes.get(i..i + 2) == Some(b"/>") {
            return Some(Tag { name: tag_name, attrs, end: i + 2, closing, empty: true, dynamic_attrs });
        }
        if closing { return None; }
        if bytes.get(i) == Some(&b'{') {
            if !svelte_syntax { return None; }
            i = expression_end(source, i)?;
            dynamic_attrs = true;
            continue;
        }
        let a = i;
        while bytes.get(i).is_some_and(|&b| !space(b) && !matches!(b, b'=' | b'/' | b'>' | b'<' | b'\'' | b'"' | b'{' | b'}')) { i += 1; }
        if i == a { return None; }
        let key = String::from_utf8_lossy(&bytes[a..i]).to_ascii_lowercase();
        while bytes.get(i).is_some_and(|&b| space(b)) { i += 1; }
        let mut value = String::new();
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while bytes.get(i).is_some_and(|&b| space(b)) { i += 1; }
            let quote = *bytes.get(i)?;
            let a;
            if matches!(quote, b'\'' | b'"') {
                i += 1; a = i;
                while *bytes.get(i)? != quote { i += 1; }
                value = String::from_utf8_lossy(&bytes[a..i]).into_owned();
                i += 1;
            } else if quote == b'{' {
                if !svelte_syntax { return None; }
                let end = expression_end(source, i)?;
                value = String::from_utf8_lossy(&bytes[i..end]).into_owned();
                i = end;
            } else {
                a = i;
                while bytes.get(i).is_some_and(|&b| !space(b) && b != b'>') {
                    if matches!(bytes[i], b'<' | b'{' | b'\'' | b'"' | b'`' | b'=') { return None; }
                    i += 1;
                }
                if i == a { return None; }
                value = String::from_utf8_lossy(&bytes[a..i]).into_owned();
            }
        }
        if attrs.insert(key, value).is_some() { return None; }
    }
}

fn raw_end(source: &str, mut i: usize, expected: &str) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    // HTML raw-text closing semantics: a literal </script> ends the element,
    // even inside a JS string. Escaped <\/script> does not. No code execution.
    while i < bytes.len() {
        if bytes.get(i..i + 2) == Some(b"</") {
            if let Some(t) = tag(source, i, false) {
                if t.closing && t.name == expected { return Some((i, t.end)); }
            }
        }
        i += 1;
    }
    None
}

fn script_lang(t: &Tag) -> Option<Lang> {
    if t.dynamic_attrs || t.attrs.contains_key("src") { return None; }
    let lang = t.attrs.get("lang").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    let kind = t.attrs.get("type").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    if !matches!(kind.as_str(), "" | "module" | "text/javascript" | "application/javascript" | "text/ecmascript" | "application/ecmascript") { return None; }
    match lang.as_str() {
        "" | "js" | "javascript" => Some(Lang::JavaScript),
        "ts" | "typescript" => Some(Lang::TypeScript),
        _ => None,
    }
}

pub fn outline(raw: &str, language: &'static str) -> Outline {
    let source = symbols::normalize_source(raw);
    let bytes = source.as_bytes();
    let mut out = Outline { lang: language, has_error: false,
        line_count: source.lines().count(), symbols: Vec::new() };
    let mut parser = Parser::new();
    let mut stack: Vec<String> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes.get(i..i + 4) == Some(b"<!--") {
            if let Some(end) = source[i + 4..].find("-->") { i += 4 + end + 3; continue; }
            out.has_error = true; break;
        }
        // Interpolation is opaque markup. Skip strings and balanced braces so
        // a quoted <script> cannot become a top-level script declaration.
        // Vue uses double mustaches; a lone brace is ordinary template text.
        if bytes[i] == b'{' && (language == "svelte" || bytes.get(i + 1) == Some(&b'{')) {
            let Some(end) = expression_end(&source, i) else { out.has_error = true; break; };
            if matches!(bytes.get(i + 1), Some(b'#' | b'/')) {
                if language != "svelte" { out.has_error = true; break; }
                let mut name_end = i + 2;
                while bytes.get(name_end).is_some_and(|b| b.is_ascii_alphabetic()) { name_end += 1; }
                let block = String::from_utf8_lossy(&bytes[i + 2..name_end]);
                let marker = format!("#{block}");
                if bytes[i + 1] == b'#' {
                    if !matches!(block.as_ref(), "if" | "each" | "await" | "key" | "snippet") { out.has_error = true; break; }
                    stack.push(marker);
                } else if stack.pop().as_deref() != Some(&marker) { out.has_error = true; break; }
            }
            i = end;
            continue;
        }
        if bytes[i] != b'<' { i += 1; continue; }
        let Some(t) = tag(&source, i, language == "svelte") else { out.has_error = true; break; };
        if t.closing {
            if stack.pop().as_deref() != Some(&t.name) { out.has_error = true; break; }
            i = t.end; continue;
        }
        if t.name == "script" || t.name == "style" || t.name == "textarea" || t.name == "title" {
            if t.empty { out.has_error = true; i = t.end; continue; }
            let Some((end, after)) = raw_end(&source, t.end, &t.name) else { out.has_error = true; break; };
            if stack.is_empty() && t.name == "script" {
                if let Some(lang) = script_lang(&t) {
                    match symbols::outline(lang, &source[t.end..end], &mut parser) {
                        Ok(mut script) => {
                            out.has_error |= script.has_error;
                            let line_offset = bytes[..t.end].iter().filter(|&&b| b == b'\n').count();
                            let parent_offset = out.symbols.len();
                            // The existing edit protocol is line-based. A symbol
                            // sharing its first/last line with a container tag
                            // cannot be safely edited without deleting markup.
                            let first_line_is_partial = !source[..t.end].rsplit('\n').next().unwrap_or("").trim().is_empty();
                            let last_line_is_partial = !source[end..].split('\n').next().unwrap_or("").trim().is_empty();
                            let last_body_line = source[t.end..end].matches('\n').count() + 1;
                            let unsafe_rows: Vec<_> = script.symbols.iter().map(|s|
                                (first_line_is_partial && s.full_start == 1) ||
                                (last_line_is_partial && s.end == last_body_line)).collect();
                            if unsafe_rows.iter().any(|v| *v) {
                                // Do not leave dangling parent indices after
                                // filtering individual symbols: reject this block.
                                out.has_error = true;
                                i = after;
                                continue;
                            }
                            for s in &mut script.symbols {
                                s.start += line_offset; s.end += line_offset; s.full_start += line_offset;
                                if let Some(p) = &mut s.parent { *p += parent_offset; }
                            }
                            out.symbols.extend(script.symbols);
                        }
                        Err(_) => out.has_error = true,
                    }
                } else { out.has_error = true; }
            }
            i = after; continue;
        }
        if !t.empty && !matches!(t.name.as_str(), "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta" | "param" | "source" | "track" | "wbr") {
            stack.push(t.name);
        }
        i = t.end;
    }
    out.has_error |= !stack.is_empty();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ranges(o: &Outline) -> Vec<(&str, usize, usize, usize, Option<usize>)> {
        o.symbols.iter().map(|s| (s.name.as_str(), s.start, s.end, s.full_start, s.parent)).collect()
    }
    #[test]
    fn markup_and_styles_cannot_produce_symbols_or_extend_script_ranges() {
        let src = "<template><div class=card>{{ title }}</div></template>\n<script setup>\nfunction setupView() {\n  return 42;\n}\n</script>\n<style>\n.card { color: red; }\n</style>\n";
        for lang in ["vue", "svelte"] {
            let o = outline(src, lang);
            assert!(!o.has_error);
            assert_eq!(o.lang, lang);
            assert_eq!(o.line_count, 9);
            assert_eq!(ranges(&o), [("setupView", 3, 5, 3, None)]);
        }
    }
    #[test]
    fn multiple_typed_scripts_keep_original_lines_and_independent_parents() {
        let src = "\u{feff}<script lang='ts' setup data-note='>'>\r\n// 文档\r\nfunction first(x: number) {\r\n function nested() {}\r\n}\r\n</script>\r\n<div>你好</div>\r\n<script context=module>\r\nfunction second() { function child() {} }\r\n</script>";
        let o = outline(src, "svelte");
        assert!(!o.has_error);
        assert_eq!(o.line_count, 10);
        assert_eq!(ranges(&o), [("first", 3, 5, 2, None), ("nested", 4, 4, 4, Some(0)), ("second", 9, 9, 9, None), ("child", 9, 9, 9, Some(2))]);
    }
    #[test]
    fn comments_attributes_interpolations_and_nested_scripts_are_not_declarations() {
        let src = "<!-- <script>function fake() {}</script> -->\n<template><div @click='run()' title='<script>bad</script>'>{{ '<script>fake</script>' }}</div><script>function nested() {}</script></template>\n{{ '<script>function ghost() {}</script>' }}\n<script>\nfunction real() { const text = '<script>'; }\n</script>";
        let o = outline(src, "vue");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("real", 5, 5, 5, None)]);
    }
    #[test]
    fn absent_or_external_scripts_never_fall_back_to_whole_file_geometry() {
        for src in ["", "function bare() {}", "<style>.card { color: red; }</style>", "<template><p>{{ title }}</p></template>"] {
            let o = outline(src, "vue"); assert!(!o.has_error); assert!(o.symbols.is_empty());
        }
        for src in ["<script src='./not-read.js'></script>", "<script lang=coffee>fake()</script>", "<script type=application/json>{}</script>"] {
            let o = outline(src, "vue"); assert!(o.has_error); assert!(o.symbols.is_empty());
        }
    }
    #[test]
    fn malformed_containers_and_scripts_are_reported_without_cross_block_healing() {
        for src in ["<script>function broken() {", "<!-- <script>", "<script lang='ts>function broken() {}</script>", "<script lang=js lang=ts></script>"] {
            let o = outline(src, "vue"); assert!(o.has_error); assert!(o.symbols.is_empty());
        }
        let o = outline("<script>\nfunction broken() {\n</script>\n<style>.fake { color:red; }</style>\n<script>\nfunction next() {}\n</script>", "vue");
        assert!(o.has_error);
        assert!(o.symbols.iter().all(|s| s.end == s.start));
        assert!(o.symbols.iter().any(|s| s.name == "next" && s.start == 6 && s.parent.is_none()));
    }
    #[test]
    fn line_based_edits_never_include_container_tags() {
        for src in ["<script>function inline() {}</script>", "<script>function first() {}\n</script>", "<script>\nfunction last() {}</script>"] {
            let o = outline(src, "vue"); assert!(o.has_error); assert!(o.symbols.is_empty());
        }
    }
    #[test]
    fn dynamic_markup_attributes_and_comment_literals_remain_opaque() {
        let src = "<button onclick={() => { /* <script>fake</script> */ return '<script>'; }}>Hello</button>\n<script>\nfunction real() {}\n</script>";
        let o = outline(src, "svelte");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("real", 3, 3, 3, None)]);
    }
    #[test]
    fn regex_braces_and_quotes_cannot_promote_interpolated_script_text() {
        let src = "{ /}/.test(value) ? '<script>\\nfunction fake() {}\\n</script>' : null }\n<script>\nfunction real() {}\n</script>";
        let o = outline(src, "svelte");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("real", 3, 3, 3, None)]);
        let o = outline("{ total / count }\n<script>\nfunction ratio() {}\n</script>", "svelte");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("ratio", 3, 3, 3, None)]);
    }
    #[test]
    fn svelte_block_scopes_cannot_create_top_level_scripts() {
        let src = "{#if ready}\n<script>\nfunction nested() {}\n</script>\n{/if}\n<script>\nfunction real() {}\n</script>";
        let o = outline(src, "svelte");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("real", 7, 7, 7, None)]);
    }
    #[test]
    fn svelte_shorthand_and_spread_attributes_do_not_hide_later_scripts() {
        let src = "<div {active}></div>\n<Widget {...props} />\n<script>\nfunction real() {}\n</script>";
        let o = outline(src, "svelte");
        assert!(!o.has_error);
        assert_eq!(ranges(&o), [("real", 4, 4, 4, None)]);
        let o = outline("<script {...props}>\nfunction unknown() {}\n</script>", "svelte");
        assert!(o.has_error); assert!(o.symbols.is_empty());
        let o = outline("<div {...props>\n<script>\nfunction unknown() {}\n</script>", "svelte");
        assert!(o.has_error); assert!(o.symbols.is_empty());
    }
    #[test]
    fn vue_does_not_accept_svelte_only_container_syntax() {
        for prefix in ["<div {active}></div>", "<Widget {...props} />", "<button onclick={handler}></button>"] {
            let o = outline(&format!("{prefix}\n<script>\nfunction later() {{}}\n</script>"), "vue");
            assert!(o.has_error, "{prefix}");
            assert!(o.symbols.is_empty(), "{prefix}");
        }
    }
    #[test]
    fn svelte_update_operators_keep_division_and_regex_boundaries_distinct() {
        for expression in [
            "() => count++ / 2", "() => count-- / 2",
            "() => (count)++ / 2", "() => state.count-- / 2",
            "() => ++count / 2", "() => --count / 2",
            "() => count++ / 2 / 3", "() => (count++) / 2",
            "() => count++ + /[}<]/.test(text)",
            "() => count-- - /[}<]/.test(text)",
        ] {
            let src = format!("<button onclick={{{expression}}}></button>\n<script>\nfunction real() {{}}\n</script>");
            let o = outline(&src, "svelte");
            assert!(!o.has_error, "{expression}");
            assert_eq!(ranges(&o), [("real", 3, 3, 3, None)], "{expression}");
        }
    }
    #[test]
    fn update_operator_fix_does_not_accept_broken_container_expressions() {
        for expression in ["() => count++ + /unterminated", "() => { count-- / 2"] {
            let src = format!("<button onclick={{{expression}}}></button>\n<script>\nfunction hidden() {{}}\n</script>");
            let o = outline(&src, "svelte");
            assert!(o.has_error, "{expression}");
            assert!(o.symbols.is_empty(), "{expression}");
        }
    }
    #[test]
    fn svelte_identifier_and_member_names_end_values_before_division() {
        for expression in [
            "() => state.return / 2", "() => state.throw / 2",
            "() => state?.return / 2", "() => state. /* gap */ return / 2",
            "() => state. // gap\nreturn / 2", "() => 状态.return / 2",
            "() => 数量 / 2", "() => 数量return / 2", "() => value数量 / 2",
            "() => e\u{301} / 2", "() => $数量_2 / 2",
        ] {
            let src = format!("<button onclick={{{expression}}}></button>\n<script>\nfunction real() {{}}\n</script>");
            let o = outline(&src, "svelte");
            assert!(!o.has_error, "{expression}");
            let row = 3 + expression.matches('\n').count();
            assert_eq!(ranges(&o), [("real", row, row, row, None)], "{expression}");
        }
    }
    #[test]
    fn identifier_fix_preserves_keyword_regex_and_malformed_expression_boundaries() {
        for expression in [
            "() => { return /[}<]/.test(value); }",
            "() => { return\u{a0}/[}<]/.test(value); }",
            "() => { return\u{feff}/[}<]/.test(value); }",
            "() => state.return / 2 + /[}<]/.test(value)",
            "() => 数量 / 2 + /[}<]/.test(value)",
        ] {
            let src = format!("<button onclick={{{expression}}}></button>\n<script>\nfunction real() {{}}\n</script>");
            let o = outline(&src, "svelte");
            assert!(!o.has_error, "{expression}");
            assert_eq!(ranges(&o), [("real", 3, 3, 3, None)], "{expression}");
        }
        for expression in ["() => { return /unterminated", "() => { return\u{a0}/unterminated", "() => { return\u{feff}/unterminated", "() => 数量 + /unterminated", "() => { 数量 / 2"] {
            let o = outline(&format!("<button onclick={{{expression}}}></button>\n<script>\nfunction hidden() {{}}\n</script>"), "svelte");
            assert!(o.has_error, "{expression}");
            assert!(o.symbols.is_empty(), "{expression}");
        }
    }
    #[test]
    fn vue_single_braces_are_text_but_double_brace_expressions_stay_opaque() {
        for text in ["{", "}", "text { value", "{#if ready}plain{/if}", "{{ '<script>not code</script>' }}"] {
            let src = format!("<template><code>{text}</code></template>\n<script>\nfunction real() {{}}\n</script>");
            let o = outline(&src, "vue");
            assert!(!o.has_error, "{text}");
            assert_eq!(ranges(&o), [("real", 3, 3, 3, None)], "{text}");
        }
        let o = outline("<p>{</p>\n<script>\nfunction hidden() {}\n</script>", "svelte");
        assert!(o.has_error); assert!(o.symbols.is_empty());
    }
    #[test]
    fn vue_unterminated_mustaches_do_not_expose_later_script_text() {
        for text in ["{{ value", "{{ value }", "{{ 'unterminated }}"] {
            let o = outline(&format!("<template><p>{text}</p></template>\n<script>\nfunction hidden() {{}}\n</script>"), "vue");
            assert!(o.has_error, "{text}");
            assert!(o.symbols.is_empty(), "{text}");
        }
    }
}
