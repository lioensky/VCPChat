//! Native editing plans. Byte ranges always belong to the original LF snapshot.
//! This module does not write files. Fuzzy/symbol/elision planning is not implemented here yet.
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
    Insert { after: usize, content: String },
    Target { target: String, replace: String, #[serde(default)] pick: Vec<usize> },
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate { pub index: usize, pub start_line: usize, pub end_line: usize }
#[derive(Debug, Serialize)]
pub struct Issue { pub step: usize, pub message: String }
#[derive(Debug, Serialize)]
pub struct Ambiguity { pub step: usize, pub total: usize, pub candidates: Vec<Candidate> }
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
    if nonempty.peek().is_none() || !nonempty.all(|line|display_prefix(line).is_some()) {
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
fn plan(idx: &Lines<'_>, st: &Step, order: usize, symbols: &[crate::symbols::Symbol]) -> Result<Result<Vec<Patch>,Ambiguity>,String> {
    let patch = |start,end,text| Patch { start,end,text,order,step:st.step };
    match &st.action {
        Action::Replace {start,end,..} | Action::Delete {start,end} => {
            let (start,end)=anchored_range(idx,*start,*end,st)?;
            let (a,b)=idx.range(start,end)?;
            let content=match &st.action { Action::Replace{content,..}=>clean_input(content), _=>String::new() };
            let replacement=if content.is_empty() {String::new()} else {
                format!("{}{}",body(&content),if idx.text[..b].ends_with('\n') {"\n"} else {""})
            };
            Ok(Ok(vec![patch(a,b,replacement)]))
        }
        Action::Symbol {symbol,content,body,pick,line} => {
            use crate::symbol_address::{select, range, Selection};
            match select(symbols,symbol,*pick,*line)? {
                Selection::NotFound => Err("symbol not found in snapshot outline".into()),
                Selection::Ambiguous(hits) => Ok(Err(Ambiguity {
                    step:st.step,total:hits.len(),
                    candidates:hits.iter().take(8).enumerate().map(|(i,&n)|Candidate {
                        index:i+1,start_line:symbols[n].full_start,end_line:symbols[n].end
                    }).collect(),
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
        Action::Insert {after,content} => {
            if *after > idx.count {return Err("insert point outside snapshot".into());}
            let after=if st.expect.is_some() {
                if *after==0 {return Err("expect requires an existing insertion anchor line".into());}
                anchored_range(idx,*after,*after,st)?.0
            } else {*after};
            let offset=if after==0 {0} else {idx.range(after,after)?.1};
            let content=clean_input(content);
            let replacement=if after==idx.count && idx.count>0 && !idx.text.ends_with('\n') {
                format!("\n{}",body(&content))
            } else {format!("{}\n",body(&content))};
            Ok(Ok(vec![patch(offset,offset,replacement)]))
        }
        Action::Target {target,replace,pick} => {
            let target=clean_input(target);
            if target.is_empty() {return Err("target must not be empty".into());}
            let hits:Vec<_>=idx.text.match_indices(&target).take(MAX_HITS+1).map(|(i,_)|i).collect();
            if hits.len()>MAX_HITS {return Err("target candidate budget exceeded".into());}
            if hits.is_empty() {
                let Some(candidates)=crate::elision::candidates(idx.text,&target)? else {
                    return Err("target not found".into());
                };
                if candidates.is_empty() {return Err("elision anchors not found".into());}
                // Elision is incomplete source evidence, not an exact replacement target.
                // Require an explicit selection even when only one pair was found.
                if pick.is_empty() {
                    return Ok(Err(Ambiguity {
                        step:st.step,total:candidates.len(),
                        candidates:candidates.iter().take(8).enumerate().map(|(i,c)|Candidate {
                            index:i+1,start_line:c.start_line,end_line:c.end_line,
                        }).collect(),
                    }));
                }
                let mut choices=pick.clone();
                choices.sort_unstable();choices.dedup();
                if choices.iter().any(|&n|n==0||n>candidates.len()) {
                    return Err("pick outside elision candidate range".into());
                }
                let replacement=clean_input(replace);
                if replacement.len().checked_add(1).and_then(|n|n.checked_mul(choices.len()))
                    .is_none_or(|n|n>MAX_TEXT) {
                    return Err("expanded elision replacement budget exceeded".into());
                }
                let mut selected:Vec<Patch>=Vec::new();
                for choice in choices {
                    let hit=&candidates[choice-1];
                    let content=if replacement.is_empty() {String::new()} else {
                        format!("{}{}",body(&replacement),
                            if idx.text[..hit.end].ends_with('\n') {"\n"} else {""})
                    };
                    let next=patch(hit.start,hit.end,content);
                    if selected.iter().any(|previous|conflicts(previous,&next)) {
                        return Err("selected elision ranges overlap".into());
                    }
                    selected.push(next);
                }
                return Ok(Ok(selected));
            }
            if pick.is_empty() && hits.len()>1 {
                return Ok(Err(Ambiguity {step:st.step,total:hits.len(),candidates:hits.iter().take(8).enumerate().map(|(i,&a)|
                    Candidate{index:i+1,start_line:idx.line(a),end_line:idx.line(a+target.len()-1)}).collect()}));
            }
            let mut choices=if pick.is_empty() {vec![1]} else {pick.clone()};
            choices.sort_unstable(); choices.dedup();
            if choices.iter().any(|&n|n==0||n>hits.len()) {return Err("pick outside candidate range".into());}
            let replacement=clean_input(replace);
            if replacement.len().checked_mul(choices.len()).is_none_or(|n| n > MAX_TEXT) {
                return Err("expanded replacement budget exceeded".into());
            }
            Ok(Ok(choices.into_iter().map(|n|patch(hits[n-1],hits[n-1]+target.len(),replacement.clone())).collect()))
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
            Ok(Ok(next))=>{
                let comparisons=next.len().checked_mul(patches.len()).ok_or("overlap budget overflow")?;
                if comparisons>overlap_budget || patches.len().saturating_add(next.len())>MAX_HITS {
                    return Err("edit planning work budget exceeded".into());
                }
                overlap_budget-=comparisons;
                let next_bytes=next.iter().try_fold(0usize,|n,p|n.checked_add(p.text.len()));
                if next_bytes.and_then(|n|n.checked_add(planned_bytes)).is_none_or(|n|n>MAX_TEXT) {
                    errors.push(Issue{step:st.step,message:"cumulative plan budget exceeded".into()});
                } else if next.iter().any(|p|patches.iter().any(|old|conflicts(p,old))) {
                    errors.push(Issue{step:st.step,message:"overlap with an earlier step in original snapshot".into()});
                } else {
                    planned_bytes += next_bytes.unwrap_or(0);
                    applied.push(st.step); patches.extend(next);
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
}