//! Original byte identity and normalized editing text travel together.
use std::fs::File;
use std::io::Read;
use std::path::Path;
use sha2::{Digest, Sha256};

pub const MAX_EDIT_BYTES: usize = 5 * 1024 * 1024;
const BOM: &[u8] = b"\xef\xbb\xbf";

#[derive(Debug)]
pub struct TextSnapshot {
    pub original: Vec<u8>,
    pub hash: String,
    pub text: String,
    pub bom: bool,
    pub line_ending: &'static str,
}

pub struct PreparedTextEdit {
    pub expected_hash: String,
    pub after_hash: String,
    pub bytes: Vec<u8>,
    pub outcome: crate::edit::Outcome,
}

impl TextSnapshot {
    /// A rejected or ambiguous plan has no output bytes and cannot become a commit.
    /// 快路径不解析 AST：词法/结构命中只先产出候选，选定后即可规划，无候选选择时返回歧义。
    pub fn prepare(
        &self,
        steps: &[crate::edit::Step],
        best_effort: bool,
    ) -> Result<Result<PreparedTextEdit, crate::edit::Outcome>, String> {
        let outcome = crate::edit::run(&self.text, steps, best_effort)?;
        self.finish(outcome)
    }

    /// 慢路径：按需解析一次语法树。只服务两件事——符号编辑的定位，
    /// 以及快路径失败/歧义时补回 scope 与 structure 候选。
    pub fn prepare_with_language(
        &self,
        steps: &[crate::edit::Step],
        best_effort: bool,
        lang: crate::lang::Lang,
    ) -> Result<Result<PreparedTextEdit, crate::edit::Outcome>, String> {
        let mut parser = tree_sitter::Parser::new();
        let outline = crate::symbols::outline(lang, &self.text, &mut parser)?;
        // Broken AST ranges are not authoritative for native symbol mutations yet.
        if outline.has_error && steps.iter().any(|s|s.action.needs_symbols()) {
            return Err("symbol editing requires a syntactically valid snapshot".into());
        }
        let outcome = crate::edit::run_with_symbols(&self.text,steps,best_effort,&outline.symbols)?;
        self.finish(outcome)
    }

