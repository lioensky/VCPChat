//! Native editing plans. Byte ranges always belong to the original LF snapshot.
//! This module does not write files.
//! 目标定位按证据强度分四级：逐字节 exact → 整行省略号 elision → 按行词法 token → 符号结构 structure。
//! 只有逐字节命中能自动执行；其余层级只产候选，落计划时必须由调用方带 expectedHash 授权。
use serde::{Deserialize, Serialize};

const MAX_TEXT: usize = 8 * 1024 * 1024;
const MAX_STEPS: usize = 200;
const MAX_HITS: usize = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Action {
    Replace { start: usize, end: usize, content: String },
    Delete { start: usize, end: usize },
    Symbol {
        symbol: String,
        content: String,
        #[serde(default)] body: bool,
        #[serde(default)] pick: Option<usize>,
        #[serde(default)] line: Option<usize>,
    },
    Insert {
        #[serde(default)] after: Option<Position>,
        #[serde(default)] before: Option<Position>,
        content: String,
        #[serde(default)] pick: Option<usize>,
        #[serde(default)] line: Option<usize>,
    },
    Target {
        target: String, replace: String,
        #[serde(default)] pick: Vec<usize>,
        #[serde(default)] all: bool,
        #[serde(default)] line: Option<usize>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Position { Line(usize), Address(String) }

impl Action {
    pub fn needs_symbols(&self) -> bool {
        match self {
            Self::Symbol {..} => true,
            Self::Insert {after,before,..} => matches!(before.as_ref().or(after.as_ref()),
                Some(Position::Address(s)) if s.get(..7).is_some_and(|p|p.eq_ignore_ascii_case("symbol:"))),
            _ => false,
        }
    }
}
#[derive(Debug, Clone, Deserialize)]
pub struct Step {
    pub step: usize,
    #[serde(default)] pub reason: Option<String>,
    #[serde(default)] pub expect: Option<String>,
    #[serde(default = "default_drift")] pub drift: usize,
    #[serde(flatten)] pub action: Action,
}
fn default_drift() -> usize { 20 }

fn anchored_range(idx: &Lines<'_>, start: usize, end: usize, step: &Step) -> Result<(usize,usize),String> {
    idx.range(start,end)?;
    let Some(expect)=step.expect.as_deref() else { return Ok((start,end)); };
    if step.drift>200 || expect.len()>MAX_TEXT {return Err("anchor search budget exceeded".into());}
    let expect=clean_input(expect);
    let expected:Vec<_>=body(&expect).split('\n').collect();
    if expected.is_empty() || expected.iter().all(|s|s.is_empty()) {return Err("expect anchor is empty".into());}
    let matches=|line:usize| -> bool {
        if line==0 || line.checked_add(expected.len()-1).is_none_or(|last|last>idx.count) {return false;}
        expected.iter().enumerate().all(|(k,wanted)| {
            let a=idx.starts[line-1+k];
            let b=idx.starts.get(line+k).copied().unwrap_or(idx.text.len());
            body(&idx.text[a..b])==*wanted
        })
    };
    if matches(start) {return Ok((start,end));}
    for distance in 1..=step.drift {
        let plus=start.checked_add(distance).filter(|&n|matches(n));
        let minus=start.checked_sub(distance).filter(|&n|matches(n));
        if plus.is_some() && minus.is_some() {return Err("expect anchor is equidistant and ambiguous".into());}
        if let Some(found)=plus.or(minus) {
            let new_end=found.checked_add(end-start).ok_or("anchor range overflow")?;
            idx.range(found,new_end)?;
            return Ok((found,new_end));
        }
    }
    Err("expect anchor not found within drift budget".into())
}
/// 命中的证据层级，从强到弱。弱的层级只提供候选，需显式 pick 选择。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier { Exact, Elision, Token, Structure }
impl Tier {
    fn name(self) -> &'static str {
        match self {
            Self::Exact => "exact", Self::Elision => "elision",
            Self::Token => "token", Self::Structure => "structure",
        }
    }
    /// 逐字节字面量命中保持旧行为：唯一命中与 line 就近都可以直接执行。
    fn auto_apply(self) -> bool { matches!(self, Self::Exact) }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub index: usize,
    pub start_line: usize,
    pub end_line: usize,
    /// 该候选由哪一级证据产生（exact / elision / token / structure / symbol）。
    pub kind: &'static str,
    /// 包住候选区间的符号限定名；快路径未解析 AST 时缺省。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct Issue { pub step: usize, pub message: String }
#[derive(Debug, Serialize)]
pub struct Ambiguity {
    pub step: usize,
    pub total: usize,
    /// 触发歧义的证据层级，供调用方判断这次需要多强的确认。
    pub kind: &'static str,
    pub candidates: Vec<Candidate>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct Placement {
    // Half-open UTF8 byte offsets in LF analysis snapshots, excluding disk BOM.
    pub step:usize,
    pub op:&'static str,
    pub original_start_byte:usize,
    pub original_end_byte:usize,
    pub new_start_byte:usize,
    pub new_end_byte:usize,
    pub original_start_line:usize,
    pub original_end_line:usize,
    pub insertion:bool,
    pub new_start_line:Option<usize>,
    pub new_end_line:Option<usize>,
}
impl Action {
    fn name(&self)->&'static str {
        match self {
            Self::Replace{..}=>"replace",Self::Delete{..}=>"delete",
            Self::Symbol{..}=>"symbol",Self::Insert{..}=>"insert",Self::Target{..}=>"target",
        }
    }
}
#[derive(Debug, Serialize)]
pub struct Outcome {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub changed: bool,
    pub applied: Vec<usize>,
    pub placements:Vec<Placement>,
    pub errors: Vec<Issue>,
    pub ambiguities: Vec<Ambiguity>,
}
#[derive(Clone)]
struct Patch { start: usize, end: usize, text: String, order: usize, step: usize }
struct Lines<'a> { text: &'a str, starts: Vec<usize>, count: usize }
impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        let count = if text.is_empty() { 0 } else { starts.len() - usize::from(text.ends_with('\n')) };
        Self { text, starts, count }
    }
    fn range(&self, start: usize, end: usize) -> Result<(usize,usize),String> {
        if start == 0 || start > end || end > self.count {
            return Err(format!("invalid line range {start}-{end}; line count {}",self.count));
        }
        Ok((self.starts[start-1],self.starts.get(end).copied().unwrap_or(self.text.len())))
    }
    fn line(&self, offset: usize) -> usize { self.starts.partition_point(|&i| i <= offset) }
    /// 行内文本（不含行尾换行），供按行词法比较使用。
    fn line_text(&self, line: usize) -> &'a str {
        if line == 0 || line > self.count { return ""; }
        let a = self.starts[line - 1];
        let b = self.starts.get(line).copied().unwrap_or(self.text.len());
        body(&self.text[a..b])
    }
}
fn normalize(text: &str) -> String { text.replace("\r\n","\n").replace('\r',"\n") }
fn body(text: &str) -> &str { text.strip_suffix('\n').unwrap_or(text) }

