//! Native planning orchestration. Not a commit endpoint.
//! Allowed roots come from trusted service configuration, never from tool arguments.
use std::path::Path;
use crate::{edit::{Outcome, Step}, project_path::{self, ProjectPath},
    text_snapshot::{PreparedTextEdit, TextSnapshot}, lang::Lang};

pub struct ReadyEdit {
    pub path: ProjectPath,
    pub snapshot: TextSnapshot,
    pub plan: PreparedTextEdit,
}

pub struct RejectedPreparation {
    pub snapshot_hash: String,
    pub outcome: Outcome,
}

pub enum Preparation {
    Ready(ReadyEdit),
    Rejected(RejectedPreparation),
}

pub enum ValidatedPreparation {
    Ready { edit: ReadyEdit, review: crate::validation::Review },
    SyntaxRejected(crate::validation::Review),
    PlanningRejected(RejectedPreparation),
}

/// Internal composition only. The resulting review must be persisted with the
/// intent before recovery is allowed; this does not itself authorize a commit.
#[cfg(test)]
pub async fn prepare_validated(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
    reject_new_syntax: bool,
    validator: &crate::validation_process::ValidatorProcess,
) -> Result<ValidatedPreparation, String> {
    prepare_validated_with_expected(
        root, file, allowed_roots, steps, best_effort, reject_new_syntax, validator, None,
    ).await
}

pub async fn prepare_validated_with_expected(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
    reject_new_syntax: bool,
    validator: &crate::validation_process::ValidatorProcess,
    expected_hash: Option<&str>,
) -> Result<ValidatedPreparation, String> {
    let edit = match prepare_with_expected(
        root, file, allowed_roots, steps, best_effort, expected_hash,
    )? {
        Preparation::Rejected(rejected) => return Ok(ValidatedPreparation::PlanningRejected(rejected)),
        Preparation::Ready(edit) => edit,
    };
    let after = TextSnapshot::decode(edit.plan.bytes.clone())?;
    let review = validator.review(&edit.path.relative,&edit.snapshot.text,&after.text).await?;
    if review.rejects_syntax(reject_new_syntax) {
        return Ok(ValidatedPreparation::SyntaxRejected(review));
    }
    revalidate(&edit, allowed_roots)?;
    Ok(ValidatedPreparation::Ready { edit, review })
}

