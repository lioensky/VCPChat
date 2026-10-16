//! 几何拱形函数寻址 (Arch-Geometry Function Addressing) 对照实验探针
//! 运行方式: cargo run --release --example geo_probe -- [root_path]

#[allow(dead_code)]
#[path = "../src/lang.rs"]
mod lang;

#[allow(dead_code)]
#[path = "../src/symbols.rs"]
mod symbols;

#[allow(dead_code)]
#[path = "../src/geo.rs"]
mod geo;

use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use ignore::WalkBuilder;
use rayon::prelude::*;
use tree_sitter::Parser;

use lang::{Family, Lang};
use symbols::{normalize_source, outline, Outline};

const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git", ".svn", ".hg",
    "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".hypothesis", ".ipynb_checkpoints",
    ".venv", "venv", "env", ".env", "virtualenv", ".conda",
    ".next", ".nuxt", ".svelte-kit", ".angular", ".parcel-cache", ".turbo", ".vercel", ".cache", ".gradle",
    "dist", "build", "out", "target", "coverage", ".nyc_output",
    ".idea", ".vs", ".vscode-test",
];

const MAX_SCAN_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

fn is_ignored_dir(name: &str, ignored: &HashSet<String>) -> bool {
    let lower = name.to_ascii_lowercase();
    // 实验口径：排除 PR 审查留下的整仓快照（如 PR-345-JENN2046），避免重复计数
    ignored.contains(&lower) || lower.ends_with(".egg-info") || lower.starts_with("pr-")
}

fn collect_files(root: &Path) -> Vec<(PathBuf, Lang)> {
    let ignored: HashSet<String> = DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect();
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |e| {
            if !(e.file_type().is_some_and(|t| t.is_dir()) && e.depth() > 0) {
                return true;
            }
            !(is_ignored_dir(&e.file_name().to_string_lossy(), &ignored)
                || e.path().join("pyvenv.cfg").is_file())
        });

    let mut out = Vec::new();
    for entry in builder.build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(l) = Lang::from_path(entry.path()) else { continue };
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
        }
        if out.len() >= MAX_SCAN_FILES {
            break;
        }
        out.push((entry.into_path(), l));
    }
    out
}

/// 置信度三档
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tier {
    /// 🟢 双账吻合（缩进回落 + 括号/块配平同一行）且拱脚含明确函数/容器特征
    Green,
    /// 🟡 几何区间完整，但拱脚签名模糊（如跨行复杂签名或无明显关键字）
    Yellow,
    /// 🔴 缩进与括号账本冲突，或文件健康度异常
    Red,
}

#[derive(Debug, Clone)]
struct GeoArch {
    /// 拱脚签名起始行（1-based，若有跨行小括号签名则自动上溯到签名首行）
    sig_start: usize,
    /// 起拱左脚行（1-based，即块开启 `{` 或 `:` 所在行）
    foot_line: usize,
    /// 落拱右脚行（1-based）
    end_line: usize,
    /// 向上吸附紧邻等缩进注释后的 full_start（1-based）
    full_start: usize,
    /// 置信度档位
    tier: Tier,
}

#[derive(Debug, Clone)]
struct GeoFileResult {
    healthy: bool,
    /// 独立报警器是否触发（分词状态不可信）
    alarm: bool,
    /// 与 arches 一一对应的拱脚提取名（空串表示未提取到）
    names: Vec<String>,
    arches: Vec<GeoArch>,
}

#[derive(Clone, Copy)]
struct LineMetrics {
    indent: u16,
    non_empty: bool,
    is_comment: bool,
    open_braces: u16,
    close_braces: u16,
    leading_close_braces: u16,
    net_parens: i16,
    ends_with_colon: bool,
    has_decl_hint: bool,
    has_paren: bool,
    starts_with_ctrl: bool,
}

/// 判断一行去掉前导空白后是否以控制流关键字开头（过滤 if/for/while/switch/match/catch/else 等非符号子拱）
#[inline]
fn is_control_flow_head(trimmed: &[u8]) -> bool {
    const CTRLS: &[&[u8]] = &[
        b"if", b"else", b"for", b"while", b"switch", b"case", b"default",
        b"try", b"catch", b"finally", b"match", b"loop", b"do", b"with",
        b"elif", b"except", b"return", b"yield", b"throw", b"break", b"continue",
    ];
    for &kw in CTRLS {
        if trimmed.starts_with(kw) {
            let next = trimmed.get(kw.len()).copied().unwrap_or(b' ');
            if !next.is_ascii_alphanumeric() && next != b'_' {
                return true;
            }
        }
    }
    false
}

/// 快速判断一行是否含函数/方法/类/容器的声明特征（顺手数，零正则）
#[inline]
fn check_decl_hint(trimmed: &[u8], family: Family) -> (bool, bool) {
    let mut has_paren = false;
    let mut has_arrow = false;
    let mut has_assign = false;
    let len = trimmed.len();
    let mut i = 0;
    while i < len {
        let b = trimmed[i];
        if b == b'(' {
            has_paren = true;
        } else if b == b'=' {
            if i + 1 < len && (trimmed[i + 1] == b'>' || trimmed[i + 1] == b'=') {
                if trimmed[i + 1] == b'>' {
                    has_arrow = true;
                }
                i += 1;
            } else {
                has_assign = true;
            }
        }
        i += 1;
    }

    const DECL_KWS: &[&[u8]] = &[
        b"fn", b"pub", b"async", b"function", b"class", b"def", b"struct",
        b"enum", b"impl", b"trait", b"interface", b"type", b"mod", b"namespace",
        b"func", b"local", b"static", b"const", b"let", b"var", b"export",
        b"public", b"private", b"protected", b"internal", b"virtual", b"override",
        b" get ", b" set ",
    ];
    let mut kw_hit = false;
    for &kw in DECL_KWS {
        if trimmed.starts_with(kw) {
            let next = trimmed.get(kw.len()).copied().unwrap_or(b' ');
            if !next.is_ascii_alphanumeric() && next != b'_' {
                kw_hit = true;
                break;
            }
        }
    }
    if !kw_hit {
        // 扫描行内是否包含 ` fn ` / ` function ` / ` class ` / ` def `
        for win in trimmed.windows(4) {
            if win == b" fn " || win == b"def " {
                kw_hit = true;
                break;
            }
        }
    }

    let hint = match family {
        Family::Python => kw_hit,
        _ => kw_hit || has_arrow || (has_paren && !is_control_flow_head(trimmed)) || has_assign,
    };
    (hint, has_paren)
}

