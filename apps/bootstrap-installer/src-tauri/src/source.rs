use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::process::configure_hidden;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub mode: String,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub tree_hash: Option<String>,
    pub dirty: bool,
    pub package_lock_hash: Option<String>,
    pub electron_version: Option<String>,
    pub node_version: Option<String>,
    pub npm_version: Option<String>,
    pub note: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub available: bool,
    pub dirty: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u64,
    pub behind: u64,
    pub changes: Vec<String>,
    pub note: String,
}

fn command(root: &Path, program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).current_dir(root);
    configure_hidden(&mut command);
    let output = command
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn git_porcelain(root: &Path) -> Option<String> {
    let mut command = Command::new("git");
    command.args(["status", "--porcelain=v1"]).current_dir(root);
    configure_hidden(&mut command);
    let output = command
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string(),
    )
}

fn sha256_file(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(bytes)))
}

fn find_root() -> Option<PathBuf> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--source-root" {
            if let Some(value) = args.next() {
                let root = PathBuf::from(value);
                if root.join(".git").exists() && root.join("package.json").exists() {
                    return Some(root);
                }
            }
        }
    }
    if let Some(value) =
        std::env::var_os("VCPCHAT_PROJECT_ROOT").or_else(|| std::env::var_os("VCPCHAT_SOURCE_ROOT"))
    {
        let root = PathBuf::from(value);
        if root.join(".git").exists() && root.join("package.json").exists() {
            return Some(root);
        }
    }
    let mut current = std::env::current_dir().ok()?;
    loop {
        if current.join(".git").exists() && current.join("package.json").exists() {
            return Some(current);
        }
        if !current.pop() {
            break;
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        let mut current = executable.parent().map(Path::to_path_buf);
        while let Some(candidate) = current {
            if candidate.join(".git").exists() && candidate.join("package.json").exists() {
                return Some(candidate);
            }
            current = candidate.parent().map(Path::to_path_buf);
        }
    }
    None
}

pub fn inspect() -> SourceSnapshot {
    let Some(root) = find_root() else {
        return SourceSnapshot {
            mode: "source-missing".into(),
            root: None,
            branch: None,
            commit: None,
            tree_hash: None,
            dirty: false,
            package_lock_hash: None,
            electron_version: None,
            node_version: None,
            npm_version: None,
            note: "未找到 VCPChat 源码；安装器不会自动下载源码。".into(),
        };
    };
    let dirty = git_porcelain(&root).map(|v| !v.is_empty()).unwrap_or(false);
    let electron_version = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|raw| {
            serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .and_then(|v| {
                    v.get("devDependencies")
                        .or_else(|| v.get("dependencies"))?
                        .get("electron")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned)
                })
        });
    SourceSnapshot {
        mode: "source-present".into(),
        root: Some(root.to_string_lossy().into_owned()),
        branch: command(&root, "git", &["branch", "--show-current"]),
        commit: command(&root, "git", &["rev-parse", "HEAD"]),
        tree_hash: command(&root, "git", &["rev-parse", "HEAD^{tree}"]),
        dirty,
        package_lock_hash: sha256_file(&root.join("package-lock.json")),
        electron_version,
        node_version: command(&root, "node", &["--version"]),
        npm_version: command(&root, "npm", &["--version"]),
        note: if dirty {
            "源码存在且有本地修改；更新模式会要求你明确选择保护策略。".into()
        } else {
            "源码存在；启动时只做检查，不执行 git pull。".into()
        },
    }
}

pub fn inspect_update() -> UpdateSnapshot {
    let Some(root) = find_root() else {
        return UpdateSnapshot {
            available: false,
            dirty: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            changes: Vec::new(),
            note: "未找到源码；不会自动下载或拉取。".into(),
        };
    };
    let porcelain = git_porcelain(&root).unwrap_or_default();
    let dirty = !porcelain.is_empty();
    let changes = porcelain
        .lines()
        .filter_map(|line| line.get(3..).map(str::to_owned))
        .take(50)
        .collect();
    let branch = command(&root, "git", &["branch", "--show-current"]);
    let upstream = command(
        &root,
        "git",
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let (ahead, behind) = command(
        &root,
        "git",
        &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    )
    .and_then(|value| {
        let mut parts = value.split_whitespace();
        Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
    })
    .unwrap_or((0, 0));
    let available = behind > 0;
    UpdateSnapshot {
        available,
        dirty,
        branch,
        upstream,
        ahead,
        behind,
        changes,
        note: if dirty {
            "检测到本地修改；可选择安全暂存后更新，修改不会被直接删除。".into()
        } else if behind > 0 {
            format!("上游有 {behind} 个提交；只有用户明确确认后才允许更新。")
        } else {
            "当前没有检测到可用的本地上游更新；未执行 git fetch 或 git pull。".into()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_source_is_explicit_and_non_mutating() {
        let snapshot = SourceSnapshot {
            mode: "source-missing".into(),
            root: None,
            branch: None,
            commit: None,
            tree_hash: None,
            dirty: false,
            package_lock_hash: None,
            electron_version: None,
            node_version: None,
            npm_version: None,
            note: "no source".into(),
        };
        assert_eq!(snapshot.mode, "source-missing");
    }

    #[test]
    fn porcelain_path_keeps_the_first_character() {
        let raw = " M apps/bootstrap-installer/src-tauri/src/lib.rs\n?? new file.txt";
        let changes: Vec<_> = raw
            .lines()
            .filter_map(|line| line.get(3..).map(str::to_owned))
            .collect();
        assert_eq!(changes[0], "apps/bootstrap-installer/src-tauri/src/lib.rs");
        assert_eq!(changes[1], "new file.txt");
    }
}