/// ReadCode display decoration only; never run this over the source snapshot.
/// Remove at most one whitespace character after '|', preserving code indentation.
fn display_prefix(line:&str)->Option<&str> {
    let line=line.strip_prefix('>').unwrap_or(line).trim_start_matches(char::is_whitespace);
    let digits=line.bytes().take_while(u8::is_ascii_digit).count();
    if digits==0 {return None;}
    let remaining=&line[digits..];
    let first=remaining.chars().next()?;
    if !first.is_whitespace() {return None;}
    let remaining=&remaining[first.len_utf8()..];
    let remaining=remaining.strip_prefix('|')?;
    match remaining.chars().next() {
        Some(c) if c.is_whitespace()=>Some(&remaining[c.len_utf8()..]),
        _=>Some(remaining),
    }
}
fn clean_input(text:&str)->String {
    let normalized=normalize(text);
    let mut nonempty=normalized.split('\n').filter(|line|!line.trim().is_empty()).peekable();
    if nonempty.peek().is_none() || !nonempty.all(|line|
        matches!(line.trim(), "..."|"…"|"⋮") || display_prefix(line).is_some()) {
        return normalized;
    }
    normalized.split('\n').map(|line| {
        if line.trim().is_empty() {""} else {display_prefix(line).unwrap_or(line)}
    }).collect::<Vec<_>>().join("\n")
}
fn conflicts(a: &Patch,b: &Patch) -> bool {
    // Inserts on a replacement boundary are valid; strictly interior inserts conflict.
    if a.start == a.end && b.start == b.end { return false; }
    if a.start == a.end { return b.start < a.start && a.start < b.end; }
    if b.start == b.end { return a.start < b.start && b.start < a.end; }
    a.start < b.end && b.start < a.end
}
/// 单个步骤的规划结果：只含补丁本身。
struct Plan { patches: Vec<Patch> }

/// token 层的候选与工作量上限，防止在超大文件上做无界扫描。
const MAX_TOKEN_HITS: usize = 1_000;
const MAX_TOKEN_WORK: usize = 400_000;

fn is_indent_byte(b: u8) -> bool { b == b' ' || b == b'\t' }

/// 一行内的词法单元：引号字符串整体成为一个 token（其内部空格原样保留），
/// 其余连续非空白字符成段切分（标点与标识符贴合，不做猜测性拆分）。
fn lex_line(line: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if is_indent_byte(bytes[i]) { i += 1; continue; }
        let start = i;
        let quote = bytes[i];
        if quote == b'"' || quote == b'\'' || quote == b'`' {
            i += 1;
            while i < bytes.len() {
                let b = bytes[i];
                if b == b'\\' {
                    // 转义后跳过一个完整字符，避免停在多字节字符中间切开切片。
                    i += 1;
                    while i < bytes.len() && (bytes[i] & 0xC0) == 0x80 { i += 1; }
                    continue;
                }
                i += 1;
                if b == quote { break; }
            }
            tokens.push(&line[start..i]);
            continue;
        }
        while i < bytes.len() {
            let b = bytes[i];
            if is_indent_byte(b) || b == b'"' || b == b'\'' || b == b'`' { break; }
            i += 1;
        }
        tokens.push(&line[start..i]);
    }
    tokens
}

fn line_indent(line: &str) -> &str {
    let trimmed = line.trim_start_matches(|c| c == ' ' || c == '\t');
    &line[..line.len() - trimmed.len()]
}