    fn finish(&self, mut outcome: crate::edit::Outcome) -> Result<Result<PreparedTextEdit, crate::edit::Outcome>, String> {
        if outcome.status != "ok" {
            return Ok(Err(outcome));
        }
        let text = outcome.text.take().ok_or("successful plan missing output")?;
        // A no-op must preserve original mixed newlines byte-for-byte.
        let bytes = if outcome.changed { self.encode(&text)? } else { self.original.clone() };
        let after_hash = format!("{:x}", Sha256::digest(&bytes));
        Ok(Ok(PreparedTextEdit {
            expected_hash: self.hash.clone(),
            after_hash,
            bytes,
            outcome,
        }))
    }
    pub fn read(path: &Path) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err("text snapshot requires a regular file".into()); }
        if meta.len() > MAX_EDIT_BYTES as u64 { return Err("file exceeds edit budget".into()); }
        let mut bytes = Vec::new();
        // Bound the read even if another process grows the file after metadata inspection.
        (&mut file).take(MAX_EDIT_BYTES as u64 + 1).read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        Self::decode(bytes)
    }

    pub fn decode(original: Vec<u8>) -> Result<Self, String> {
        if original.len() > MAX_EDIT_BYTES { return Err("file exceeds edit budget".into()); }
        if original.iter().take(8000).any(|&b| b == 0)
            || original.starts_with(b"\xff\xfe") || original.starts_with(b"\xfe\xff") {
            return Err("binary or UTF-16 input is not editable text".into());
        }
        let bom = original.starts_with(BOM);
        let raw = std::str::from_utf8(&original[if bom { 3 } else { 0 }..])
            .map_err(|_| "invalid UTF-8; refusing lossy editing")?;
        let bytes = raw.as_bytes();
        let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'\r' if bytes.get(i + 1) == Some(&b'\n') => { crlf += 1; i += 1; }
                b'\r' => cr += 1,
                b'\n' => lf += 1,
                _ => {}
            }
            i += 1;
        }
        // Preserve legacy majority/tie behavior; mixed newline normalization is explicit.
        let line_ending = if crlf > lf && crlf > cr { "\r\n" }
            else if cr > lf && cr > crlf { "\r" } else { "\n" };
        let text = raw.replace("\r\n", "\n").replace('\r', "\n");
        let hash = format!("{:x}", Sha256::digest(&original));
        Ok(Self { original, hash, text, bom, line_ending })
    }

    pub fn encode(&self, normalized: &str) -> Result<Vec<u8>, String> {
        if normalized.contains('\r') { return Err("editing output must be LF normalized".into()); }
        let extra = if self.line_ending == "\r\n" {
            normalized.bytes().filter(|&b| b == b'\n').count()
        } else { 0 };
        let size = normalized.len().checked_add(extra)
            .and_then(|n| n.checked_add(if self.bom { 3 } else { 0 }))
            .ok_or("encoded size overflow")?;
        if size > MAX_EDIT_BYTES { return Err("encoded output exceeds edit budget".into()); }
        let mut output = Vec::with_capacity(size);
        if self.bom { output.extend_from_slice(BOM); }
        if self.line_ending == "\n" {
            output.extend_from_slice(normalized.as_bytes());
        } else {
            let mut parts = normalized.split('\n').peekable();
            while let Some(part) = parts.next() {
                output.extend_from_slice(part.as_bytes());
                if parts.peek().is_some() { output.extend_from_slice(self.line_ending.as_bytes()); }
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bom_crlf_and_raw_identity() {
        let bytes = b"\xef\xbb\xbfhello\r\nworld\r\n".to_vec();
        let snapshot = TextSnapshot::decode(bytes.clone()).unwrap();
        assert_eq!(snapshot.text, "hello\nworld\n");
        assert_eq!(snapshot.line_ending, "\r\n");
        assert!(snapshot.bom);
        assert_eq!(snapshot.original, bytes);
        assert_eq!(snapshot.encode(&snapshot.text).unwrap(), bytes);
        assert_eq!(snapshot.hash, format!("{:x}", Sha256::digest(&bytes)));
    }

    #[test]
    fn empty_cr_ties_and_no_final_newline() {
        for bytes in [b"".as_slice(), b"a\rb\r", "猫🐱".as_bytes()] {
            let snapshot = TextSnapshot::decode(bytes.to_vec()).unwrap();
            assert_eq!(snapshot.encode(&snapshot.text).unwrap(), bytes);
        }
        let snapshot = TextSnapshot::decode(b"a\r\nb\n".to_vec()).unwrap();
        assert_eq!(snapshot.line_ending, "\n");
        assert_eq!(snapshot.encode(&snapshot.text).unwrap(), b"a\nb\n");
    }

    #[test]
    fn invalid_encoding_and_budgets_fail_closed() {
        for bytes in [vec![0xff], vec![0xff,0xfe], vec![b'a',0]] {
            assert!(TextSnapshot::decode(bytes).is_err());
        }
        assert!(TextSnapshot::decode(vec![b'a'; MAX_EDIT_BYTES + 1]).is_err());
        let snapshot = TextSnapshot::decode(b"a\r\n".to_vec()).unwrap();
        assert!(snapshot.encode("a\r\n").is_err());
        assert!(snapshot.encode(&"\n".repeat(MAX_EDIT_BYTES)).is_err());
    }

    #[test]
    fn native_snapshot_plan_keeps_identity_and_encoding() {
        let snapshot = TextSnapshot::decode(b"\xef\xbb\xbfone\r\ntwo\r\n".to_vec()).unwrap();
        let steps: Vec<crate::edit::Step> = serde_json::from_value(serde_json::json!([
            {"step":1,"op":"target","target":"two","replace":"猫"}
        ])).unwrap();
        let plan = snapshot.prepare(&steps, false).unwrap().ok().unwrap();
        assert_eq!(plan.expected_hash, snapshot.hash);
        assert_eq!(plan.bytes, "\u{feff}one\r\n猫\r\n".as_bytes());
        assert_eq!(plan.after_hash, format!("{:x}", Sha256::digest(&plan.bytes)));
        assert!(plan.outcome.changed);
        assert!(plan.outcome.text.is_none(), "do not retain a second output text");
    }

    #[test]
    fn no_op_keeps_mixed_newlines_and_ambiguity_has_no_bytes() {
        let snapshot = TextSnapshot::decode(b"x\r\nx\n".to_vec()).unwrap();
        let ambiguous: Vec<crate::edit::Step> = serde_json::from_value(serde_json::json!([
            {"step":1,"op":"target","target":"x","replace":"y"}
        ])).unwrap();
        let rejected = snapshot.prepare(&ambiguous, false).unwrap().err().unwrap();
        assert_eq!(rejected.status, "ambiguous");
        let noop: Vec<crate::edit::Step> = serde_json::from_value(serde_json::json!([
            {"step":1,"op":"target","target":"x","replace":"x","pick":[1,2]}
        ])).unwrap();
        let plan = snapshot.prepare(&noop, false).unwrap().ok().unwrap();
        assert_eq!(plan.bytes, snapshot.original);
        assert_eq!(plan.expected_hash, plan.after_hash);
    }

    #[test]
    fn native_symbol_edit_is_bound_to_snapshot_and_preserves_comments() {
        let snapshot=TextSnapshot::decode(b"\xef\xbb\xbf/** docs */\r\nfunction f() {\r\n return 1;\r\n}\r\n".to_vec()).unwrap();
        let lang=crate::lang::Lang::from_name("javascript").unwrap();
        let steps:Vec<crate::edit::Step>=serde_json::from_value(serde_json::json!([
            {"step":1,"op":"symbol","symbol":"f","content":"function f() { return 2; }","body":true}
        ])).unwrap();
        let plan=snapshot.prepare_with_language(&steps,false,lang).unwrap().ok().unwrap();
        assert_eq!(plan.bytes,b"\xef\xbb\xbf/** docs */\r\nfunction f() { return 2; }\r\n");
        assert_eq!(plan.expected_hash,snapshot.hash);
        let deletion:Vec<crate::edit::Step>=serde_json::from_value(serde_json::json!([
            {"step":1,"op":"symbol","symbol":"f","content":""}
        ])).unwrap();
        let plan=snapshot.prepare_with_language(&deletion,false,lang).unwrap().ok().unwrap();
        assert_eq!(plan.bytes,b"\xef\xbb\xbf");
    }

    #[test]
    fn bounded_disk_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file.txt");
        std::fs::write(&path, "原文\r\n").unwrap();
        assert_eq!(TextSnapshot::read(&path).unwrap().text, "原文\n");
        assert!(TextSnapshot::read(dir.path()).is_err());
    }

    #[test]
    fn fast_path_plans_token_match_or_reports_ambiguity_without_parsing_ast() {
        let snapshot = TextSnapshot::decode(b"const a = 1;\n".to_vec()).unwrap();
        let steps: Vec<crate::edit::Step> = serde_json::from_value(serde_json::json!([
            {"step":1,"op":"target","target":"const   a = 1;","replace":"const a = 2;","pick":[1]}
        ])).unwrap();
        let plan = snapshot.prepare(&steps, false).unwrap().ok().unwrap();
        assert_eq!(plan.outcome.status, "ok");
        assert_eq!(plan.bytes, b"const a = 2;\n");
        let ambiguous: Vec<crate::edit::Step> = serde_json::from_value(serde_json::json!([
            {"step":1,"op":"target","target":"const   a = 1;","replace":"const a = 2;"}
        ])).unwrap();
        let rejected = snapshot.prepare(&ambiguous, false).unwrap().err().unwrap();
        assert_eq!(rejected.status, "ambiguous");
        assert_eq!(rejected.ambiguities[0].kind, "token");
    }
}