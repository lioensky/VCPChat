//! Native planning orchestration. Not a commit endpoint.
//! Allowed roots come from trusted service configuration, never from tool arguments.
use std::path::Path;
use crate::{edit::{Action, Outcome, Step}, project_path::{self, ProjectPath},
    text_snapshot::{PreparedTextEdit, TextSnapshot}, lang::Lang};

pub struct ReadyEdit {
    pub path: ProjectPath,
    pub snapshot: TextSnapshot,
    pub plan: PreparedTextEdit,
}

pub enum Preparation {
    Ready(ReadyEdit),
    Rejected(Outcome),
}

pub enum ValidatedPreparation {
    Ready { edit: ReadyEdit, review: crate::validation::Review },
    SyntaxRejected(crate::validation::Review),
    PlanningRejected(Outcome),
}

/// Internal composition only. The resulting review must be persisted with the
/// intent before recovery is allowed; this does not itself authorize a commit.
pub async fn prepare_validated(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
    reject_new_syntax: bool,
    validator: &crate::validation_process::ValidatorProcess,
) -> Result<ValidatedPreparation, String> {
    let edit = match prepare(root,file,allowed_roots,steps,best_effort)? {
        Preparation::Rejected(outcome) => return Ok(ValidatedPreparation::PlanningRejected(outcome)),
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

pub fn prepare(
    root: &Path,
    file: &str,
    allowed_roots: &[std::path::PathBuf],
    steps: &[Step],
    best_effort: bool,
) -> Result<Preparation, String> {
    let path = project_path::resolve(root,file,false)?;
    let allowed = allowed_roots.iter().any(|root| {
        root.canonicalize().is_ok_and(|allowed| path.root.starts_with(&allowed))
    });
    if !allowed { return Err("project is not inside an enabled writable root".into()); }
    let snapshot = TextSnapshot::read(&path.absolute)?;
    // Exact text and line edits do not pay for AST parsing.
    let symbolic = steps.iter().any(|s|matches!(&s.action,Action::Symbol{..}));
    let result = if symbolic {
        let lang=Lang::from_path(&path.absolute).ok_or("symbol edit language not supported by native planner")?;
        snapshot.prepare_with_language(steps,best_effort,lang)?
    } else {
        snapshot.prepare(steps,best_effort)?
    };
    match result {
        Ok(plan)=>Ok(Preparation::Ready(ReadyEdit {path,snapshot,plan})),
        Err(outcome)=>Ok(Preparation::Rejected(outcome)),
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
        assert_eq!(outcome.status,"ambiguous");
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
        assert_eq!(outcome.status,"ambiguous");
        let actions=steps(serde_json::json!([{"step":1,"op":"target","target":"function f","replace":"function g"}]));
        let Preparation::Ready(ready)=prepare(dir.path(),"broken.js",&[dir.path().to_path_buf()],&actions,false).unwrap()
            else {panic!("unique exact target must not require AST")};
        assert_eq!(ready.plan.bytes,b"function g( {\n");
        let actions=steps(serde_json::json!([{"step":1,"op":"symbol","symbol":"f","content":""}]));
        assert!(prepare(dir.path(),"broken.js",&[dir.path().to_path_buf()],&actions,false).is_err());
    }
}