/// 单趟字节流扫描：提取每一行的缩进深度与括号/冒号信号，并完成拱形配对
fn scan_geometry(lang: Lang, source: &str) -> GeoFileResult {
    let bytes = source.as_bytes();
    let family = lang.family();
    let is_python = matches!(family, Family::Python);

    // 预估行数
    let est_lines = (bytes.len() / 36).max(32);
    let mut lines: Vec<LineMetrics> = Vec::with_capacity(est_lines);
    // 1-based 索引占位
    lines.push(LineMetrics {
        indent: 0,
        non_empty: false,
        is_comment: false,
        open_braces: 0,
        close_braces: 0,
        leading_close_braces: 0,
        net_parens: 0,
        ends_with_colon: false,
        has_decl_hint: false,
        has_paren: false,
        starts_with_ctrl: false,
    });

    let mut in_block_comment = false;
    let mut in_string: u8 = 0; // 0: 无, b'"', b'\'', b'`'
    let mut in_py_triple: u8 = 0; // Python """ 或 '''
    let mut healthy = true;
    let mut saw_space_indent = false;
    let mut saw_tab_indent = false;
    // 独立报警器：字符串/文档串状态下出现顶格声明行的次数（用原始缩进形状校验分词器）
    let mut swallow_hits = 0usize;
    // 行字节区间（1-based，与 lines 对齐），供拱脚函数名提取
    let mut line_spans: Vec<(usize, usize)> = Vec::with_capacity(est_lines);
    line_spans.push((0, 0));

    let mut line_start = 0usize;
    let n = bytes.len();

    while line_start <= n {
        let mut line_end = line_start;
        while line_end < n && bytes[line_end] != b'\n' {
            line_end += 1;
        }
        let raw_line = &bytes[line_start..line_end];

        // 仅当超长行同时包含大量花括号（真正的 minified 代码行）时才视为不健康；普通长字符串/内联 SVG 不影响缩进拱
        if raw_line.len() > 4000 {
            let brace_cnt = raw_line.iter().filter(|&&b| b == b'{' || b == b'}').count();
            if brace_cnt > 16 {
                healthy = false;
            }
        }

        // 1. 计算前导缩进
        let mut idx = 0;
        let mut indent: u16 = 0;
        let mut has_sp = false;
        let mut has_tb = false;
        while idx < raw_line.len() {
            match raw_line[idx] {
                b' ' => {
                    indent = indent.saturating_add(1);
                    has_sp = true;
                    idx += 1;
                }
                b'\t' => {
                    indent = indent.saturating_add(4);
                    has_tb = true;
                    idx += 1;
                }
                _ => break,
            }
        }
        let trimmed = &raw_line[idx..];
        let non_empty = !trimmed.is_empty();
        if non_empty {
            if has_sp && !has_tb {
                saw_space_indent = true;
            } else if has_tb && !has_sp {
                saw_tab_indent = true;
            }
        }

        // 若处于跨行注释或跨行字符串开头，该行缩进不可作为落拱依据
        let started_in_multiline = in_block_comment || in_string != 0 || in_py_triple != 0;
        if (in_string != 0 || in_py_triple != 0) && indent == 0 && is_top_decl_head(trimmed) {
            swallow_hits += 1;
        }
        line_spans.push((line_start, line_end));

        // 判断是否为整行注释或属性/装饰器（用于 full_start 向上吸附）
        let is_comment = if !non_empty {
            false
        } else if in_block_comment {
            true
        } else {
            trimmed.starts_with(b"//")
                || trimmed.starts_with(b"/*")
                || trimmed.starts_with(b"*")
                || trimmed.starts_with(b"#")
                || trimmed.starts_with(b"@")
                || trimmed.starts_with(b"--")
        };

        let starts_with_ctrl = non_empty && !started_in_multiline && is_control_flow_head(trimmed);
        let (has_decl_hint, has_paren) = if non_empty && !started_in_multiline && !is_comment {
            check_decl_hint(trimmed, family)
        } else {
            (false, false)
        };

        // 2. 扫描行内括号与冒号（跳过字符串和注释）
        let mut open_braces: u16 = 0;
        let mut close_braces: u16 = 0;
        let mut leading_close_braces: u16 = 0;
        let mut seen_code_token = false;
        let mut net_parens: i16 = 0;
        let mut last_non_ws: u8 = 0;

        let mut j = 0;
        let tlen = trimmed.len();
        while j < tlen {
            let c = trimmed[j];
            if in_block_comment {
                if c == b'*' && j + 1 < tlen && trimmed[j + 1] == b'/' {
                    in_block_comment = false;
                    j += 2;
                } else {
                    j += 1;
                }
                continue;
            }
            if in_py_triple != 0 {
                if c == in_py_triple && j + 2 < tlen && trimmed[j + 1] == in_py_triple && trimmed[j + 2] == in_py_triple {
                    in_py_triple = 0;
                    j += 3;
                } else if c == b'\\' {
                    j += 2;
                } else {
                    j += 1;
                }
                continue;
            }
            if in_string != 0 {
                if c == b'\\' {
                    j += 2;
                } else if c == in_string {
                    in_string = 0;
                    j += 1;
                } else {
                    j += 1;
                }
                continue;
            }

            // 行注释
            if c == b'/' && j + 1 < tlen && trimmed[j + 1] == b'/' {
                break;
            }
            if c == b'/' && j + 1 < tlen && trimmed[j + 1] == b'*' {
                in_block_comment = true;
                j += 2;
                continue;
            }
            if is_python && c == b'#' {
                break;
            }
            if matches!(family, Family::Lua) && c == b'-' && j + 1 < tlen && trimmed[j + 1] == b'-' {
                break;
            }

            // JS 族正则字面量：`/` 跟在运算符/分隔符之后（或行首）视为正则，整体跳过（含字符类 [...] 与 flags）
            if matches!(family, Family::Js)
                && c == b'/'
                && matches!(
                    last_non_ws,
                    0 | b'=' | b'(' | b',' | b':' | b';' | b'!' | b'&' | b'|' | b'?' | b'{' | b'}' | b'[' | b'+' | b'-' | b'*' | b'%' | b'~' | b'^'
                )
            {
                let mut k = j + 1;
                let mut in_class = false;
                let mut closed = false;
                while k < tlen {
                    let rc = trimmed[k];
                    if rc == b'\\' {
                        k += 2;
                        continue;
                    }
                    if in_class {
                        if rc == b']' {
                            in_class = false;
                        }
                    } else if rc == b'[' {
                        in_class = true;
                    } else if rc == b'/' {
                        closed = true;
                        k += 1;
                        break;
                    }
                    k += 1;
                }
                if closed {
                    while k < tlen && trimmed[k].is_ascii_alphabetic() {
                        k += 1;
                    }
                    // 正则整体作为操作数，其后的 `/` 视为除号
                    last_non_ws = b'r';
                    seen_code_token = true;
                    j = k;
                    continue;
                }
            }

            // 字符串开启
            if is_python && (c == b'"' || c == b'\'') && j + 2 < tlen && trimmed[j + 1] == c && trimmed[j + 2] == c {
                in_py_triple = c;
                j += 3;
                continue;
            }
            if c == b'"' || c == b'\'' || (matches!(family, Family::Js | Family::Go) && c == b'`') {
                // Rust 生命周期 'a 不算字符串
                if c == b'\'' && matches!(family, Family::Rust) {
                    if j + 2 < tlen && trimmed[j + 2] == b'\'' {
                        j += 3;
                        continue;
                    } else if j + 3 < tlen && trimmed[j + 1] == b'\\' && trimmed[j + 3] == b'\'' {
                        j += 4;
                        continue;
                    } else {
                        j += 1;
                        continue;
                    }
                }
                in_string = if c == b'`' { b'`' } else { 0 }; // 普通单双引号不跨行，防止转义误伤整文件
                if in_string == 0 {
                    // 行内消费完单双引号
                    j += 1;
                    while j < tlen {
                        if trimmed[j] == b'\\' {
                            j += 2;
                        } else if trimmed[j] == c {
                            j += 1;
                            break;
                        } else {
                            j += 1;
                        }
                    }
                    continue;
                }
                j += 1;
                continue;
            }

            if !c.is_ascii_whitespace() {
                last_non_ws = c;
            }

            match c {
                b'{' => {
                    seen_code_token = true;
                    open_braces += 1;
                }
                b'}' => {
                    if !seen_code_token && open_braces == 0 {
                        leading_close_braces += 1;
                    } else if open_braces > 0 {
                        open_braces -= 1;
                    } else {
                        close_braces += 1;
                    }
                    seen_code_token = true;
                }
                b'(' => {
                    seen_code_token = true;
                    net_parens += 1;
                }
                b')' => {
                    seen_code_token = true;
                    net_parens -= 1;
                }
                b' ' | b'\t' | b'\r' => {}
                _ => {
                    seen_code_token = true;
                }
            }
            j += 1;
        }

        // 如果该行在跨行注释/跨行模板字符串中开始，抬高虚拟缩进防止假性落拱
        let effective_indent = if started_in_multiline && non_empty {
            indent.saturating_add(512)
        } else {
            indent
        };

        lines.push(LineMetrics {
            indent: effective_indent,
            non_empty: non_empty && (!is_comment || trimmed.starts_with(b"@") || trimmed.starts_with(b"#")),
            is_comment,
            open_braces,
            close_braces,
            leading_close_braces,
            net_parens,
            ends_with_colon: last_non_ws == b':',
            has_decl_hint,
            has_paren,
            starts_with_ctrl,
        });

        if line_end == n {
            break;
        }
        line_start = line_end + 1;
    }

    if saw_space_indent && saw_tab_indent {
        // Tab 与空格缩进混用
        healthy = false;
    }
    // 独立报警器：EOF 仍处于模板字符串/文档串/块注释内，或字符串吞入 ≥2 个顶格声明行 → 分词状态不可信
    let alarm = in_string != 0 || in_py_triple != 0 || in_block_comment || swallow_hits >= 2;
    if alarm {
        healthy = false;
    }

    let total_lines = lines.len() - 1;
    let mut arches = Vec::new();

    if is_python {
        // Python 缩进系单调栈切拱
        struct PyOpen {
            sig_start: usize,
            foot_line: usize,
            base_indent: u16,
            has_hint: bool,
        }
        let mut stack: Vec<PyOpen> = Vec::new();
        let mut last_non_empty_line = 1usize;

        for ln in 1..=total_lines {
            let m = &lines[ln];
            if !m.non_empty || m.is_comment {
                continue;
            }
            // 任何已有拱若当前有效行缩进 <= base_indent，则在上一非空行闭合
            while let Some(top) = stack.last() {
                if m.indent <= top.base_indent {
                    let popped = stack.pop().unwrap();
                    if last_non_empty_line > popped.foot_line && !lines[popped.sig_start].starts_with_ctrl {
                        let full_start = compute_full_start(&lines, popped.sig_start);
                        arches.push(GeoArch {
                            sig_start: popped.sig_start,
                            foot_line: popped.foot_line,
                            end_line: last_non_empty_line,
                            full_start,
                            tier: if popped.has_hint && healthy { Tier::Green } else { Tier::Yellow },
                        });
                    }
                } else {
                    break;
                }
            }

            if m.ends_with_colon {
                let sig_start = backtrack_multiline_sig(&lines, ln);
                let base_indent = lines[sig_start].indent;
                let has_hint = lines[sig_start].has_decl_hint || m.has_decl_hint;
                stack.push(PyOpen {
                    sig_start,
                    foot_line: ln,
                    base_indent,
                    has_hint,
                });
            }
            last_non_empty_line = ln;
        }
        while let Some(popped) = stack.pop() {
            if last_non_empty_line > popped.foot_line && !lines[popped.sig_start].starts_with_ctrl {
                let full_start = compute_full_start(&lines, popped.sig_start);
                arches.push(GeoArch {
                    sig_start: popped.sig_start,
                    foot_line: popped.foot_line,
                    end_line: last_non_empty_line,
                    full_start,
                    tier: if popped.has_hint && healthy { Tier::Green } else { Tier::Yellow },
                });
            }
        }
    } else {
        // 花括号系：缩进 + 括号双账栈
        struct BraceOpen {
            sig_start: usize,
            foot_line: usize,
            base_indent: u16,
            has_hint: bool,
            is_ctrl: bool,
        }
        let mut stack: Vec<BraceOpen> = Vec::new();

        for ln in 1..=total_lines {
            let m = &lines[ln];
            // 1) 先结算行首的闭合 `}`
            let total_closes = m.leading_close_braces + m.close_braces;
            for _ in 0..total_closes {
                if let Some(popped) = stack.pop() {
                    if popped.is_ctrl {
                        continue;
                    }
                    // 检查双账：闭合行缩进是否等于起拱基线缩进
                    let indent_matches = m.indent == popped.base_indent
                        || m.indent == lines[popped.foot_line].indent;
                    let tier = if !healthy {
                        Tier::Red
                    } else if indent_matches && popped.has_hint {
                        Tier::Green
                    } else if indent_matches {
                        Tier::Yellow
                    } else {
                        Tier::Red
                    };
                    let full_start = compute_full_start(&lines, popped.sig_start);
                    arches.push(GeoArch {
                        sig_start: popped.sig_start,
                        foot_line: popped.foot_line,
                        end_line: ln,
                        full_start,
                        tier,
                    });
                } else {
                    healthy = false;
                }
            }

            // 2) 再压入本行未闭合的 `{`
            for _ in 0..m.open_braces {
                let sig_start = backtrack_multiline_sig(&lines, ln);
                let base_indent = lines[sig_start].indent;
                let has_hint = lines[sig_start].has_decl_hint
                    || m.has_decl_hint
                    || (sig_start > 1 && lines[sig_start - 1].has_decl_hint && !lines[sig_start - 1].is_comment);
                let is_ctrl = lines[sig_start].starts_with_ctrl || m.starts_with_ctrl;
                stack.push(BraceOpen {
                    sig_start,
                    foot_line: ln,
                    base_indent,
                    has_hint,
                    is_ctrl,
                });
            }
        }
        if !stack.is_empty() {
            healthy = false;
        }
    }

    let names = arches
        .iter()
        .map(|a| {
            let (s, e) = line_spans.get(a.sig_start).copied().unwrap_or((0, 0));
            extract_name(&bytes[s..e], family)
        })
        .collect();
    GeoFileResult { healthy, alarm, names, arches }
}