/// Optimistic recheck only: commit must recheck again; this is not filesystem CAS.
/// The caller must supply the current trusted authorization configuration.
pub(crate) fn revalidate(edit: &ReadyEdit, allowed_roots: &[std::path::PathBuf]) -> Result<(), String> {
    let current_path = project_path::resolve(&edit.path.root, &edit.path.relative, false)?;
    if current_path.absolute != edit.path.absolute ||
        !allowed_roots.iter().any(|root| {
            root.canonicalize().is_ok_and(|allowed| current_path.root.starts_with(allowed))
        }) {
        return Err("edit path or authorization changed during validation".into());
    }
    let current = TextSnapshot::read(&current_path.absolute)?;
    if current.hash != edit.plan.expected_hash {
        return Err("file changed during validation; native edit plan is stale".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn prepare(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
) -> Result<Preparation, String> {
    prepare_with_expected(root, file, allowed_roots, steps, best_effort, None)
}

pub(crate) fn prepare_with_expected(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
    expected_hash: Option<&str>,
) -> Result<Preparation, String> {
    let path = project_path::resolve(root,file,false)?;
    let allowed = allowed_roots.iter().any(|root| {
        root.canonicalize().is_ok_and(|allowed| path.root.starts_with(&allowed))
    });
    if !allowed { return Err("project is not inside an enabled writable root".into()); }
    let snapshot = TextSnapshot::read(&path.absolute)?;
    if expected_hash.is_some_and(|expected| expected != snapshot.hash.as_str()) {
        return Err("expectedHash does not match planning snapshot; file changed".into());
    }
    // 快路径不解析 AST：逐字节、行号、省略号编辑都不为语法树付钱。
    let symbolic = steps.iter().any(|s|s.action.needs_symbols());
    let mut result = if symbolic {
        let lang=Lang::from_path(&path.absolute).ok_or("symbol edit language not supported by native planner")?;
        snapshot.prepare_with_language(steps,best_effort,lang)?
    } else {
        snapshot.prepare(steps,best_effort)?
    };
    // 快路径失败或歧义时按需补一次带语言的规划：补 scope 与 structure 候选。
    // 语法树只是补充证据，慢路径自身出错不回滚快路径的裁决。
    if !symbolic && result.is_err() {
        if let Some(lang)=Lang::from_path(&path.absolute) {
            if let Ok(enriched)=snapshot.prepare_with_language(steps,best_effort,lang) {
                result=enriched;
            }
        }
    }
    match result {
        Ok(plan)=>Ok(Preparation::Ready(ReadyEdit {path,snapshot,plan})),
        Err(outcome)=> {
            let rejected=RejectedPreparation {
                snapshot_hash:snapshot.hash.clone(),
                outcome,
            };
            Ok(Preparation::Rejected(rejected))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn steps(v:serde_json::Value)->Vec<Step>{serde_json::from_value(v).unwrap()}

    #[test]
    fn real_file_native_symbol_plan_does_not_mutate_disk() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("code.js");
        let before=b"\xef\xbb\xbf/** doc */\r\nfunction f() { return 1; }\r\n";
        std::fs::write(&file,before).unwrap();
        let actions=steps(serde_json::json!([
            {"step":1,"op":"symbol","symbol":"f","body":true,"content":"function f() { return 2; }"}
        ]));
        let Preparation::Ready(ready)=prepare(dir.path(),"code.js",&[dir.path().to_path_buf()],&actions,false).unwrap()
            else {panic!("expected native plan")};
        assert_eq!(ready.path.relative,"code.js");
        assert_eq!(ready.plan.expected_hash,ready.snapshot.hash);
        assert_eq!(ready.plan.bytes,b"\xef\xbb\xbf/** doc */\r\nfunction f() { return 2; }\r\n");
        assert_eq!(std::fs::read(file).unwrap(),before);
    }

    #[test]
    fn disabled_roots_and_ambiguity_never_produce_writable_plan() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"),b"x x").unwrap();
        let actions=steps(serde_json::json!([{"step":1,"op":"target","target":"x","replace":"y"}]));
        assert!(prepare(dir.path(),"a.txt",&[],&actions,false).is_err());
        let result=prepare(dir.path(),"a.txt",&[dir.path().to_path_buf()],&actions,true).unwrap();
        let Preparation::Rejected(outcome)=result else {panic!("ambiguous plan must not be ready")};
        assert_eq!(outcome.outcome.status,"ambiguous");
        use sha2::{Digest,Sha256};
        assert_eq!(outcome.snapshot_hash,format!("{:x}",Sha256::digest(b"x x")));
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(),b"x x");
    }

    #[test]
    fn post_validation_recheck_rejects_drift_and_revoked_roots() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"before").unwrap();
        let roots = vec![dir.path().to_path_buf()];
        let actions = steps(serde_json::json!([
            {"step":1,"op":"target","target":"before","replace":"after"}
        ]));
        let Preparation::Ready(edit) = prepare(dir.path(), "a.txt", &roots, &actions, false).unwrap()
            else { panic!("expected native plan") };
        revalidate(&edit, &roots).unwrap();
        assert!(revalidate(&edit, &[]).is_err());
        std::fs::write(&file, b"external").unwrap();
        let error = revalidate(&edit, &roots).unwrap_err();
        assert!(error.contains("stale"), "{error}");
        assert_eq!(std::fs::read(&file).unwrap(), b"external");
        std::fs::remove_file(&file).unwrap();
        assert!(revalidate(&edit, &roots).is_err());
        assert!(!file.exists());
    }

    #[test]
    fn exact_edit_does_not_require_valid_ast() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("broken.js"),b"function f( {\n").unwrap();
        let ambiguous=steps(serde_json::json!([{"step":1,"op":"target","target":"f","replace":"g"}]));
        let Preparation::Rejected(outcome)=prepare(dir.path(),"broken.js",&[dir.path().to_path_buf()],&ambiguous,false).unwrap()
            else {panic!("f occurs in both function keyword and function name")};
        assert_eq!(outcome.outcome.status,"ambiguous");
        let actions=steps(serde_json::json!([{"step":1,"op":"target","target":"function f","replace":"function g"}]));
        let Preparation::Ready(ready)=prepare(dir.path(),"broken.js",&[dir.path().to_path_buf()],&actions,false).unwrap()
            else {panic!("unique exact target must not require AST")};
        assert_eq!(ready.plan.bytes,b"function g( {\n");
        let actions=steps(serde_json::json!([{"step":1,"op":"symbol","symbol":"f","content":""}]));
        assert!(prepare(dir.path(),"broken.js",&[dir.path().to_path_buf()],&actions,false).is_err());
    }

    #[test]
    fn ambiguous_fast_path_is_enriched_with_scope_only_for_known_languages() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.js"),
            b"function alpha() { return dup(); }\nfunction beta() { return dup(); }\n").unwrap();
        let actions=steps(serde_json::json!([{"step":1,"op":"target","target":"dup","replace":"done"}]));
        let Preparation::Rejected(rejected)=prepare(dir.path(),"a.js",&[dir.path().to_path_buf()],&actions,false).unwrap()
            else {panic!("two literal hits must stay ambiguous")};
        assert_eq!(rejected.outcome.status,"ambiguous");
        let candidates=&rejected.outcome.ambiguities[0].candidates;
        assert_eq!(candidates[0].scope.as_deref(),Some("alpha"));
        assert_eq!(candidates[1].scope.as_deref(),Some("beta"));
        assert_eq!(rejected.outcome.ambiguities[0].kind,"exact");
        // 非代码文件不解析 AST：候选照旧，但不伪造 scope。
        std::fs::write(dir.path().join("a.txt"),b"dup\ndup\n").unwrap();
        let Preparation::Rejected(plain)=prepare(dir.path(),"a.txt",&[dir.path().to_path_buf()],&actions,false).unwrap()
            else {panic!("literal ambiguity in a plain text file")};
        assert!(plain.outcome.ambiguities[0].candidates.iter().all(|c|c.scope.is_none()));
    }

    #[test]
    fn token_match_plans_without_expected_hash_but_rejects_wrong_explicit_hash() {
        let dir=tempfile::tempdir().unwrap();
        let file=dir.path().join("a.js");
        let source=b"const a = 1;\n";
        std::fs::write(&file,source).unwrap();
        let roots=vec![dir.path().to_path_buf()];
        let actions=steps(serde_json::json!([
            {"step":1,"op":"target","target":"const   a = 1;","replace":"const a = 2;","pick":[1]}]));
        let Preparation::Ready(ready)=
            prepare_with_expected(dir.path(),"a.js",&roots,&actions,false,None).unwrap()
            else {panic!("token match must plan without outer expectedHash")};
        assert_eq!(ready.plan.bytes,b"const a = 2;\n");
        assert_eq!(std::fs::read(&file).unwrap(),source.to_vec(),"planning never writes");
        let wrong="0".repeat(64);
        let error=prepare_with_expected(dir.path(),"a.js",&roots,&actions,false,Some(&wrong))
            .err().unwrap();
        assert!(error.contains("expectedHash"),"{error}");
        assert_eq!(std::fs::read(&file).unwrap(),source.to_vec(),"failed planning never writes");
    }
}