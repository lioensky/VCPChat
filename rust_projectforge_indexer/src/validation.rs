//! Validation decisions stay native. Worker performs ecosystem analysis only.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 10_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub line: usize,
    pub column: usize,
    pub severity: String,
    pub message: String,
    pub rule_id: Option<String>,
    pub fatal: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    file_path: String,
    before_text_hash: String,
    after_text_hash: String,
    pub supported: bool,
    pub validator_version: String,
    pub introduced: Vec<Diagnostic>,
    pub existing: usize,
}
impl Review {
    pub fn rejects_syntax(&self, enabled: bool) -> bool {
        enabled && self.introduced.iter().any(|d| d.fatal)
    }
}
fn hash(text: &str) -> String { format!("{:x}", Sha256::digest(text.as_bytes())) }
fn diagnostics(value: &Value) -> Result<Vec<Diagnostic>, String> {
    let array=value.as_array().ok_or("missing diagnostic array")?;
    if array.len()>MAX_DIAGNOSTICS {return Err("diagnostic count budget exceeded".into());}
    let list:Vec<Diagnostic>=serde_json::from_value(value.clone()).map_err(|e|e.to_string())?;
    for d in &list {
        if d.line==0 || d.column==0 || !matches!(d.severity.as_str(),"error"|"warning")
            || d.message.len()>32_768 || d.rule_id.as_ref().is_some_and(|s|s.len()>1024) {
            return Err("invalid diagnostic fields".into());
        }
        if d.rule_id.as_deref()==Some("linter-error") {
            return Err("validator execution failed".into());
        }
    }
    Ok(list)
}

/// `before` and `after` are exact normalized texts of the native plan.
pub fn request(file_path:&str,before:&str,after:&str)->Result<Vec<u8>,String> {
    if file_path.is_empty() || file_path.len()>4096 || file_path.contains('\0')
        || before.len()>8*1024*1024 || after.len()>8*1024*1024
        || before.contains('\r') || after.contains('\r') {
        return Err("invalid validation request or budget".into());
    }
    serde_json::to_vec(&serde_json::json!({
        "protocolVersion":1,"filePath":file_path,"before":before,"after":after,
        "beforeHash":hash(before),"afterHash":hash(after)
    })).map_err(|e|e.to_string())
}

pub fn decode(bytes:&[u8],file_path:&str,before:&str,after:&str)->Result<Review,String> {
    if bytes.len()>MAX_RESPONSE {return Err("validation response budget exceeded".into());}
    let wire:Value=serde_json::from_slice(bytes).map_err(|e|e.to_string())?;
    if wire["ok"]!=true {return Err("validation worker failed; not a successful review".into());}
    let result=&wire["result"];
    if result["protocolVersion"]!=1 || result["validatorVersion"]!="pf-validation-v1"
        || result["filePath"].as_str()!=Some(file_path)
        || result["beforeHash"].as_str()!=Some(hash(before).as_str())
        || result["afterHash"].as_str()!=Some(hash(after).as_str()) {
        return Err("validation identity/protocol mismatch".into());
    }
    let version="pf-validation-v1".to_string();
    if result["state"]=="unsupported" {
        return Ok(Review{file_path:file_path.into(),before_text_hash:hash(before),
            after_text_hash:hash(after),supported:false,validator_version:version,introduced:vec![],existing:0});
    }
    if result["state"]!="completed" {return Err("validation did not complete".into());}
    let previous=diagnostics(&result["before"])?;
    let following=diagnostics(&result["after"])?;
    let mut remaining:HashMap<(String,Option<String>,String,bool),usize>=HashMap::new();
    let key=|d:&Diagnostic|(d.severity.clone(),d.rule_id.clone(),d.message.clone(),d.fatal);
    for d in &previous {*remaining.entry(key(d)).or_default()+=1;}
    let mut introduced=Vec::new();
    for d in following {
        let count=remaining.entry(key(&d)).or_default();
        if *count>0 {*count-=1;} else {introduced.push(d);}
    }
    Ok(Review{file_path:file_path.into(),before_text_hash:hash(before),
        after_text_hash:hash(after),supported:true,validator_version:version,introduced,existing:previous.len()})
}

/// Durable evidence is created only from an identity-checked worker review.
/// Raw hashes bind encoding/BOM/newlines; text hashes bind the analyzed content.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    receipt_version: u32,
    before_hash: String,
    after_hash: String,
    reject_new_syntax: bool,
    review: Review,
}
impl Receipt {
    pub fn bind(edit: &crate::edit_pipeline::ReadyEdit, review: &Review,
        reject_new_syntax: bool) -> Result<Self, String> {
        let receipt = Self {
            receipt_version: 1,
            before_hash: edit.plan.expected_hash.clone(),
            after_hash: edit.plan.after_hash.clone(),
            reject_new_syntax,
            review: review.clone(),
        };
        receipt.verify(&edit.path.relative, &edit.snapshot.original, &edit.plan.bytes)?;
        Ok(receipt)
    }