/// 若函数签名跨多行（例如参数换行、TS 跨行返回类型、Rust where 子句、或 C++/C# 换行写 `{`），向上回溯到签名首行
#[inline]
fn backtrack_multiline_sig(lines: &[LineMetrics], foot_line: usize) -> usize {
    let mut cur = foot_line;
    let mut paren_balance = lines[cur].net_parens;
    let mut steps = 0usize;
    while cur > 1 && steps < 24 {
        if paren_balance < 0 {
            cur -= 1;
            paren_balance += lines[cur].net_parens;
            steps += 1;
            continue;
        }
        // 若回溯到了 `(` 所在行，但该行缩进仍然大于上一行且没有声明关键字（比如参数或返回类型分多行），继续向上找声明头
        let prev = cur - 1;
        if lines[prev].non_empty
            && !lines[prev].is_comment
            && lines[prev].open_braces == 0
            && lines[prev].close_braces == 0
            && !lines[cur].starts_with_ctrl
        {
            // 情况 1: 当前行是独立 `{` / `where` / 返回类型尾巴，且上一行缩进 <= 当前行
            let cur_lacks_head = !lines[cur].has_decl_hint;
            // 情况 2: 上一行是明显的声明头（如 `export function foo(` 拆行）且缩进 <= 当前行
            let prev_is_head = lines[prev].has_decl_hint && lines[prev].indent <= lines[cur].indent && lines[prev].net_parens >= 0 && !lines[cur].has_decl_hint;
            if (cur_lacks_head && (cur == foot_line || lines[prev].indent <= lines[cur].indent)) || prev_is_head {
                cur = prev;
                paren_balance += lines[cur].net_parens;
                steps += 1;
                continue;
            }
        }
        break;
    }
    cur
}

/// 顶格声明行特征（独立报警器用：字符串内部出现这类行，说明分词状态大概率已错位）
#[inline]
fn is_top_decl_head(t: &[u8]) -> bool {
    const HEADS: &[&[u8]] = &[
        b"export ", b"import ", b"function ", b"async function", b"class ",
        b"const ", b"let ", b"def ", b"fn ", b"pub ", b"impl ", b"struct ", b"interface ",
    ];
    HEADS.iter().any(|h| t.starts_with(h))
}

#[inline]
fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

/// 从 i 起跳过空白与 `*` `#` `&`，读取一个标识符，返回字节区间
fn read_ident(s: &[u8], mut i: usize) -> Option<(usize, usize)> {
    while i < s.len() && matches!(s[i], b' ' | b'\t' | b'*' | b'#' | b'&') {
        i += 1;
    }
    let st = i;
    while i < s.len() && is_ident_byte(s[i]) {
        i += 1;
    }
    (i > st).then_some((st, i))
}

/// 查找独立单词 w（两侧非标识符字符），返回单词之后的下标
fn find_word(s: &[u8], w: &[u8]) -> Option<usize> {
    let n = w.len();
    if n == 0 || s.len() < n {
        return None;
    }
    (0..=s.len() - n).find_map(|i| {
        let ok = &s[i..i + n] == w
            && (i == 0 || !is_ident_byte(s[i - 1]))
            && (i + n == s.len() || !is_ident_byte(s[i + n]));
        ok.then_some(i + n)
    })
}

