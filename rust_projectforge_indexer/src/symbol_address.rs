//! Symbol addresses operate on the outline of the SAME normalized snapshot.
//! Similarity suggestions never authorize an edit.
use crate::symbols::Symbol;

#[derive(Debug, PartialEq, Eq)]
pub enum Selection {
    Found(usize),
    Ambiguous(Vec<usize>),
    NotFound,
}

pub fn normalize(raw: &str) -> String {
    let raw = raw.trim();
    let raw = if raw.get(..7).is_some_and(|s| s.eq_ignore_ascii_case("symbol:")) {
        &raw[7..]
    } else { raw };
    let raw = raw.trim();
    let raw = raw.strip_suffix("()").unwrap_or(raw);
    raw.replace("::", ".").split('.').map(str::trim)
        .filter(|s| !s.is_empty()).collect::<Vec<_>>().join(".")
}

fn score(symbol: &Symbol, query: &str) -> u16 {
    let qual = normalize(&symbol.qualified);
    let qual = if qual.is_empty() { symbol.name.clone() } else { qual };
    let name = &symbol.name;
    if qual == query { return 1000; }
    if name == query { return 900; }
    if qual.ends_with(&format!(".{query}")) { return 800; }
    let q = query.to_lowercase();
    let qual = qual.to_lowercase();
    if qual == q { return 990; }
    if name.to_lowercase() == q { return 890; }
    if qual.ends_with(&format!(".{q}")) { return 790; }
    0
}

pub fn select(
    symbols: &[Symbol], reference: &str, pick: Option<usize>, line: Option<usize>,
) -> Result<Selection, String> {
    if reference.len() > 4096 { return Err("symbol address exceeds budget".into()); }
    let query = normalize(reference);
    if query.is_empty() { return Err("empty symbol reference".into()); }
    let mut best = 0;
    let mut hits = Vec::new();
    for (i, symbol) in symbols.iter().enumerate() {
        let s = score(symbol, &query);
        if s == 0 { continue; }
        if s > best { best = s; hits.clear(); }
        if s == best { hits.push(i); }
    }
    if hits.is_empty() { return Ok(Selection::NotFound); }
    if let Some(pick) = pick {
        return hits.get(pick.checked_sub(1).ok_or("pick must be positive")?).copied()
            .map(Selection::Found).ok_or_else(|| "symbol pick out of range".into());
    }
    if hits.len() == 1 { return Ok(Selection::Found(hits[0])); }
    if let Some(line) = line {
        if line == 0 { return Err("line hint must be positive".into()); }
        // Prefer smallest containing range; otherwise nearest signature.
        // A tied hint remains ambiguous, unlike the old first-candidate fallback.
        let rank = |i: usize| {
            let s = &symbols[i];
            if line >= s.full_start && line <= s.end {
                (0, s.end.saturating_sub(s.full_start))
            } else { (1, s.start.abs_diff(line)) }
        };
        let min = hits.iter().map(|&i| rank(i)).min().ok_or("empty candidate set")?;
        hits.retain(|&i| rank(i) == min);
        if hits.len() == 1 { return Ok(Selection::Found(hits[0])); }
    }
    Ok(Selection::Ambiguous(hits))
}

pub fn range(symbol: &Symbol, body: bool, context: usize, line_count: usize) -> Result<(usize, usize), String> {
    if symbol.full_start == 0 || symbol.full_start > symbol.start
        || symbol.start > symbol.end || symbol.end > line_count {
        return Err("symbol range does not belong to snapshot".into());
    }
    let start = if body { symbol.start } else { symbol.full_start };
    Ok((start.saturating_sub(context).max(1), symbol.end.saturating_add(context).min(line_count)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{lang::Lang, symbols};
    use tree_sitter::Parser;

    #[test]
    fn native_outline_selection_and_comment_range() {
        let source = "/** docs */\nfunction alpha() {\n return 1;\n}\nclass Box {\n dup() {}\n}\nclass Crate {\n dup() {}\n}\n";
        let o = symbols::outline(Lang::from_name("javascript").unwrap(), source, &mut Parser::new()).unwrap();
        let selected = select(&o.symbols, "alpha", None, None).unwrap();
        let Selection::Found(i) = selected else { panic!("expected alpha"); };
        assert_eq!(range(&o.symbols[i], false, 0, o.line_count).unwrap(), (1,4));
        assert_eq!(range(&o.symbols[i], true, 0, o.line_count).unwrap(), (2,4));
        assert!(matches!(select(&o.symbols,"dup",None,None).unwrap(),Selection::Ambiguous(_)));
        let Selection::Found(i) = select(&o.symbols,"Crate::dup()",None,None).unwrap() else { panic!("expected Crate.dup"); };
        assert_eq!(o.symbols[i].start,9);
        assert_eq!(select(&o.symbols,"dupp",None,None).unwrap(),Selection::NotFound);
    }

    #[test]
    fn equidistant_hint_does_not_authorize_first_candidate() {
        let make = |start| Symbol { name:"f".into(),qualified:"f".into(),kind:"function",
            start,end:start,full_start:start,depth:0,parent:None,signature:String::new() };
        let symbols = vec![make(2),make(6)];
        assert_eq!(select(&symbols,"f",None,Some(4)).unwrap(),Selection::Ambiguous(vec![0,1]));
        assert_eq!(select(&symbols,"f",Some(2),None).unwrap(),Selection::Found(1));
        assert!(select(&symbols,"f",Some(0),None).is_err());
        assert!(range(&symbols[1],false,0,5).is_err());
        assert_eq!(normalize("symbol: Store :: method()"),"Store.method");
    }
}