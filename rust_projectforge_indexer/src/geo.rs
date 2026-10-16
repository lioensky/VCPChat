//! 几何拱形 Outline（Arch-Geometry Outline，二期①）
//!
//! 无需 Tree-sitter grammar 的轻量块级结构提取。单趟字节流扫描每一行的
//! 缩进深度与括号/冒号信号，用「缩进账 + 括号账」双账配对出块级拱形
//! （sig_start / foot_line / end_line），再启发式提取拱脚符号名。
//!
//! 引擎只依赖 `Family`（族）做注释与声明特征分派，不依赖 grammar，
//! 因此可服务于无 grammar 绑定的语言（.ps1/.sh/.wgsl/.zig/.vue 等）
//! 与编辑器态语法破损（has_error）时的符号边界修复。
//!
//! 由 examples/geo_probe.rs 的实验引擎逐字提升而来，零逻辑改动。

#![allow(dead_code)]

use crate::lang::{Family, Lang};
use crate::symbols::{normalize_source, Outline, Symbol};

/// 置信度三档
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// 🟢 双账吻合（缩进回落 + 括号/块配平同一行）且拱脚含明确函数/容器特征
    Green,
    /// 🟡 几何区间完整，但拱脚签名模糊（如跨行复杂签名或无明显关键字）
    Yellow,
    /// 🔴 缩进与括号账本冲突，或文件健康度异常
    Red,
}

#[derive(Debug, Clone)]
pub struct GeoArch {
    /// 拱脚签名起始行（1-based，若有跨行小括号签名则自动上溯到签名首行）
    pub sig_start: usize,
    /// 起拱左脚行（1-based，即块开启 `{` 或 `:` 所在行）
    pub foot_line: usize,
    /// 落拱右脚行（1-based）
    pub end_line: usize,
    /// 向上吸附紧邻等缩进注释后的 full_start（1-based）
    pub full_start: usize,
    /// 置信度档位
    pub tier: Tier,
}

#[derive(Debug, Clone)]
pub struct GeoFileResult {
    pub healthy: bool,
    /// 独立报警器是否触发（分词状态不可信）
    pub alarm: bool,
    /// 与 arches 一一对应的拱脚提取名（空串表示未提取到）
    pub names: Vec<String>,
    pub arches: Vec<GeoArch>,
}