/// 从 '<' 处跳到匹配的 '>' 之后
fn skip_angle(s: &[u8], mut i: usize) -> usize {
    let mut d = 0i32;
    while i < s.len() {
        match s[i] {
            b'<' => d += 1,
            b'>' => {
                d -= 1;
                if d == 0 {
                    return i + 1;
                }
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// 取 s[..pos] 末尾的标识符（跳过尾随空白与泛型参数 `<...>`）
fn last_ident_before(s: &[u8], pos: usize) -> Option<(usize, usize)> {
    let mut k = pos.min(s.len());
    while k > 0 && matches!(s[k - 1], b' ' | b'\t') {
        k -= 1;
    }
    if k > 0 && s[k - 1] == b'>' {
        let mut d = 0i32;
        while k > 0 {
            k -= 1;
            match s[k] {
                b'>' => d += 1,
                b'<' => {
                    d -= 1;
                    if d == 0 {
                        break;
                    }
                }
                _ => {}
            }
        }
        while k > 0 && matches!(s[k - 1], b' ' | b'\t') {
            k -= 1;
        }
    }
    let end = k;
    while k > 0 && is_ident_byte(s[k - 1]) {
        k -= 1;
    }
    (end > k).then_some((k, end))
}

/// 从拱脚签名行提取符号名（启发式：关键字 → impl/func 特例 → const/let/var → 对象键 → 赋值左值 → 调用形）
fn extract_name(line: &[u8], family: Family) -> String {
    const KW_JS: &[&[u8]] = &[b"function", b"class", b"interface", b"enum", b"namespace"];
    const KW_PY: &[&[u8]] = &[b"def", b"class"];
    const KW_RS: &[&[u8]] = &[b"fn", b"struct", b"enum", b"trait", b"mod", b"union"];
    const KW_GO: &[&[u8]] = &[b"type"];
    const KW_LUA: &[&[u8]] = &[b"function"];
    const KW_C: &[&[u8]] = &[b"class", b"struct", b"interface", b"enum", b"namespace", b"record"];
    const DECL: &[&[u8]] = &[b"const", b"let", b"var"];

    let s = line.trim_ascii_start();
    let take = |(a, b): (usize, usize)| String::from_utf8_lossy(&s[a..b]).into_owned();

    let kws = match family {
        Family::Js => KW_JS,
        Family::Python => KW_PY,
        Family::Rust => KW_RS,
        Family::Go => KW_GO,
        Family::Lua => KW_LUA,
        _ => KW_C,
    };
    for kw in kws {
        if let Some(p) = find_word(s, kw) {
            if let Some(r) = read_ident(s, p) {
                return take(r);
            }
        }
    }

    // Rust impl：`impl<T> Trait for Type<T>` → Type；路径取最后一段
    if matches!(family, Family::Rust) {
        if let Some(mut p) = find_word(s, b"impl") {
            while p < s.len() && s[p] == b' ' {
                p += 1;
            }
            if p < s.len() && s[p] == b'<' {
                p = skip_angle(s, p);
            }
            if let Some(q) = find_word(&s[p.min(s.len())..], b"for") {
                p += q;
            }
            let mut last = None;
            let mut i = p;
            while let Some((a, b)) = read_ident(s, i) {
                last = Some((a, b));
                if s[b..].starts_with(b"::") {
                    i = b + 2;
                } else {
                    break;
                }
            }
            if let Some(r) = last {
                return take(r);
            }
        }
    }

    // Go func：跳过方法接收者 `(s *Server)`
    if matches!(family, Family::Go) {
        if let Some(mut p) = find_word(s, b"func") {
            while p < s.len() && s[p] == b' ' {
                p += 1;
            }
            if p < s.len() && s[p] == b'(' {
                while p < s.len() && s[p] != b')' {
                    p += 1;
                }
                p += 1;
            }
            if let Some(r) = read_ident(s, p) {
                return take(r);
            }
        }
    }

    if !matches!(family, Family::Python) {
        for kw in DECL {
            if let Some(p) = find_word(s, kw) {
                if let Some(r) = read_ident(s, p) {
                    return take(r);
                }
            }
        }
        // 对象键：`"key": ...` / `key: ...`
        if let Some(&q) = s.first() {
            if q == b'"' || q == b'\'' {
                if let Some(e) = s[1..].iter().position(|&c| c == q) {
                    if s[e + 2..].trim_ascii_start().starts_with(b":") {
                        return take((1, e + 1));
                    }
                }
            }
        }
        if let Some((a, b)) = read_ident(s, 0) {
            let r = s[b..].trim_ascii_start();
            if r.starts_with(b":") && !r.starts_with(b"::") {
                return take((a, b));
            }
        }
    }

    // 赋值左值：第一个普通 `=` 位于第一个 `(` 之前 → 取 `=` 前的最后一个标识符
    let paren = s.iter().position(|&c| c == b'(').unwrap_or(s.len());
    for i in 0..paren {
        if s[i] != b'=' {
            continue;
        }
        let nx = s.get(i + 1).copied().unwrap_or(0);
        let pv = if i > 0 { s[i - 1] } else { 0 };
        if nx == b'=' || nx == b'>' || matches!(pv, b'=' | b'!' | b'<' | b'>' | b'+' | b'-' | b'*' | b'/' | b'|' | b'&' | b'%' | b'^') {
            continue;
        }
        if let Some(r) = last_ident_before(s, i) {
            return take(r);
        }
        break;
    }

    // 调用形：第一个 `(` 前的标识符（方法、C#/Java/C++ 函数）
    if paren < s.len() {
        if let Some(r) = last_ident_before(s, paren) {
            return take(r);
        }
    }
    String::new()
}

/// 沿着签名行向上吸收紧邻注释 / 装饰器 / 属性（遇空行即停）
#[inline]
fn compute_full_start(lines: &[LineMetrics], sig_start: usize) -> usize {
    let mut f = sig_start;
    while f > 1 {
        let prev = &lines[f - 1];
        if prev.is_comment {
            f -= 1;
        } else {
            break;
        }
    }
    f
}

/// 判断 Tree-sitter 符号是否属于“多行块级拱形符号”（排除单行常量/字段等点状符号）
fn is_multiline_arch_symbol(sym: &symbols::Symbol) -> bool {
    if sym.end <= sym.start {
        return false;
    }
    matches!(
        sym.kind,
        "function" | "method" | "class" | "struct" | "enum" | "impl"
            | "trait" | "interface" | "namespace" | "module" | "object" | "constructor"
    )
}

#[derive(Default)]
struct LangStats {
    files: usize,
    healthy_files: usize,
    lines: usize,
    ts_arch_symbols: usize,
    healthy_ts_symbols: usize,
    healthy_exact_hits: usize,
    healthy_near_hits: usize,
    /// 起止行完全精确命中 (start == sig_start || start == foot_line) && end == end_line
    exact_span_hits: usize,
    /// 容差 ±1 行命中（处理装饰器或独立闭合行微差）
    near_span_hits: usize,
    /// 落点 end_line 完全精确命中
    exact_end_hits: usize,
    /// full_start 注释上界也同时精确命中
    exact_full_start_hits: usize,
    /// 几何扫描产出的总拱数（非控制流）
    geo_total_arches: usize,
    geo_green_arches: usize,
    /// Green 档中被证实确实对应 TS 符号的座数（或合法的块级闭合区间）
    geo_green_matched_ts: usize,
    ts_time_us: u128,
    geo_time_us: u128,
    fallback_ts_time_us: u128,
    alarm_files: usize,
    /// ② 名字：健康文件中起止精确命中的符号，名字比对总数 / 一致数
    name_total: usize,
    name_hits: usize,
    /// ③ 精确率：健康文件中 🟢 拱总数 / 对应任意 TS 符号数（以及可提取到名字的子集）
    green_healthy: usize,
    green_matched_any: usize,
    green_named: usize,
    green_named_matched: usize,
}

fn main() {
    let root_arg = env::args().nth(1).unwrap_or_else(|| "H:\\VCP\\VCPMain".to_string());
    let root = PathBuf::from(&root_arg);
    println!("=== 几何拱形函数寻址 (Arch-Geometry) 全库对照实验 ===");
    println!("扫描根目录: {}", root.display());

    // 阶段 1: 遍历目录
    let t_walk = Instant::now();
    let file_list = collect_files(&root);
    let walk_ms = t_walk.elapsed().as_secs_f64() * 1000.0;

    // 阶段 2: 读文件 + 归一化换行到内存（剥离磁盘 I/O）
    let t_read = Instant::now();
    let loaded: Vec<(PathBuf, Lang, String)> = file_list
        .into_par_iter()
        .filter_map(|(path, lang)| {
            let bytes = fs::read(&path).ok()?;
            let raw = String::from_utf8_lossy(&bytes);
            let norm = normalize_source(&raw);
            Some((path, lang, norm))
        })
        .collect();
    let read_ms = t_read.elapsed().as_secs_f64() * 1000.0;

    let total_bytes: usize = loaded.iter().map(|(_, _, s)| s.len()).sum();
    let total_lines: usize = loaded.iter().map(|(_, _, s)| s.matches('\n').count() + 1).sum();
    println!(
        "加载完成: {} 个源码文件, {:.2} MB, {} 行代码 (遍历: {:.1} ms, 磁盘读取+归一化: {:.1} ms)\n",
        loaded.len(),
        total_bytes as f64 / (1024.0 * 1024.0),
        total_lines,
        walk_ms,
        read_ms
    );

    // 阶段 3: 纯内存并行跑 Tree-sitter outline
    let t_ts = Instant::now();
    let ts_results: Vec<(Outline, u128)> = loaded
        .par_iter()
        .map_init(Parser::new, |parser, (_, lang, src)| {
            let t0 = Instant::now();
            let o = outline(*lang, src, parser).unwrap_or(Outline {
                lang: lang.name(),
                has_error: true,
                line_count: 0,
                symbols: Vec::new(),
            });
            (o, t0.elapsed().as_micros())
        })
        .collect();
    let ts_wall_ms = t_ts.elapsed().as_secs_f64() * 1000.0;

    // 阶段 4: 纯内存并行跑 几何拱形扫描器
    let t_geo = Instant::now();
    let geo_results: Vec<(GeoFileResult, u128)> = loaded
        .par_iter()
        .map(|(_, lang, src)| {
            let t0 = Instant::now();
            let g = scan_geometry(*lang, src);
            (g, t0.elapsed().as_micros())
        })
        .collect();
    let geo_wall_ms = t_geo.elapsed().as_secs_f64() * 1000.0;

    println!("--- 纯内存并行耗时对比 (Rayon 全核) ---");
    println!("Tree-sitter 解析+提取 : {:8.2} ms", ts_wall_ms);
    println!("几何拱形单趟扫描      : {:8.2} ms", geo_wall_ms);
    println!("纯计算加速比          : {:8.2}x\n", ts_wall_ms / geo_wall_ms.max(0.001));

    // 阶段 5: 逐文件、按语言对齐评测
    let mut by_lang: HashMap<&'static str, LangStats> = HashMap::new();
    let mut miss_samples: Vec<String> = Vec::new();
    let mut name_miss_samples: Vec<String> = Vec::new();
    let mut name_miss_seen = 0usize;
    let mut fp_samples: Vec<String> = Vec::new();
    let mut fp_seen = 0usize;
    let mut diag_lines: Vec<String> = Vec::new();
    let mut alarm_paths: Vec<String> = Vec::new();

    for i in 0..loaded.len() {
        let (ref path, lang, _) = loaded[i];
        let (ref o, ts_us) = ts_results[i];
        let (ref g, geo_us) = geo_results[i];

        let st = by_lang.entry(lang.name()).or_default();
        st.files += 1;
        if g.healthy {
            st.healthy_files += 1;
        } else {
            st.fallback_ts_time_us += ts_us;
        }
        if g.alarm {
            st.alarm_files += 1;
            alarm_paths.push(format!("[{}] {}", lang.name(), path.strip_prefix(&root).unwrap_or(path).display()));
        }
        st.lines += o.line_count;
        st.ts_time_us += ts_us;
        st.geo_time_us += geo_us;
        st.geo_total_arches += g.arches.len();
        st.geo_green_arches += g.arches.iter().filter(|a| a.tier == Tier::Green).count();

        // 构建该文件几何拱的快速索引
        // key: end_line -> Vec<&GeoArch>
        let mut by_end: HashMap<usize, Vec<&GeoArch>> = HashMap::new();
        for arch in &g.arches {
            by_end.entry(arch.end_line).or_default().push(arch);
        }

        // 记录哪些几何拱命中了 TS 符号
        let mut matched_arch_bounds: HashSet<(usize, usize)> = HashSet::new();
        let name_of: HashMap<(usize, usize), &str> = g
            .arches
            .iter()
            .zip(g.names.iter())
            .map(|(a, n)| ((a.foot_line, a.end_line), n.as_str()))
            .collect();
        let mut f_syms = 0usize;
        let mut f_exact = 0usize;

        for sym in &o.symbols {
            if !is_multiline_arch_symbol(sym) {
                continue;
            }
            st.ts_arch_symbols += 1;
            f_syms += 1;
            if g.healthy {
                st.healthy_ts_symbols += 1;
            }

            let mut exact_hit = false;
            let mut near_hit = false;
            let mut end_hit = false;
            let mut full_hit = false;

            if let Some(cands) = by_end.get(&sym.end) {
                end_hit = true;
                for &arch in cands {
                    if arch.sig_start == sym.start || arch.foot_line == sym.start {
                        exact_hit = true;
                        matched_arch_bounds.insert((arch.foot_line, arch.end_line));
                        if arch.full_start == sym.full_start {
                            full_hit = true;
                        }
                        f_exact += 1;
                        if g.healthy {
                            st.name_total += 1;
                            let gn = name_of.get(&(arch.foot_line, arch.end_line)).copied().unwrap_or("");
                            if gn == sym.name.as_str() {
                                st.name_hits += 1;
                            } else {
                                name_miss_seen += 1;
                                if name_miss_seen % 13 == 1 && name_miss_samples.len() < 20 {
                                    name_miss_samples.push(format!(
                                        "[{}] {}:{} ({}) TS名={} 几何名={}",
                                        lang.name(),
                                        path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                                        sym.start,
                                        sym.kind,
                                        sym.name,
                                        if gn.is_empty() { "<空>" } else { gn }
                                    ));
                                }
                            }
                        }
                        break;
                    } else if arch.sig_start.abs_diff(sym.start) <= 2 || arch.foot_line.abs_diff(sym.start) <= 2 {
                        near_hit = true;
                        matched_arch_bounds.insert((arch.foot_line, arch.end_line));
                    }
                }
            }
            if !exact_hit && !near_hit {
                // 检查 end_line ± 1 的容差
                for e_try in [sym.end.saturating_sub(1), sym.end + 1] {
                    if let Some(cands) = by_end.get(&e_try) {
                        for &arch in cands {
                            if arch.sig_start.abs_diff(sym.start) <= 1 || arch.foot_line.abs_diff(sym.start) <= 1 {
                                near_hit = true;
                                matched_arch_bounds.insert((arch.foot_line, arch.end_line));
                                break;
                            }
                        }
                    }
                }
            }

            if exact_hit {
                st.exact_span_hits += 1;
                st.near_span_hits += 1;
                if g.healthy {
                    st.healthy_exact_hits += 1;
                    st.healthy_near_hits += 1;
                }
            } else if near_hit {
                st.near_span_hits += 1;
                if g.healthy {
                    st.healthy_near_hits += 1;
                }
            } else if g.healthy && miss_samples.len() < 40 {
                miss_samples.push(format!(
                    "[{}] {}#{} ({}) TS={}..={} (full={})",
                    lang.name(),
                    path.strip_prefix(&root).unwrap_or(path).display(),
                    sym.qualified,
                    sym.kind,
                    sym.start,
                    sym.end,
                    sym.full_start
                ));
            }
            if end_hit {
                st.exact_end_hits += 1;
            }
            if full_hit {
                st.exact_full_start_hits += 1;
            }
        }

        for arch in &g.arches {
            if arch.tier == Tier::Green && matched_arch_bounds.contains(&(arch.foot_line, arch.end_line)) {
                st.geo_green_matched_ts += 1;
            }
        }
        // ③ 错报率：健康文件中 🟢 拱是否对应任意一个 TS 符号（起点取 sig_start 或 foot_line，终点精确）
        if g.healthy {
            let ts_spans: HashSet<(usize, usize)> = o.symbols.iter().map(|s| (s.start, s.end)).collect();
            for (ai, arch) in g.arches.iter().enumerate() {
                if arch.tier != Tier::Green {
                    continue;
                }
                st.green_healthy += 1;
                let named = !g.names[ai].is_empty();
                if named {
                    st.green_named += 1;
                }
                if ts_spans.contains(&(arch.sig_start, arch.end_line)) || ts_spans.contains(&(arch.foot_line, arch.end_line)) {
                    st.green_matched_any += 1;
                    if named {
                        st.green_named_matched += 1;
                    }
                } else if named {
                    fp_seen += 1;
                    if fp_seen % 997 == 1 && fp_samples.len() < 20 {
                        fp_samples.push(format!(
                            "[{}] {}:{}..={} 几何名={}",
                            lang.name(),
                            path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
                            arch.sig_start,
                            arch.end_line,
                            g.names[ai]
                        ));
                    }
                }
            }
        }
        if path.ends_with("useToolListPreview.ts") {
            diag_lines.push(format!(
                "{} → healthy={} alarm={} 起止精确 {}/{}",
                path.display(),
                g.healthy,
                g.alarm,
                f_exact,
                f_syms
            ));
        }
    }

    // 排序输出各语言表格
    let mut rows: Vec<(&'static str, LangStats)> = by_lang.into_iter().collect();
    rows.sort_by(|a, b| b.1.ts_arch_symbols.cmp(&a.1.ts_arch_symbols));

    println!(
        "{:<11} | {:>5} | {:>8} | {:>7} | {:>8} | {:>8} | {:>8} | {:>8} | {:>7}",
        "Lang", "Files", "Lines", "TS_Syms", "EndHit%", "Exact%", "Near±1%", "FullSt%", "Speedup"
    );
    println!("{}", "-".repeat(94));

    let mut tot = LangStats::default();
    for (lname, s) in &rows {
        let n = s.ts_arch_symbols.max(1) as f64;
        let end_pct = (s.exact_end_hits as f64 / n) * 100.0;
        let exact_pct = (s.exact_span_hits as f64 / n) * 100.0;
        let near_pct = (s.near_span_hits as f64 / n) * 100.0;
        let full_pct = (s.exact_full_start_hits as f64 / n) * 100.0;
        let speedup = (s.ts_time_us as f64) / (s.geo_time_us.max(1) as f64);

        println!(
            "{:<11} | {:>5} | {:>8} | {:>7} | {:>7.2}% | {:>7.2}% | {:>7.2}% | {:>7.2}% | {:>6.1}x",
            lname, s.files, s.lines, s.ts_arch_symbols, end_pct, exact_pct, near_pct, full_pct, speedup
        );

        tot.files += s.files;
        tot.healthy_files += s.healthy_files;
        tot.lines += s.lines;
        tot.ts_arch_symbols += s.ts_arch_symbols;
        tot.healthy_ts_symbols += s.healthy_ts_symbols;
        tot.healthy_exact_hits += s.healthy_exact_hits;
        tot.healthy_near_hits += s.healthy_near_hits;
        tot.exact_end_hits += s.exact_end_hits;
        tot.exact_span_hits += s.exact_span_hits;
        tot.near_span_hits += s.near_span_hits;
        tot.exact_full_start_hits += s.exact_full_start_hits;
        tot.geo_total_arches += s.geo_total_arches;
        tot.geo_green_arches += s.geo_green_arches;
        tot.geo_green_matched_ts += s.geo_green_matched_ts;
        tot.ts_time_us += s.ts_time_us;
        tot.geo_time_us += s.geo_time_us;
        tot.fallback_ts_time_us += s.fallback_ts_time_us;
        tot.alarm_files += s.alarm_files;
        tot.name_total += s.name_total;
        tot.name_hits += s.name_hits;
        tot.green_healthy += s.green_healthy;
        tot.green_matched_any += s.green_matched_any;
        tot.green_named += s.green_named;
        tot.green_named_matched += s.green_named_matched;
    }

    println!("{}", "-".repeat(94));
    let tn = tot.ts_arch_symbols.max(1) as f64;
    println!(
        "{:<11} | {:>5} | {:>8} | {:>7} | {:>7.2}% | {:>7.2}% | {:>7.2}% | {:>7.2}% | {:>6.1}x",
        "TOTAL",
        tot.files,
        tot.lines,
        tot.ts_arch_symbols,
        (tot.exact_end_hits as f64 / tn) * 100.0,
        (tot.exact_span_hits as f64 / tn) * 100.0,
        (tot.near_span_hits as f64 / tn) * 100.0,
        (tot.exact_full_start_hits as f64 / tn) * 100.0,
        (tot.ts_time_us as f64) / (tot.geo_time_us.max(1) as f64)
    );

    let hn = tot.healthy_ts_symbols.max(1) as f64;
    let unhealthy_syms = tot.ts_arch_symbols.saturating_sub(tot.healthy_ts_symbols);
    let hybrid_exact = tot.healthy_exact_hits + unhealthy_syms;
    let hybrid_near = tot.healthy_near_hits + unhealthy_syms;
    println!("\n--- 健康度分流与二级混合路由 (Geo + Red Fallback TS) ---");
    println!(
        "健康文件占比 (🟢/🟡 直通): {}/{} ({:.2}%), 涵盖符号 {}/{}",
        tot.healthy_files,
        tot.files,
        (tot.healthy_files as f64 / tot.files.max(1) as f64) * 100.0,
        tot.healthy_ts_symbols,
        tot.ts_arch_symbols
    );
    println!(
        "健康文件内部几何命中率 : Exact = {:.2}% | Near(±1行) = {:.2}%",
        (tot.healthy_exact_hits as f64 / hn) * 100.0,
        (tot.healthy_near_hits as f64 / hn) * 100.0
    );
    println!(
        "混合路由总命中率(红灯文件自动回退TS): Exact = {:.2}% | Near(±1行) = {:.2}%",
        (hybrid_exact as f64 / tn) * 100.0,
        (hybrid_near as f64 / tn) * 100.0
    );
    println!(
        "CPU 核时对比: 纯TS = {:.1} ms | 纯Geo = {:.1} ms | 混合路由(Geo + 4.7%不健康回退TS) = {:.1} ms (省掉 {:.1}% 算力)",
        tot.ts_time_us as f64 / 1000.0,
        tot.geo_time_us as f64 / 1000.0,
        (tot.geo_time_us + tot.fallback_ts_time_us) as f64 / 1000.0,
        (1.0 - (tot.geo_time_us + tot.fallback_ts_time_us) as f64 / (tot.ts_time_us.max(1) as f64)) * 100.0
    );

    run_strategy_bench(&root, &loaded, &ts_results, &geo_results);

    let pct = |a: usize, b: usize| (a as f64 / b.max(1) as f64) * 100.0;
    println!("\n--- 独立报警器 ---");
    println!("报警文件（EOF 仍在字符串/注释内，或字符串吞入顶格声明行）: {}", tot.alarm_files);
    for p in &alarm_paths {
        println!("  报警: {}", p);
    }
    for d in &diag_lines {
        println!("诊断: {}", d);
    }

    println!("\n--- 方案B前置② 名字 / ③ 🟢拱精确率（仅健康文件） ---");
    println!(
        "{:<11} | {:>7} | {:>8} | {:>8} | {:>10} | {:>8} | {:>11}",
        "Lang", "NameN", "NameOK%", "GreenN", "GreenPrec%", "NamedN", "NamedPrec%"
    );
    for (lname, s) in &rows {
        println!(
            "{:<11} | {:>7} | {:>7.2}% | {:>8} | {:>9.2}% | {:>8} | {:>10.2}%",
            lname,
            s.name_total,
            pct(s.name_hits, s.name_total),
            s.green_healthy,
            pct(s.green_matched_any, s.green_healthy),
            s.green_named,
            pct(s.green_named_matched, s.green_named)
        );
    }
    println!(
        "{:<11} | {:>7} | {:>7.2}% | {:>8} | {:>9.2}% | {:>8} | {:>10.2}%",
        "TOTAL",
        tot.name_total,
        pct(tot.name_hits, tot.name_total),
        tot.green_healthy,
        pct(tot.green_matched_any, tot.green_healthy),
        tot.green_named,
        pct(tot.green_named_matched, tot.green_named)
    );

    if !name_miss_samples.is_empty() {
        println!("\n--- 名字不一致抽样（每 13 条取 1） ---");
        for m in &name_miss_samples {
            println!("  - {}", m);
        }
    }
    if !fp_samples.is_empty() {
        println!("\n--- 🟢 拱但无对应 TS 符号抽样（每 997 条取 1） ---");
        for m in &fp_samples {
            println!("  - {}", m);
        }
    }

    if !miss_samples.is_empty() {
        println!("\n--- 未命中样本抽样 (前 {} 条) ---", miss_samples.len());
        for m in &miss_samples {
            println!("  - {}", m);
        }
    }
}
// ======================= 方案B：查询策略对比 =======================

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).display().to_string()
}

/// 复核切刀：判断文件中出现 `needle` 的位置是否处于“定义位（Definition Site）”而非纯消费位（import / 注释 / 普通函数调用）
/// - `exact_ident`: 若为 true，要求 needle 作为完整标识符出现（用于 exact=true 或第一波高精度全等检索）
fn file_has_definition_anchor(
    lower_src: &str,
    needle: &str,
    geo: &GeoFileResult,
    exact_ident: bool,
) -> bool {
    if !geo.healthy {
        return true;
    }
    // 1. 收集所有几何拱的签名区间 [sig_start..=foot_line]
    let mut arch_sig_lines: HashSet<usize> = HashSet::with_capacity(geo.arches.len() * 2);
    for a in &geo.arches {
        for ln in a.sig_start..=a.foot_line {
            arch_sig_lines.insert(ln);
        }
    }

    let nbytes = needle.as_bytes();
    let lines_vec: Vec<&str> = lower_src.split('\n').collect();

    for (idx, &line) in lines_vec.iter().enumerate() {
        if !line.contains(needle) {
            continue;
        }
        let ln = idx + 1;
        let t = line.trim_start();
        // 排除纯注释行
        if t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') || t.starts_with("--") {
            continue;
        }
        // 排除纯导入行 (import / use / from ... import)，但放行 `export`
        if (t.starts_with("import ") || t.starts_with("import{") || t.starts_with("from ") || t.starts_with("use "))
            && !t.contains("export")
        {
            continue;
        }

        // 检查该行中每一个匹配位置
        let lb = t.as_bytes();
        let mut search_from = 0usize;
        while let Some(rel_pos) = t[search_from..].find(needle) {
            let pos = search_from + rel_pos;
            let end_pos = pos + nbytes.len();
            search_from = pos + 1;

            // 找出包含 needle 的完整标识符边界 [id_start..id_end]
            let mut id_start = pos;
            while id_start > 0 && (is_ident_byte(lb[id_start - 1]) || lb[id_start - 1] == b'-') {
                id_start -= 1;
            }
            let mut id_end = end_pos;
            while id_end < lb.len() && (is_ident_byte(lb[id_end]) || lb[id_end] == b'-') {
                id_end += 1;
            }

            if exact_ident && (id_start != pos || id_end != end_pos) {
                continue;
            }

            // 如果 needle 紧邻在路径斜杠 `/` 后面（如 import/require 路径 `'./foo'`），跳过
            if id_start > 0 && lb[id_start - 1] == b'/' {
                continue;
            }
            // 如果是普通成员调用 `.foo(`（前面是 `.` 且该行既无 `=` 也非对象/类方法拱脚），跳过！
            if id_start > 0 && lb[id_start - 1] == b'.' {
                let after_id = t[id_end..].trim_start();
                // 只有 `obj.foo = ...` 才是定义；`obj.foo(...)` 是纯调用！
                if !after_id.starts_with('=') || after_id.starts_with("==") || after_id.starts_with("=>") {
                    continue;
                }
            }

            // A. 若该行本身就是几何拱的签名行（且不是 `foo(bar)` 里的参数，或者该行含有声明/方法结构），放行
            if arch_sig_lines.contains(&ln) {
                return true;
            }

            // B. 检查标识符左侧是否有声明关键字 (`fn`, `function`, `def`, `class`, `const`, `let`, `var`, `struct`, `enum`, `interface`, `type`, `trait`, `mod`, `pub`, `export`, `static` 等)
            let before = t[..id_start].trim_end();
            const LEFT_KWS: &[&str] = &[
                "fn", "function", "def", "class", "const", "let", "var", "struct", "enum",
                "interface", "type", "trait", "mod", "impl", "namespace", "record", "union",
                "get", "set", "async", "pub", "export", "public", "private", "protected", "internal", "static",
            ];
            let left_trimmed = before.trim_end_matches(|c: char| matches!(c, '*' | '&' | '>' | ':' | ' ' | '\t'));
            if LEFT_KWS.iter().any(|&kw| {
                left_trimmed == kw
                    || (left_trimmed.ends_with(kw)
                        && !left_trimmed.as_bytes()[left_trimmed.len() - kw.len() - 1].is_ascii_alphanumeric())
            }) {
                return true;
            }

            // C. 检查标识符右侧是否有定义符：`:` (对象键/TS类型)、`=` (赋值定义，非 `==`)、`(` 且本行或下一行带 `{` / `=>` / `:`（单行方法或未闭合签名）
            let after = t[id_end..].trim_start();
            // 跳过可选泛型 `<...>` 或 TS 可选 `?`
            let after_clean = if after.starts_with('?') {
                after[1..].trim_start()
            } else if after.starts_with('<') {
                let skip = skip_angle(after.as_bytes(), 0);
                after[skip.min(after.len())..].trim_start()
            } else {
                after
            };

            if (after_clean.starts_with(':') && !after_clean.starts_with("::"))
                || (after_clean.starts_with('=') && !after_clean.starts_with("==") && !after_clean.starts_with("=>"))
                || after_clean.starts_with('{')
            {
                return true;
            }
            if after_clean.starts_with('(') {
                // 单行函数/方法定义：本行包含 `{` 或 `=>` 或 `:` (Python/TS)，或者下一行以 `{` / `=>` 开头
                if t.contains('{') || t.contains("=>") || t.ends_with(':') || t.ends_with(')') {
                    return true;
                }
            }
        }
    }
    false
}

/// 与 scan.rs::score 同口径；入参均已小写，norm_qual / norm_q 已把 `::` 归一为 `.`
fn score_low(name: &str, norm_qual: &str, q: &str, norm_q: &str, exact: bool) -> u32 {
    if norm_qual == norm_q {
        return 1000;
    }
    if name == q {
        return 900;
    }
    if norm_qual.len() > norm_q.len()
        && norm_qual.ends_with(norm_q)
        && norm_qual.as_bytes()[norm_qual.len() - norm_q.len() - 1] == b'.'
    {
        return 800;
    }
    if exact {
        return 0;
    }
    if name.starts_with(q) {
        return 500;
    }
    if name.contains(q) {
        return 300;
    }
    if norm_qual.contains(norm_q) {
        return 200;
    }
    0
}

#[derive(Default)]
struct QStat {
    n: usize,
    a_hits: usize,
    b_hits: usize,
    c_hits: usize,
    b_files: usize,
    c_files: usize,
    b_cost: u128,
    c_cost: u128,
    b_miss_q: usize,
    c_miss_q: usize,
    filter_us: u128,
}

fn run_strategy_bench(
    root: &Path,
    loaded: &[(PathBuf, Lang, String)],
    ts: &[(Outline, u128)],
    geo: &[(GeoFileResult, u128)],
) {
    println!("\n=== 方案B 查询策略对比（A 全量TS / B 文本筛选+TS / C 文本+几何签名行+TS）===");
    let t0 = Instant::now();
    let lowered: Vec<String> = loaded.par_iter().map(|(_, _, s)| s.to_lowercase()).collect();
    println!("文件文本小写化（一次性）: {:.1} ms", ms(t0));

    let syms: Vec<Vec<(String, String)>> = ts
        .iter()
        .map(|(o, _)| {
            o.symbols
                .iter()
                .map(|s| (s.name.to_lowercase(), s.qualified.to_lowercase().replace("::", ".")))
                .collect()
        })
        .collect();
    let geo_names: Vec<Vec<String>> = geo
        .iter()
        .map(|(g, _)| g.names.iter().filter(|n| !n.is_empty()).map(|n| n.to_lowercase()).collect())
        .collect();

    // 1) 前提校验：符号名（及限定名各段）是否以原文出现在所在文件
    let mut total = 0usize;
    let mut name_bad = 0usize;
    let mut qual_bad = 0usize;
    let mut bad_samples: Vec<String> = Vec::new();
    for (i, list) in syms.iter().enumerate() {
        for (k, (nl, ql)) in list.iter().enumerate() {
            total += 1;
            if !lowered[i].contains(nl.as_str()) {
                name_bad += 1;
                if bad_samples.len() < 15 {
                    let s = &ts[i].0.symbols[k];
                    bad_samples.push(format!(
                        "[{}] {}:{} ({}) name={:?}",
                        ts[i].0.lang,
                        rel(root, &loaded[i].0),
                        s.start,
                        s.kind,
                        s.name
                    ));
                }
            } else if ql.split('.').any(|seg| !seg.is_empty() && !lowered[i].contains(seg)) {
                qual_bad += 1;
            }
        }
    }
    println!(
        "前提校验：符号 {} 个 | 名字未在原文出现 {} 个 | 限定名某段未出现 {} 个",
        total, name_bad, qual_bad
    );
    for s in &bad_samples {
        println!("  - {}", s);
    }

    // 2) 随机抽取查询（确定性 xorshift，便于复现）
    let flat: Vec<(usize, usize)> = syms
        .iter()
        .enumerate()
        .flat_map(|(i, l)| (0..l.len()).map(move |k| (i, k)))
        .collect();
    if flat.is_empty() {
        return;
    }
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let labels = ["fullname", "qualified", "prefix4"];
    let caps = [300usize, 150, 150];
    let mut sets: Vec<Vec<String>> = vec![Vec::new(), Vec::new(), Vec::new()];
    let mut seen: HashSet<(usize, String)> = HashSet::new();
    let mut guard = 0usize;
    while (0..3).any(|w| sets[w].len() < caps[w]) && guard < 500_000 {
        guard += 1;
        let (i, k) = flat[(next() % flat.len() as u64) as usize];
        let s = &ts[i].0.symbols[k];
        if s.name.chars().count() < 2 {
            continue;
        }
        let which = (next() % 3) as usize;
        let q: String = match which {
            0 => s.name.clone(),
            1 if s.qualified != s.name => s.qualified.clone(),
            2 if s.name.chars().count() >= 6 => s.name.chars().take(4).collect(),
            _ => continue,
        };
        if sets[which].len() >= caps[which] || !seen.insert((which, q.clone())) {
            continue;
        }
        sets[which].push(q);
    }

    let all_cost: u128 = ts.iter().map(|(_, us)| *us).sum();
    println!(
        "基线 A：每次查询解析全部 {} 个文件，核时 {:.1} ms",
        loaded.len(),
        all_cost as f64 / 1000.0
    );
    println!(
        "{:<10} | {:>4} | {:>7} | {:>8} | {:>7} | {:>8} | {:>6} | {:>8} | {:>7} | {:>8} | {:>6} | {:>7}",
        "Set", "N", "A_hits", "B_rec%", "B_files", "B_ms", "B_mQ", "C_rec%", "C_files", "C_ms", "C_mQ", "filt_ms"
    );

    let mut b_miss: Vec<String> = Vec::new();
    let mut c_miss: Vec<String> = Vec::new();
    for (w, qs) in sets.iter().enumerate() {
        let mut st = QStat::default();
        for q in qs {
            let ql = q.to_lowercase();
            let nq = ql.replace("::", ".");
            let needle: String = nq.rsplit('.').find(|s| !s.is_empty()).unwrap_or(nq.as_str()).to_string();

            let tf = Instant::now();
            let cand_b: Vec<usize> = (0..loaded.len())
                .into_par_iter()
                .filter(|&i| lowered[i].contains(needle.as_str()))
                .collect();
            st.filter_us += tf.elapsed().as_micros();
            let in_b: HashSet<usize> = cand_b.iter().copied().collect();
            let exact_mode = w < 2; // fullname 与 qualified 测试 exact=true 具名定义定位，prefix4 测试 exact=false 前缀定位
            let cand_c: HashSet<usize> = cand_b
                .iter()
                .copied()
                .filter(|&i| file_has_definition_anchor(&lowered[i], needle.as_str(), &geo[i].0, exact_mode))
                .collect();
            let _ = &geo_names;

            let (mut a, mut b, mut c) = (0usize, 0usize, 0usize);
            let mut c_sample: Option<String> = None;
            let mut b_sample: Option<String> = None;
            for (i, list) in syms.iter().enumerate() {
                let hit_idx: Vec<usize> = list
                    .iter()
                    .enumerate()
                    .filter(|(_, (nl, qq))| score_low(nl, qq, &ql, &nq, exact_mode) > 0)
                    .map(|(k, _)| k)
                    .collect();
                if hit_idx.is_empty() {
                    continue;
                }
                a += hit_idx.len();
                if in_b.contains(&i) {
                    b += hit_idx.len();
                } else if b_sample.is_none() {
                    let s = &ts[i].0.symbols[hit_idx[0]];
                    b_sample = Some(format!("q={:?} → {}#{} ({})", q, rel(root, &loaded[i].0), s.qualified, s.kind));
                }
                if cand_c.contains(&i) {
                    c += hit_idx.len();
                } else if c_sample.is_none() {
                    let s = &ts[i].0.symbols[hit_idx[0]];
                    c_sample = Some(format!(
                        "q={:?} → {}#{} ({}, L{}..={})",
                        q,
                        rel(root, &loaded[i].0),
                        s.qualified,
                        s.kind,
                        s.start,
                        s.end
                    ));
                }
            }
            st.n += 1;
            st.a_hits += a;
            st.b_hits += b;
            st.c_hits += c;
            st.b_files += cand_b.len();
            st.c_files += cand_c.len();
            st.b_cost += cand_b.iter().map(|&i| ts[i].1).sum::<u128>();
            st.c_cost += cand_c.iter().map(|&i| ts[i].1).sum::<u128>();
            if b < a {
                st.b_miss_q += 1;
                if let Some(s) = b_sample {
                    if b_miss.len() < 10 {
                        b_miss.push(s);
                    }
                }
            }
            if c < a {
                st.c_miss_q += 1;
                if let Some(s) = c_sample {
                    if c_miss.len() < 16 && st.c_miss_q % 3 == 1 {
                        c_miss.push(s);
                    }
                }
            }
        }
        let n = st.n.max(1) as f64;
        let rec = |x: usize| (x as f64 / st.a_hits.max(1) as f64) * 100.0;
        println!(
            "{:<10} | {:>4} | {:>7} | {:>7.3}% | {:>7.1} | {:>8.1} | {:>6} | {:>7.3}% | {:>7.1} | {:>8.1} | {:>6} | {:>7.2}",
            labels[w],
            st.n,
            st.a_hits,
            rec(st.b_hits),
            st.b_files as f64 / n,
            st.b_cost as f64 / 1000.0 / n,
            st.b_miss_q,
            rec(st.c_hits),
            st.c_files as f64 / n,
            st.c_cost as f64 / 1000.0 / n,
            st.c_miss_q,
            st.filter_us as f64 / 1000.0 / n
        );
    }
    println!("（B_ms / C_ms 为候选文件的 TS 核时之和/次；filt_ms 为全库文本筛选挂钟时间/次；mQ 为至少漏 1 个命中的查询数）");
    if !b_miss.is_empty() {
        println!("\n--- B 漏报样本 ---");
        for s in &b_miss {
            println!("  - {}", s);
        }
    }
    if !c_miss.is_empty() {
        println!("\n--- C 漏报样本 ---");
        for s in &c_miss {
            println!("  - {}", s);
        }
    }
}