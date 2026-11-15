//! Parse project-local todo sequence references, never database row IDs.
//! No state changes occur here.
use serde_json::Value;

const MAX_BYTES: usize = 8192;
const MAX_REFS: usize = 200;
const MAX_SEQ: u64 = 9_007_199_254_740_991; // JS safe integer compatibility.

pub fn parse(value: Option<&Value>) -> Result<Vec<i64>, String> {
    let Some(value) = value else { return Ok(Vec::new()); };
    let items: Vec<&Value> = match value {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) if items.len() <= MAX_REFS => items.iter().collect(),
        Value::Array(_) => return Err("todo reference count budget exceeded".into()),
        _ => vec![value],
    };
    let mut result = Vec::new();
    let mut bytes = 0usize;
    let mut references = 0usize;
    for item in items {
        let text = match item {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.as_u64()
                .filter(|n| *n > 0 && *n <= MAX_SEQ)
                .ok_or("todo sequence must be a positive safe integer")?.to_string(),
            _ => return Err("todo references must be strings or positive integers".into()),
        };
        bytes = bytes.checked_add(text.len()).ok_or("todo byte budget overflow")?;
        if bytes > MAX_BYTES { return Err("todo reference byte budget exceeded".into()); }
        for token in text.split(|c: char|
            c.is_whitespace() || matches!(c, ',' | '，' | '、' | ';' | '；')
        ).filter(|s| !s.is_empty()) {
            references += 1;
            if references > MAX_REFS { return Err("todo reference count budget exceeded".into()); }
            let token = token.strip_prefix('#').unwrap_or(token);
            if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
                return Err("todo sequence must contain decimal digits only".into());
            }
            let sequence = token.parse::<u64>().ok()
                .filter(|n| *n > 0 && *n <= MAX_SEQ)
                .ok_or("todo sequence outside positive safe integer range")? as i64;
            if !result.contains(&sequence) { result.push(sequence); }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_separators_arrays_and_primary_order() {
        assert!(parse(None).unwrap().is_empty());
        assert!(parse(Some(&Value::Null)).unwrap().is_empty());
        assert!(parse(Some(&json!("  "))).unwrap().is_empty());
        assert_eq!(parse(Some(&json!("#3 #2，3、4;5；6,7"))).unwrap(),
            vec![3,2,4,5,6,7]);
        assert_eq!(parse(Some(&json!([2,"#3 #2",4]))).unwrap(),vec![2,3,4]);
    }

    #[test]
    fn invalid_and_over_budget_inputs_fail_closed() {
        for value in [
            json!(0), json!(-1), json!(1.5), json!(true), json!({}),
            json!([null]), json!(["2",["3"]]), json!("#"), json!("##2"),
            json!("2 nope"), json!("1e2"), json!("+2"), json!("２"),
            json!("9007199254740992"), json!("18446744073709551616"),
            json!("x".repeat(MAX_BYTES+1)),
            json!(vec![1; MAX_REFS+1]),
            json!("1 ".repeat(MAX_REFS+1)),
        ] {
            assert!(parse(Some(&value)).is_err(),"{value}");
        }
    }
}