/// 三级候选：按行词法切分后比对。行内空白差异被忽略，引号字符串内部必须逐字相等；
/// 多行目标只比较「相对首行的缩进」，避免把同内容但不同嵌套层的块当成同一处（Python 尤甚）。
fn token_hits(idx: &Lines<'_>, target: &str) -> Result<Vec<(usize, usize)>, String> {
    let mut rows: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in target.split('\n') {
        rows.push((line_indent(line), lex_line(line.trim_start_matches(|c| c == ' ' || c == '\t'))));
    }
    // 首尾空行只是排版，不参与匹配。
    while rows.first().is_some_and(|row| row.1.is_empty()) { rows.remove(0); }
    while rows.last().is_some_and(|row| row.1.is_empty()) { rows.pop(); }
    if rows.is_empty() { return Ok(Vec::new()); }
    let base_target = rows[0].0;
    let mut relative: Vec<Option<&str>> = vec![Some("")];
    for (indent, _) in rows.iter().skip(1) {
        relative.push(indent.strip_prefix(base_target));
    }
    // 目标自身缩进关系不成立（后续行比首行更浅）：不做任何猜测。
    if relative.iter().skip(1).any(Option::is_none) { return Ok(Vec::new()); }
    let span = rows.len();
    if idx.count < span { return Ok(Vec::new()); }
    let tokens: usize = rows.iter().map(|row| row.1.len()).sum();
    if tokens > MAX_TOKEN_WORK { return Err("target token budget exceeded".into()); }
    let mut work = MAX_TOKEN_WORK;
    let mut hits = Vec::new();
    for start in 1..=idx.count - span + 1 {
        let base_source = line_indent(idx.line_text(start));
        let mut matched = true;
        for (k, (_, wanted)) in rows.iter().enumerate() {
            work = work.checked_sub(1).ok_or("target token work budget exceeded")?;
            let text = idx.line_text(start + k);
            let found = lex_line(text.trim_start_matches(|c| c == ' ' || c == '\t'));
            if found != *wanted { matched = false; break; }
            if k > 0 {
                let Some(relative) = relative[k] else { matched = false; break; };
                if !line_indent(text).strip_prefix(base_source).is_some_and(|rest| rest == relative) {
                    matched = false;
                    break;
                }
            }
        }
        if !matched { continue; }
        if hits.len() >= MAX_TOKEN_HITS { return Err("target token candidate budget exceeded".into()); }
        let last = start + span - 1;
        hits.push((idx.starts[start - 1], idx.starts.get(last).copied().unwrap_or(idx.text.len())));
    }
    Ok(hits)
}

/// 四级候选：目标本身是某个符号的签名 / 名字 / 限定名，区间取完整定义 full_start..=end。
/// 只有单行目标参与结构匹配；多行块交给 token 层。
fn structure_hits(idx: &Lines<'_>, target: &str,
    symbols: &[crate::symbols::Symbol]) -> Vec<(usize, usize)> {
    if symbols.is_empty() || target.contains('\n') { return Vec::new(); }
    let wanted = target.trim();
    if wanted.is_empty() { return Vec::new(); }
    let normalized = crate::symbol_address::normalize(wanted);
    let rank = |symbol: &crate::symbols::Symbol| -> Option<u8> {
        let signature = symbol.signature.trim();
        if !signature.is_empty() && signature == wanted { return Some(0); }
        if symbol.name == wanted { return Some(1); }
        if !normalized.is_empty()
            && crate::symbol_address::normalize(&symbol.qualified) == normalized {
            return Some(2);
        }
        None
    };
    let mut best: Option<u8> = None;
    let mut hits = Vec::new();
    for symbol in symbols {
        let Some(current) = rank(symbol) else { continue };
        match best {
            Some(winner) if current > winner => continue,
            Some(winner) if current < winner => { best = Some(current); hits.clear(); }
            Some(_) => {}
            None => best = Some(current),
        }
        let Ok((start, end)) = idx.range(symbol.full_start, symbol.end) else { continue };
        hits.push((start, end));
    }
    hits
}

/// 包住该行区间的最内层符号限定名；快路径没有 AST 时返回 None。
fn scope_of(symbols: &[crate::symbols::Symbol], start_line: usize, end_line: usize) -> Option<String> {
    symbols.iter()
        .filter(|symbol| symbol.full_start <= start_line && end_line <= symbol.end)
        .min_by_key(|symbol| symbol.end.saturating_sub(symbol.full_start))
        .map(|symbol| if symbol.qualified.is_empty() { symbol.name.clone() } else { symbol.qualified.clone() })
}

fn candidate(index: usize, start_line: usize, end_line: usize, kind: &'static str,
    symbols: &[crate::symbols::Symbol]) -> Candidate {
    Candidate { index, start_line, end_line, kind, scope: scope_of(symbols, start_line, end_line) }
}