    pub fn verify(&self, file: &str, before: &[u8], after: &[u8]) -> Result<(), String> {
        if self.receipt_version != 1 || self.review.validator_version != "pf-validation-v1" {
            return Err("unsupported validation receipt version".into());
        }
        if self.before_hash != format!("{:x}", Sha256::digest(before))
            || self.after_hash != format!("{:x}", Sha256::digest(after)) {
            return Err("validation receipt raw snapshot mismatch".into());
        }
        let before = crate::text_snapshot::TextSnapshot::decode(before.to_vec())?;
        let after = crate::text_snapshot::TextSnapshot::decode(after.to_vec())?;
        if self.review.file_path != file
            || self.review.before_text_hash != hash(&before.text)
            || self.review.after_text_hash != hash(&after.text) {
            return Err("validation receipt path/text mismatch".into());
        }
        // An explicit unsupported worker state means "no validator for this
        // extension", not "validation failed". Its hashes are still identity
        // checked above, and decode() guarantees it carries no diagnostics.
        if self.review.rejects_syntax(self.reject_new_syntax) {
            return Err("validation receipt does not authorize this plan".into());
        }
        // Recheck deserialized diagnostic limits and fields as well.
        diagnostics(&serde_json::to_value(&self.review.introduced).map_err(|e|e.to_string())?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn wire(before:&str,after:&str,a:Value,b:Value)->Value {
        json!({"ok":true,"result":{"protocolVersion":1,"validatorVersion":"pf-validation-v1",
            "filePath":"fixture.js","beforeHash":hash(before),"afterHash":hash(after),"state":"completed",
            "before":a,"after":b,"introduced":[]}})
    }
    fn d(line:usize,fatal:bool)->Value {
        json!({"line":line,"column":1,"severity":"error","message":"problem","ruleId":"syntax","fatal":fatal})
    }
    #[test]
    fn durable_receipt_checks_identity_policy_and_diagnostics() {
        let before = b"before";
        let after = b"after";
        let review = decode(
            &serde_json::to_vec(&wire("before", "after", json!([]), json!([]))).unwrap(),
            "fixture.js", "before", "after",
        ).unwrap();
        let receipt = Receipt {
            receipt_version: 1,
            before_hash: hash("before"),
            after_hash: hash("after"),
            reject_new_syntax: true,
            review,
        };
        let encoded = serde_json::to_vec(&receipt).unwrap();
        let recovered: Receipt = serde_json::from_slice(&encoded).unwrap();
        recovered.verify("fixture.js", before, after).unwrap();
        assert!(recovered.verify("other.js", before, after).is_err());
        assert!(recovered.verify("fixture.js", b"\xef\xbb\xbfbefore", after).is_err());
        assert!(recovered.verify("fixture.js", before, b"external").is_err());
        let mut unsupported = serde_json::to_value(&receipt).unwrap();
        unsupported["review"]["supported"] = json!(false);
        serde_json::from_value::<Receipt>(unsupported).unwrap()
            .verify("fixture.js", before, after).unwrap();
        let mut tampered = serde_json::to_value(&receipt).unwrap();
        tampered["review"]["supported"] = json!(false);
        tampered["review"]["introduced"] = json!([d(1, true)]);
        assert!(serde_json::from_value::<Receipt>(tampered).unwrap()
            .verify("fixture.js", before, after).is_err());
        let mut altered = serde_json::to_value(&receipt).unwrap();
        altered["review"]["introduced"] = json!([d(1, true)]);
        let mut rejected: Receipt = serde_json::from_value(altered).unwrap();
        assert!(rejected.verify("fixture.js", before, after).is_err());
        rejected.reject_new_syntax = false;
        rejected.verify("fixture.js", before, after).unwrap();
        rejected.review.introduced[0].line = 0;
        assert!(rejected.verify("fixture.js", before, after).is_err());
    }

    #[test]
    fn native_multiset_ignores_positions_but_not_fatal_changes() {
        let response=wire("old","new",json!([d(1,false)]),json!([d(5,false),d(8,false),d(9,true)]));
        let review=decode(&serde_json::to_vec(&response).unwrap(),"fixture.js","old","new").unwrap();
        assert!(review.supported);
        assert_eq!(review.validator_version,"pf-validation-v1");
        assert_eq!(review.existing,1);
        assert_eq!(review.introduced.len(),2);
        assert!(review.rejects_syntax(true));
        assert!(!review.rejects_syntax(false));
    }
    #[test]
    fn mismatches_failures_and_invalid_diagnostics_are_not_passes() {
        let response=wire("a","b",json!([]),json!([]));
        assert!(decode(&serde_json::to_vec(&response).unwrap(),"fixture.js","a","changed").is_err());
        assert!(decode(&serde_json::to_vec(&response).unwrap(),"fixture.json","a","b").is_err());
        assert!(request("fixture.js","a\r\n","b").is_err());
        assert!(request("","a","b").is_err());
        let input:Value=serde_json::from_slice(&request("fixture.json","{}","[]").unwrap()).unwrap();
        assert_eq!(input["filePath"],"fixture.json");
        assert_eq!(input["beforeHash"],hash("{}"));
        assert!(decode(br#"{"ok":false}"#,"fixture.js","a","b").is_err());
        let response=wire("a","b",json!([]),json!([d(0,true)]));
        assert!(decode(&serde_json::to_vec(&response).unwrap(),"fixture.js","a","b").is_err());
    }
}