/// 单趟扫描风格：只依赖「族 + 注释风格 + 标识符是否允许连字符」，完全脱离 grammar。
#[derive(Debug, Clone, Copy)]
pub struct ScanStyle {
    pub family: Family,
    /// 行注释以 `#` 开头（shell / powershell 等）
    pub hash_comment: bool,
    /// 标识符允许连字符（PowerShell `Verb-Noun` 函数名）
    pub hyphen_ident: bool,
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
pub fn scan_geometry(style: ScanStyle, source: &str) -> GeoFileResult {
    let bytes = source.as_bytes();
    let family = style.family;
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
            if (is_python || style.hash_comment) && c == b'#' {
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
            extract_name(&bytes[s..e], family, style.hyphen_ident)
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
fn read_ident(s: &[u8], mut i: usize, hyphen: bool) -> Option<(usize, usize)> {
    while i < s.len() && matches!(s[i], b' ' | b'\t' | b'*' | b'#' | b'&') {
        i += 1;
    }
    let st = i;
    while i < s.len() && (is_ident_byte(s[i]) || (hyphen && s[i] == b'-' && i > st)) {
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
fn extract_name(line: &[u8], family: Family, hyphen: bool) -> String {
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
            if let Some(r) = read_ident(s, p, hyphen) {
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
            while let Some((a, b)) = read_ident(s, i, hyphen) {
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
            if let Some(r) = read_ident(s, p, hyphen) {
                return take(r);
            }
        }
    }

    if !matches!(family, Family::Python) {
        for kw in DECL {
            if let Some(p) = find_word(s, kw) {
                if let Some(r) = read_ident(s, p, hyphen) {
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
        if let Some((a, b)) = read_ident(s, 0, hyphen) {
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

// ======================= 无 grammar 语言的几何档案馆 =======================

use std::path::Path;

/// 无 Tree-sitter grammar 语言的几何档案：只需「族 + 注释风格」两个自由度。
/// 复用 `Family` 的注释/声明关键字/字符串分派语义，不依赖 grammar。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GeoProfile {
    /// 复用的族语义（决定注释、声明关键字、字符串字面量分派）
    pub family: Family,
    /// 行注释以 `#` 开头（shell / powershell 等）
    pub hash_comment: bool,
    /// 标识符允许连字符（PowerShell `Verb-Noun` 函数名）
    pub hyphen_ident: bool,
    /// 对外声明的语言名（与 `symbols::Outline.lang` 同口径）
    pub name: &'static str,
    /// 限定名分隔符
    pub sep: &'static str,
}

impl GeoProfile {
    /// 构造单趟扫描风格（引擎只认这个，不依赖 grammar）。
    pub fn scan_style(&self) -> ScanStyle {
        ScanStyle {
            family: self.family,
            hash_comment: self.hash_comment,
            hyphen_ident: self.hyphen_ident,
        }
    }

    /// 便捷入口：以本档案提取几何 Outline。
    pub fn outline(&self, raw: &str) -> Outline {
        geo_outline(raw, self)
    }
}

/// 从扩展名 / 语言名解析几何档案。命中即代表该语言走几何 Outline（无 grammar）。
/// 说明：族是「近似借用」——wgsl/zig 借 Rust 族（识别 `fn`/`struct`），shell/ps1/vue
/// 借 Js 族（识别 `function`/赋值左值）；hash_comment 补偿 `#` 行注释。
pub fn profile_from_name(name: &str) -> Option<GeoProfile> {
    let e = name.trim().trim_start_matches('.').to_ascii_lowercase();
    let p = |family, hash_comment, hyphen_ident, name, sep| {
        Some(GeoProfile { family, hash_comment, hyphen_ident, name, sep })
    };
    match e.as_str() {
        "sh" | "bash" | "zsh" | "fish" | "ksh" => p(Family::Js, true, false, "shell", "."),
        "ps1" | "psm1" | "psd1" => p(Family::Js, true, true, "powershell", "."),
        "wgsl" => p(Family::Rust, false, false, "wgsl", "."),
        "zig" => p(Family::Rust, false, false, "zig", "."),
        "vue" | "svelte" => p(Family::Js, false, false, "vue", "."),
        _ => None,
    }
}

/// 从文件路径解析几何档案。
pub fn profile_from_path(path: &Path) -> Option<GeoProfile> {
    path.extension().and_then(|e| e.to_str()).and_then(profile_from_name)
}

/// 几何符号 kind 启发式：读签名行首关键字（供 findSymbols 的 kind 过滤）。
fn classify_kind(sig: &str) -> &'static str {
    let s = sig.trim_start();
    const TABLE: &[(&str, &str)] = &[
        ("function ", "function"),
        ("func ", "function"),
        ("fn ", "function"),
        ("def ", "function"),
        ("sub ", "function"),
        ("class ", "class"),
        ("struct ", "struct"),
        ("interface ", "interface"),
        ("enum ", "enum"),
        ("impl ", "impl"),
        ("trait ", "trait"),
        ("module ", "module"),
        ("namespace ", "namespace"),
        ("type ", "type"),
        ("const ", "variable"),
        ("let ", "variable"),
        ("var ", "variable"),
    ];
    for &(kw, k) in TABLE {
        if s.starts_with(kw) {
            return k;
        }
    }
    // `name(...) {` 形（shell 函数 / K&R 风格）：首 token 为纯标识符且非控制流
    if let Some(paren) = s.find('(') {
        let head = s[..paren].trim_end();
        if !head.is_empty()
            && head.bytes().all(|b| is_ident_byte(b) || b == b'.')
            && !is_control_flow_head(s.as_bytes())
        {
            return "function";
        }
    }
    "block"
}

/// 几何 Outline：把拱形适配为与 `symbols::Outline` **同构**的结构，消费端零感知。
/// - 行号口径与 `symbols` 一致（1 起算，基于 normalize_source 后的文本）；
/// - `depth`/`parent` 由拱的区间包含关系建立（前序遍历）；
/// - `has_error` 映射为几何账本不可信（!healthy）。
pub fn geo_outline(raw: &str, profile: &GeoProfile) -> Outline {
    let source = normalize_source(raw);
    let g = scan_geometry(profile.scan_style(), &source);
    let lines: Vec<&str> = source.split('\n').collect();
    let line_count = if source.is_empty() {
        0
    } else if source.ends_with('\n') {
        source.matches('\n').count()
    } else {
        source.matches('\n').count() + 1
    };

    let n = g.arches.len();
    // 前序遍历：sig_start 升序，同起点外层（end 大）在前，保证父先于子。
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        g.arches[a]
            .sig_start
            .cmp(&g.arches[b].sig_start)
            .then(g.arches[b].end_line.cmp(&g.arches[a].end_line))
    });

    let mut symbols: Vec<Symbol> = Vec::with_capacity(n);
    let mut stack: Vec<usize> = Vec::new(); // 指向 symbols 的下标（当前祖先链）
    for &ai in &order {
        let a = &g.arches[ai];
        while let Some(&top) = stack.last() {
            let t = &symbols[top];
            if t.full_start <= a.sig_start && a.end_line <= t.end {
                break;
            }
            stack.pop();
        }
        let parent = stack.last().copied();
        let depth = stack.len();
        let raw_name = g.names.get(ai).cloned().unwrap_or_default();
        let name = if raw_name.is_empty() {
            format!("anon@{}", a.sig_start)
        } else {
            raw_name
        };
        let sig_line = lines.get(a.sig_start - 1).map(|l| l.trim()).unwrap_or("");
        let kind = classify_kind(sig_line);
        let qualified = match parent {
            Some(p) => format!("{}{}{}", symbols[p].qualified, profile.sep, name),
            None => name.clone(),
        };
        let signature: String = sig_line.chars().take(120).collect();
        symbols.push(Symbol {
            name,
            kind,
            qualified,
            start: a.sig_start,
            end: a.end_line,
            full_start: a.full_start,
            depth,
            parent,
            signature,
        });
        stack.push(symbols.len() - 1);
    }

    Outline {
        lang: profile.name,
        has_error: !g.healthy,
        line_count,
        symbols,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str = "\
#!/bin/bash
# deploy
deploy() {
    echo hi
    build_all
}
build_all() {
    cargo build
}
";

    const PS: &str = "\
function Get-Foo {
    param($x)
    return $x
}
function Set-Bar {
    Write-Host 'bar'
}
";

    const WGSL: &str = "\
struct VertexInput {
    @location(0) position: vec3<f32>,
}
fn vs_main(in: VertexInput) -> vec4<f32> {
    return vec4<f32>(in.position, 1.0);
}
";

    const VUE: &str = "\
function setup() {
  const state = ref(0);
  function inc() {
    state.value++;
  }
  return { state, inc };
}
";

    fn names_of(ext: &str, src: &str) -> Vec<String> {
        let prof = profile_from_name(ext).expect(ext);
        geo_outline(src, &prof).symbols.iter().map(|s| s.name.clone()).collect()
    }

    #[test]
    fn geo_profiles_produce_expected_symbols() {
        assert_eq!(names_of("sh", SHELL), ["deploy", "build_all"]);
        assert_eq!(names_of("ps1", PS), ["Get-Foo", "Set-Bar"]);
        assert_eq!(names_of("wgsl", WGSL), ["VertexInput", "vs_main"]);
        assert_eq!(names_of("vue", VUE), ["setup", "inc"]);
    }
}

impl ScanStyle {
    /// 从 Tree-sitter 语言推导扫描风格（破损语法自愈用）。
    pub fn for_lang(lang: Lang) -> ScanStyle {
        ScanStyle {
            family: lang.family(),
            hash_comment: false,
            hyphen_ident: false,
        }
    }
}

/// 破损语法自愈（二期②·保守止血）。
///
/// AST 含 ERROR / MISSING（`Outline.has_error`）时，符号边界可能塌陷；几何拱靠
/// 「缩进 + 括号」双账配对，对未闭合括号天然鲁棒。本 pass 只对已有符号做**边界修正**：
/// 匹配同起点的几何拱（`sig_start` ±1 容差），只放大 `end`、收紧 `full_start`，
/// 不新增、不删除、不改名，避免在编辑器高频重入场景制造二次抖动。
///
/// 返回被修正的符号数。
pub fn heal_outline(o: &mut Outline, raw: &str, style: ScanStyle) -> usize {
    if !o.has_error {
        return 0;
    }
    let source = normalize_source(raw);
    let g = scan_geometry(style, &source);
    if g.arches.is_empty() {
        return 0;
    }
    let mut healed = 0usize;
    for sym in o.symbols.iter_mut() {
        let Some(a) = g.arches.iter().find(|a| a.sig_start.abs_diff(sym.start) <= 1) else {
            continue;
        };
        let mut changed = false;
        if a.end_line > sym.end {
            sym.end = a.end_line;
            changed = true;
        }
        if a.full_start < sym.full_start {
            sym.full_start = a.full_start;
            changed = true;
        }
        if changed {
            healed += 1;
        }
    }
    healed
}


#[cfg(test)]
mod heal_tests {
    use super::*;

    fn fake_sym(start: usize, end: usize, full_start: usize) -> crate::symbols::Symbol {
        crate::symbols::Symbol {
            name: "alpha".into(),
            kind: "function",
            qualified: "alpha".into(),
            start,
            end,
            full_start,
            depth: 0,
            parent: None,
            signature: "fn alpha()".into(),
        }
    }

    /// 完整源码：几何拱 sig_start=1, end_line=4, full_start=1。
    const SRC: &str = "fn alpha() {\n    let a = 1;\n    let b = 2;\n}\n";

    #[test]
    fn heal_outline_enlarges_truncated_end() {
        // 构造 AST 塌陷残留：end 被截到第 2 行、full_start 也缺失
        let mut o = crate::symbols::Outline {
            lang: "rust",
            has_error: true,
            line_count: 4,
            symbols: vec![fake_sym(1, 2, 3)],
        };
        let healed = heal_outline(&mut o, SRC, ScanStyle::for_lang(Lang::Rust));
        assert_eq!(healed, 1, "应命中并修正");
        assert_eq!(o.symbols[0].end, 4, "end 应放大到几何拱右脚");
        assert_eq!(o.symbols[0].full_start, 1, "full_start 应收紧到几何拱 full_start");
    }

    #[test]
    fn heal_outline_skips_without_error() {
        // has_error=false：绝不改动（避免健康文件被无谓重写）
        let mut o = crate::symbols::Outline {
            lang: "rust",
            has_error: false,
            line_count: 4,
            symbols: vec![fake_sym(1, 2, 3)],
        };
        assert_eq!(heal_outline(&mut o, SRC, ScanStyle::for_lang(Lang::Rust)), 0);
        assert_eq!(o.symbols[0].end, 2);
    }
}