fn plan(idx: &Lines<'_>, st: &Step, order: usize, symbols: &[crate::symbols::Symbol]) -> Result<Result<Plan,Ambiguity>,String> {
    let patch = |start,end,text| Patch { start,end,text,order,step:st.step };
    match &st.action {
        Action::Replace {start,end,..} | Action::Delete {start,end} => {
            let (start,end)=anchored_range(idx,*start,*end,st)?;
            let (a,b)=idx.range(start,end)?;
            let content=match &st.action { Action::Replace{content,..}=>clean_input(content), _=>String::new() };
            let replacement=if content.is_empty() {String::new()} else {
                format!("{}{}",body(&content),if idx.text[..b].ends_with('\n') {"\n"} else {""})
            };
            Ok(Ok(Plan { patches: vec![patch(a,b,replacement)] }))
        }
        Action::Symbol {symbol,content,body,pick,line} => {
            use crate::symbol_address::{select, range, Selection};
            match select(symbols,symbol,*pick,*line)? {
                Selection::NotFound => Err("symbol not found in snapshot outline".into()),
                Selection::Ambiguous(hits) => Ok(Err(Ambiguity {
                    step:st.step,total:hits.len(),kind:"symbol",
                    candidates:hits.iter().take(8).enumerate().map(|(i,&n)|candidate(
                        i+1,symbols[n].full_start,symbols[n].end,"symbol",symbols,
                    )).collect(),
                })),
                Selection::Found(i) => {
                    let (start,end)=range(&symbols[i],*body,0,idx.count)?;
                    let resolved=Step {step:st.step,reason:st.reason.clone(),expect:st.expect.clone(),drift:st.drift,
                        action:Action::Replace {start,end,content:content.clone()}};
                    if resolved.expect.is_some() {
                        // A symbol fixes its own range; do not drift to another definition.
                        let (a,b)=anchored_range(idx,start,end,&resolved)?;
                        if (a,b)!=(start,end) {return Err("symbol expect cannot drift outside selected definition".into());}
                    }
                    plan(idx,&resolved,order,symbols)
                }
            }
        }
        Action::Insert {after,before,content,pick,line} => {
            if after.is_some() && before.is_some() {return Err("insert requires only one of after or before".into());}
            let before_side=before.is_some();
            let point=before.as_ref().or(after.as_ref()).ok_or("insert point is missing")?;
            let mut symbolic=false;
            let anchor=match point {
                Position::Line(n)=>*n,
                Position::Address(address) if address.eq_ignore_ascii_case("end")=>
                    if before_side {idx.count+1} else {idx.count},
                Position::Address(address)=> {
                    symbolic=true;
                    use crate::symbol_address::{select,Selection};
                    match select(symbols,address,*pick,*line)? {
                        Selection::NotFound=>return Err("insertion symbol not found".into()),
                        Selection::Ambiguous(hits)=>return Ok(Err(Ambiguity {
                            step:st.step,total:hits.len(),kind:"symbol",
                            candidates:hits.iter().take(8).enumerate().map(|(i,&n)|candidate(
                                i+1,symbols[n].full_start,symbols[n].end,"symbol",symbols,
                            )).collect(),
                        })),
                        Selection::Found(i)=>if before_side {symbols[i].full_start} else {symbols[i].end},
                    }
                }
            };
            if (before_side && (anchor==0 || anchor>idx.count+1)) || (!before_side && anchor>idx.count) {
                return Err("insert point outside snapshot".into());
            }
            let located=if st.expect.is_some() {
                if anchor==0 || anchor>idx.count {return Err("expect requires an existing insertion anchor line".into());}
                anchored_range(idx,anchor,anchor,st)?.0
            } else {anchor};
            if symbolic && located!=anchor {return Err("insertion expect cannot drift outside selected symbol".into());}
            let offset=if before_side {
                if located==idx.count+1 {idx.text.len()} else {idx.range(located,located)?.0}
            } else if located==0 {0} else {idx.range(located,located)?.1};
            let content=clean_input(content);
            let replacement=if offset==idx.text.len() && idx.count>0 && !idx.text.ends_with('\n') {
                format!("\n{}",body(&content))
            } else {format!("{}\n",body(&content))};
            Ok(Ok(Plan { patches: vec![patch(offset,offset,replacement)] }))
        }
        Action::Target {target,replace,pick,all,line} => {
            let target=clean_input(target);
            if target.is_empty() {return Err("target must not be empty".into());}
            // 一级：逐字节字面量。命中即不再往下猜。
            let hits:Vec<_>=idx.text.match_indices(&target).take(MAX_HITS+1).map(|(i,_)|i).collect();
            if hits.len()>MAX_HITS {return Err("target candidate budget exceeded".into());}
            let mut tier=Tier::Exact;
            let mut ranges:Vec<(usize,usize)>=hits.iter().map(|&a|(a,a+target.len())).collect();
            if ranges.is_empty() {
                // 二级：整行省略号。不完整的源码证据，一律要求显式选择；省略语法锚点失配不再掉进词法层。
                if let Some(candidates)=crate::elision::candidates(idx.text,&target)? {
                    if candidates.is_empty() { return Err("elision anchors not found".into()); }
                    tier=Tier::Elision;
                    ranges=candidates.iter().map(|c|(c.start,c.end)).collect();
                }
            }
            if ranges.is_empty() {
                // 三级：按行词法。空白差异可接受，字符串内部空格与多行相对缩进不可改。
                tier=Tier::Token;
                ranges=token_hits(idx,&target)?;
            }
            if ranges.is_empty() {
                // 四级：符号签名/名字/限定名，区间取完整定义 full_start..=end。
                tier=Tier::Structure;
                ranges=structure_hits(idx,&target,symbols);
            }
            if ranges.is_empty() {return Err("target not found".into());}
            let mut choices=if *all {(1..=ranges.len()).collect()} else {pick.clone()};
            // 只有逐字节命中能自动执行；推断性层级即使只有一个候选也必须显式点选。
            if choices.is_empty() && tier.auto_apply() {
                if ranges.len()==1 {choices.push(1);}
                else if let Some(line)=line {
                    if *line==0 {return Err("line hint must be positive".into());}
                    let nearest=ranges.iter().map(|&(a,_)|idx.line(a).abs_diff(*line)).min().unwrap();
                    let close:Vec<_>=ranges.iter().enumerate()
                        .filter(|(_,(a,_))|idx.line(*a).abs_diff(*line)==nearest)
                        .map(|(i,_)|i+1).collect();
                    if close.len()==1 {choices=close;}
                }
            }
            if choices.is_empty() {
                return Ok(Err(Ambiguity {step:st.step,total:ranges.len(),kind:tier.name(),
                    candidates:ranges.iter().take(8).enumerate().map(|(i,&(a,b))|
                        candidate(i+1,idx.line(a),idx.line(if b>a {b-1} else {a}),tier.name(),symbols)
                    ).collect()}));
            }
            choices.sort_unstable(); choices.dedup();
            if choices.iter().any(|&n|n==0||n>ranges.len()) {return Err("pick outside candidate range".into());}
            let replacement=clean_input(replace);
            if replacement.len().checked_mul(choices.len()).is_none_or(|n| n > MAX_TEXT) {
                return Err("expanded replacement budget exceeded".into());
            }
            let mut selected:Vec<Patch>=Vec::new();
            for choice in choices {
                let (start,end)=ranges[choice-1];
                let content=if replacement.is_empty() {String::new()} else if tier.auto_apply() {
                    // 逐字节命中是纯替换：坐标就是文件坐标。
                    replacement.clone()
                } else if tier==Tier::Elision {
                    // 整行块逐字命中：调用方坐标同样是文件坐标，只需补回行尾换行。
                    format!("{}{}",body(&replacement),if idx.text[..end].ends_with('\n') {"\n"} else {""})
                } else {
                    // 词法/结构命中的首行缩进是自由的：把调用方块重新基准到命中处缩进，
                    // 相对缩进保持不变，再补回行尾换行，避免把 Python 块拽出原有作用域。
                    let base_target=line_indent(&target);
                    let base_source=line_indent(idx.line_text(idx.line(start)));
                    let mut rebased=String::new();
                    for (i,line) in replacement.split('\n').enumerate() {
                        if i>0 {rebased.push('\n');}
                        let rest=line.strip_prefix(base_target).unwrap_or(line);
                        if rest.trim().is_empty() {continue;}
                        rebased.push_str(base_source);
                        rebased.push_str(rest);
                    }
                    format!("{}{}",rebased,if idx.text[..end].ends_with('\n') {"\n"} else {""})
                };
                let next=patch(start,end,content);
                if selected.iter().any(|previous|conflicts(previous,&next)) {
                    return Err("selected target ranges overlap".into());
                }
                selected.push(next);
            }
            Ok(Ok(Plan { patches: selected }))
        }
    }
}

pub fn run(original: &str,steps: &[Step],best_effort: bool) -> Result<Outcome,String> {
    run_with_symbols(original,steps,best_effort,&[])
}

pub fn run_with_symbols(original: &str,steps: &[Step],best_effort: bool,symbols: &[crate::symbols::Symbol]) -> Result<Outcome,String> {
    if original.len()>MAX_TEXT || steps.is_empty() || steps.len()>MAX_STEPS {return Err("edit input budget exceeded".into());}
    let mut seen=std::collections::HashSet::new();
    if steps.iter().any(|s|s.step==0||!seen.insert(s.step)) {return Err("step identifiers must be unique positive integers".into());}
    let reason_bytes=steps.iter().try_fold(0usize,|total,s| {
        let length=s.reason.as_ref().map_or(0,String::len);
        if length>2000 {return None;}
        total.checked_add(length)
    }).ok_or("step reason budget exceeded")?;
    if reason_bytes>64*1024 {return Err("cumulative step reason budget exceeded".into());}
    // Bound cumulative inserted text before allocating normalized replacement copies.
    let payload=steps.iter().try_fold(0usize,|total,s| {
        let n=match &s.action {
            Action::Replace{content,..}|Action::Insert{content,..}=>content.len(),
            Action::Symbol{symbol,content,..}=>symbol.len().checked_add(content.len())?,
            Action::Target{target,replace,..}=>target.len().checked_add(replace.len())?,
            Action::Delete{..}=>0,
        };
        let n=n.checked_add(s.expect.as_ref().map_or(0,String::len))?;
        total.checked_add(n)
    }).ok_or("edit payload overflow")?;
    if payload>MAX_TEXT {return Err("edit payload budget exceeded".into());}
    let text=normalize(original);
    let idx=Lines::new(&text);
    let mut patches:Vec<Patch>=Vec::new();
    let mut errors=Vec::new();
    let mut ambiguities=Vec::new();
    let mut applied=Vec::new();
    let mut planned_bytes=0usize;
    let mut overlap_budget=1_000_000usize;
    for (order,st) in steps.iter().enumerate() {
        match plan(&idx,st,order,symbols) {
            Err(message)=>errors.push(Issue{step:st.step,message}),
            Ok(Err(a))=>ambiguities.push(a),
            Ok(Ok(planned))=>{
                let comparisons=planned.patches.len().checked_mul(patches.len()).ok_or("overlap budget overflow")?;
                if comparisons>overlap_budget || patches.len().saturating_add(planned.patches.len())>MAX_HITS {
                    return Err("edit planning work budget exceeded".into());
                }
                overlap_budget-=comparisons;
                let next_bytes=planned.patches.iter().try_fold(0usize,|n,p|n.checked_add(p.text.len()));
                if next_bytes.and_then(|n|n.checked_add(planned_bytes)).is_none_or(|n|n>MAX_TEXT) {
                    errors.push(Issue{step:st.step,message:"cumulative plan budget exceeded".into()});
                } else if planned.patches.iter().any(|p|patches.iter().any(|old|conflicts(p,old))) {
                    errors.push(Issue{step:st.step,message:"overlap with an earlier step in original snapshot".into()});
                } else {
                    planned_bytes += next_bytes.unwrap_or(0);
                    applied.push(st.step);
                    patches.extend(planned.patches);
                }
            }
        }
    }
    let status=if !ambiguities.is_empty() {"ambiguous"} else if (!best_effort&&!errors.is_empty())||patches.is_empty() {"error"} else {"ok"};
    if status!="ok" {return Ok(Outcome{status,text:None,changed:false,applied:vec![],placements:vec![],errors,ambiguities});}
    patches.sort_by_key(|p|(p.start,p.end,p.order));
    let output_len=patches.iter().try_fold(text.len(),|n,p|n.checked_sub(p.end-p.start)?.checked_add(p.text.len()))
        .ok_or("output size overflow")?;
    if output_len>MAX_TEXT {return Err("edit output budget exceeded".into());}
    let mut output=String::with_capacity(output_len);
    let mut cursor=0;
    let mut placements=Vec::with_capacity(patches.len());
    for p in patches {
        if p.start<cursor || !text.is_char_boundary(p.start)||!text.is_char_boundary(p.end) {
            return Err(format!("invalid patch boundary for step {}",p.step));
        }
        output.push_str(&text[cursor..p.start]);
        let new_start_byte=output.len();
        output.push_str(&p.text);
        placements.push(Placement {
            step:p.step,op:steps[p.order].action.name(),
            original_start_byte:p.start,original_end_byte:p.end,
            new_start_byte,new_end_byte:output.len(),
            original_start_line:idx.line(p.start),
            original_end_line:idx.line(if p.end>p.start {p.end-1}else{p.start}),
            insertion:p.start==p.end,
            new_start_line:None,new_end_line:None,
        });
        cursor=p.end;
    }
    output.push_str(&text[cursor..]);
    let changed=output!=text;
    let new_lines=Lines::new(&output);
    for placement in &mut placements {
        if placement.new_end_byte>placement.new_start_byte {
            placement.new_start_line=Some(new_lines.line(placement.new_start_byte));
            placement.new_end_line=Some(new_lines.line(placement.new_end_byte-1));
        }
    }
    Ok(Outcome{status,text:Some(output),changed,applied,placements,errors,ambiguities})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn steps(v:serde_json::Value)->Vec<Step>{serde_json::from_value(v).unwrap()}
    #[test]
    fn elision_requires_explicit_selection_and_literal_wins() {
        let source="head\nmiddle\ntail\nlast\n";
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"head\n...\ntail","replace":"new"}
        ]));
        let rejected=run(source,&actions,false).unwrap();
        assert_eq!(rejected.status,"ambiguous");
        assert_eq!(rejected.ambiguities[0].total,1);
        assert!(rejected.text.is_none());
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"head\n...\ntail","replace":"new","pick":[1]}
        ]));
        let result=run(source,&actions,false).unwrap();
        assert_eq!(result.text.as_deref(),Some("new\nlast\n"));
        assert_eq!(result.placements[0].original_end_line,3);
        let literal=steps(serde_json::json!([
            {"step":1,"op":"target","target":"def f():\n    ...","replace":"def f():\n    pass"}
        ]));
        assert_eq!(run("def f():\n    ...\n",&literal,false).unwrap().text.as_deref(),
            Some("def f():\n    pass\n"));
        let overlapping=steps(serde_json::json!([
            {"step":1,"op":"target","target":"head\n...\ntail","replace":"","pick":[1,2]}
        ]));
        assert_eq!(run("head\nx\ntail\ny\ntail\n",&overlapping,false).unwrap().status,"error");
    }

    #[test]
    fn display_prefixes_are_all_or_nothing_and_cleaned_once() {
        assert_eq!(clean_input("  12 |   x\n>13 |     y\n"),"  x\n    y\n");
        assert_eq!(clean_input("12 | x\nplain"),"12 | x\nplain");
        assert_eq!(clean_input("| 12 | x |"),"| 12 | x |");
        assert_eq!(clean_input("1| x"),"1| x");
        assert_eq!(clean_input("1  | x"),"1  | x");
        assert_eq!(clean_input("1 | 2 | code"),"2 | code");
        let actions=steps(serde_json::json!([
            {"step":1,"op":"replace","start":1,"end":1,
             "expect":"9 | before","content":"9 |   after"}
        ]));
        assert_eq!(run("before\n",&actions,false).unwrap().text.as_deref(),Some("  after\n"));
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"before","replace":"1 | 2 | code"}
        ]));
        assert_eq!(run("before",&actions,false).unwrap().text.as_deref(),Some("2 | code"));
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"code","replace":"changed"}
        ]));
        assert_eq!(run("1 | code",&actions,false).unwrap().text.as_deref(),Some("1 | changed"));
        let source="function f() {}\n";
        let mut parser=tree_sitter::Parser::new();
        let outline=crate::symbols::outline(crate::lang::Lang::from_path(
            std::path::Path::new("a.js")).unwrap(),source,&mut parser).unwrap();
        let actions=steps(serde_json::json!([
            {"step":1,"op":"symbol","symbol":"f","content":"1 | 2 | code"}
        ]));
        assert_eq!(run_with_symbols(source,&actions,false,&outline.symbols).unwrap()
            .text.as_deref(),Some("2 | code\n"));
    }

    #[test]
    fn step_reasons_are_preserved_and_bounded() {
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"a","replace":"b","reason":"修正边界"}
        ]));
        assert_eq!(actions[0].reason.as_deref(),Some("修正边界"));
        assert_eq!(run("a",&actions,false).unwrap().text.as_deref(),Some("b"));
        let oversized=steps(serde_json::json!([
            {"step":1,"op":"target","target":"a","replace":"b","reason":"x".repeat(2001)}
        ]));
        assert!(run("a",&oversized,false).is_err());
        let many:Vec<Step>=(1..=34).map(|step|serde_json::from_value(
            serde_json::json!({"step":step,"op":"target","target":"a","replace":"b",
                "reason":"x".repeat(2000)})).unwrap()).collect();
        assert!(run("a",&many,true).is_err());
    }

    #[test]
    fn anchor_drift_is_native_bounded_and_ambiguity_safe() {
        let s=steps(serde_json::json!([
            {"step":1,"op":"replace","start":1,"end":1,"expect":"anchor","content":"changed"}
        ]));
        assert_eq!(run("prefix\nanchor\nend\n",&s,false).unwrap().text.as_deref(),Some("prefix\nchanged\nend\n"));
        let s=steps(serde_json::json!([
            {"step":1,"op":"delete","start":2,"end":2,"expect":"anchor"}
        ]));
        assert_eq!(run("anchor\nmiddle\nanchor\n",&s,false).unwrap().status,"error");
        let s=steps(serde_json::json!([
            {"step":1,"op":"delete","start":1,"end":1,"expect":"anchor","drift":0}
        ]));
        assert_eq!(run("prefix\nanchor\n",&s,false).unwrap().status,"error");
        let s=steps(serde_json::json!([
            {"step":1,"op":"delete","start":1,"end":1,"expect":"anchor"}
        ]));
        assert_eq!(run("  anchor\n",&s,false).unwrap().status,"error",
            "indentation is evidence, not automatically disposable whitespace");
    }

    #[test]
    fn insertion_expect_relocates_against_original_snapshot() {
        let s=steps(serde_json::json!([
            {"step":1,"op":"insert","after":1,"expect":"anchor","content":"inserted"}
        ]));
        assert_eq!(run("prefix\nanchor\nlast",&s,false).unwrap().text.as_deref(),
            Some("prefix\nanchor\ninserted\nlast"));
        let s=steps(serde_json::json!([
            {"step":1,"op":"insert","after":0,"expect":"anchor","content":"inserted"}
        ]));
        assert_eq!(run("anchor\n",&s,false).unwrap().status,"error");
        let s=steps(serde_json::json!([
            {"step":1,"op":"insert","after":1,"expect":"anchor","content":"last"}
        ]));
        assert_eq!(run("prefix\nanchor",&s,false).unwrap().text.as_deref(),
            Some("prefix\nanchor\nlast"));
    }

    #[test]
    fn native_original_coordinates_and_unicode() {
        let s=steps(serde_json::json!([
            {"step":1,"op":"replace","start":1,"end":1,"content":"甲\n乙"},
            {"step":2,"op":"target","target":"🐱","replace":"猫"}]));
        let result=run("a\r\n🐱\r\n",&s,false).unwrap();
        assert_eq!(result.text.as_deref(),Some("甲\n乙\n猫\n"));
        let first=&result.placements[0];
        assert_eq!((first.original_start_byte,first.original_end_byte),(0,2));
        assert_eq!((first.new_start_byte,first.new_end_byte),(0,8));
        assert_eq!((first.new_start_line,first.new_end_line),(Some(1),Some(2)));
        let second=&result.placements[1];
        assert_eq!((second.original_start_byte,second.original_end_byte),(2,6));
        assert_eq!((second.new_start_byte,second.new_end_byte),(8,11));
        assert_eq!((second.original_start_line,second.new_start_line),(2,Some(3)));
    }
    #[test]
    fn overlap_atomic_and_best_effort() {
        let s=steps(serde_json::json!([
            {"step":1,"op":"delete","start":1,"end":2},
            {"step":2,"op":"replace","start":2,"end":3,"content":"x"}]));
        assert_eq!(run("a\nb\nc\n",&s,false).unwrap().status,"error");
        assert_eq!(run("a\nb\nc\n",&s,true).unwrap().text.as_deref(),Some("c\n"));
    }
    #[test]
    fn ambiguity_never_changes_text() {
        let s=steps(serde_json::json!([{"step":1,"op":"target","target":"x","replace":"y"}]));
        let r=run("x x",&s,true).unwrap();
        assert_eq!(r.status,"ambiguous"); assert!(r.text.is_none()); assert_eq!(r.ambiguities[0].total,2);
    }
    #[test]
    fn placements_cover_same_point_inserts_and_deleted_ranges() {
        let actions=steps(serde_json::json!([
            {"step":1,"op":"insert","after":0,"content":"甲"},
            {"step":2,"op":"insert","after":0,"content":"乙"},
            {"step":3,"op":"delete","start":1,"end":1}
        ]));
        let result=run("原\n末",&actions,false).unwrap();
        assert_eq!(result.text.as_deref(),Some("甲\n乙\n末"));
        assert_eq!(result.placements.len(),3);
        assert_eq!(result.placements[0].new_start_line,Some(1));
        assert_eq!(result.placements[1].new_start_line,Some(2));
        assert!(result.placements[0].insertion);
        assert_eq!(result.placements[2].new_start_line,None);
        assert_eq!(result.placements[2].new_end_line,None);
        assert_eq!(result.placements[2].original_end_byte,4);
        let rejected=run("原\n末",&steps(serde_json::json!([
            {"step":1,"op":"target","target":"absent","replace":"x"}
        ])),false).unwrap();
        assert!(rejected.placements.is_empty());
    }

    #[test]
    fn insertion_order_and_no_final_newline() {
        let s=steps(serde_json::json!([
            {"step":1,"op":"insert","after":0,"content":"甲"},
            {"step":2,"op":"insert","after":0,"content":"乙"}]));
        assert_eq!(run("原",&s,false).unwrap().text.as_deref(),Some("甲\n乙\n原"));
        let s=steps(serde_json::json!([{"step":1,"op":"insert","after":1,"content":"末"}]));
        assert_eq!(run("原",&s,false).unwrap().text.as_deref(),Some("原\n末"));
    }

    #[test]
    fn token_layer_needs_explicit_pick_and_plans_without_expected_hash() {
        // 只有空白差异：字面量层不命中，词法层命中，即使只有一个候选也先返回候选。
        let s=steps(serde_json::json!([
            {"step":1,"op":"target","target":"const   a = 1;","replace":"const a = 2;"}
        ]));
        let rejected=run("const a = 1;\nkeep\n",&s,false).unwrap();
        assert_eq!(rejected.status,"ambiguous");
        assert_eq!(rejected.ambiguities[0].kind,"token");
        assert_eq!(rejected.ambiguities[0].total,1);
        assert_eq!(rejected.ambiguities[0].candidates[0].kind,"token");
        assert!(rejected.ambiguities[0].candidates[0].scope.is_none(),"无 AST 时不许伪造 scope");
        // 多候选仍必须由 pick 消歧，不得猜测。
        let repeated=run("const a = 1;\nconst a = 1;\n",&s,false).unwrap();
        assert_eq!(repeated.status,"ambiguous");
        assert_eq!(repeated.ambiguities[0].total,2);
        // 选定 token 候选后可直接规划，不再要求外层 expectedHash。
        let s=steps(serde_json::json!([
            {"step":1,"op":"target","target":"const   a = 1;","replace":"const a = 2;","pick":[1]}
        ]));
        let applied=run("const a = 1;\nkeep\n",&s,false).unwrap();
        assert_eq!(applied.status,"ok");
        assert_eq!(applied.text.as_deref(),Some("const a = 2;\nkeep\n"));
    }

    #[test]
    fn token_layer_keeps_quoted_spaces_and_relative_indent() {
        // 引号字符串内部的空格不许被折叠。
        let s=steps(serde_json::json!([{"step":1,"op":"target","target":"f('a b')","replace":"g('a b')","pick":[1]}]));
        assert_eq!(run("f('a  b')\n",&s,false).unwrap().status,"error");
        let s=steps(serde_json::json!([{
            "step":1,"op":"target","target":"f( 'a  b' )","replace":"g('a  b')","pick":[1]}]));
        assert_eq!(run("f('a  b')\n",&s,false).unwrap().text.as_deref(),Some("g('a  b')\n"),
            "字符串外的空白可以不同，字符串内部必须逐字相同");
        // 多行块：首行缩进自由，后续行只认相对缩进。
        // 注意目标里刻意多打空格，否则源码本身就是字面量，会先被逐字节层命中。
        let source="def f():\n    if x:\n        y()\nkeep\n";
        let s=steps(serde_json::json!([
            {"step":1,"op":"target","target":"if   x:\n        y()","replace":"if x:\n        y2()","pick":[1]}
        ]));
        let wrong=run(source,&s,false).unwrap();
        assert_eq!(wrong.status,"error","相对缩进差 4 格不许当成同一处");
        let s=steps(serde_json::json!([
            {"step":1,"op":"target","target":"if   x:\n    y()","replace":"if x:\n    y2()","pick":[1]}
        ]));
        assert_eq!(run(source,&s,false).unwrap().text.as_deref(),
            Some("def f():\n    if x:\n        y2()\nkeep\n"),
            "替换块要重新基准到命中处缩进，不能把 Python 块拽出作用域");
    }

    #[test]
    fn structure_layer_matches_symbol_signature_and_qualified_name() {
        let source="class Box {\n  dup() { return 1; }\n}\n";
        let mut parser=tree_sitter::Parser::new();
        let outline=crate::symbols::outline(crate::lang::Lang::from_path(
            std::path::Path::new("a.js")).unwrap(),source,&mut parser).unwrap();
        let s=steps(serde_json::json!([{"step":1,"op":"target","target":"Box.dup","replace":"dup() { return 2; }"}]));
        let rejected=run_with_symbols(source,&s,false,&outline.symbols).unwrap();
        assert_eq!(rejected.status,"ambiguous");
        assert_eq!(rejected.ambiguities[0].kind,"structure");
        assert_eq!(rejected.ambiguities[0].candidates[0].scope.as_deref(),Some("Box.dup"));
        let s=steps(serde_json::json!([{
            "step":1,"op":"target","target":"Box.dup","replace":"dup() { return 2; }","pick":[1]}]));
        let applied=run_with_symbols(source,&s,false,&outline.symbols).unwrap();
        assert_eq!(applied.text.as_deref(),Some("class Box {\n  dup() { return 2; }\n}\n"));
        let s=steps(serde_json::json!([{
            "step":1,"op":"target","target":"dup() { return 1; }","replace":"dup() { return 3; }","pick":[1]}]));
        assert_eq!(run_with_symbols(source,&s,false,&outline.symbols).unwrap().text.as_deref(),
            Some("class Box {\n  dup() { return 3; }\n}\n"),
            "签名层命中同样落在整段定义上");
    }

    #[test]
    fn exact_and_elision_layers_stay_automatically_applicable() {
        let s=steps(serde_json::json!([{"step":1,"op":"target","target":"two","replace":"猫"}]));
        let exact=run("one\ntwo\n",&s,false).unwrap();
        assert_eq!(exact.text.as_deref(),Some("one\n猫\n"));
        let s=steps(serde_json::json!([
            {"step":1,"op":"target","target":"head\n...\ntail","replace":"new","pick":[1]}]));
        let elision=run("head\nmid\ntail\n",&s,false).unwrap();
        assert_eq!(elision.text.as_deref(),Some("new\n"));
        let s=steps(serde_json::json!([{"step":1,"op":"target","target":"x","replace":"y"}]));
        let ambiguous=run("x x",&s,false).unwrap();
        assert_eq!(ambiguous.ambiguities[0].kind,"exact");
    }
}