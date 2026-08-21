use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallLayout {
    pub root: String,
    pub staging: String,
    pub versions: String,
    pub current_pointer: String,
    pub previous_pointer: String,
    pub lock: String,
}

pub struct OperationLock {
    path: PathBuf,
    _file: File,
}

impl Drop for OperationLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl InstallLayout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            staging: root.join("staging").to_string_lossy().into_owned(),
            versions: root.join("versions").to_string_lossy().into_owned(),
            current_pointer: root.join("current").to_string_lossy().into_owned(),
            previous_pointer: root.join("previous").to_string_lossy().into_owned(),
            lock: root.join("operation.lock").to_string_lossy().into_owned(),
            root: root.to_string_lossy().into_owned(),
        }
    }

    fn path(&self, value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    pub fn acquire_lock(&self) -> Result<OperationLock, String> {
        fs::create_dir_all(self.path(&self.root))
            .map_err(|e| format!("create install root: {e}"))?;
        let path = self.path(&self.lock);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_owner_is_alive(&path) {
                    return Err("installer operation is already locked by a live process".into());
                }
                fs::remove_file(&path).map_err(|e| format!("remove stale operation lock: {e}"))?;
                OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|e| format!("reacquire operation lock after stale owner: {e}"))?
            }
            Err(error) => return Err(format!("create installer operation lock: {error}")),
        };
        writeln!(file, "pid={}", std::process::id())
            .map_err(|e| format!("write operation lock: {e}"))?;
        Ok(OperationLock { path, _file: file })
    }

    pub fn publish_staged(&self, staged: &Path, identity: &str) -> Result<PathBuf, String> {
        if identity.is_empty()
            || !identity
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        {
            return Err("invalid revision identity".into());
        }
        if let Some(parent) = staged.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create staging directory: {e}"))?;
        }
        if !staged.is_dir() {
            return Err("staging payload directory does not exist".into());
        }
        let versions = self.path(&self.versions);
        fs::create_dir_all(&versions).map_err(|e| format!("create versions directory: {e}"))?;
        let destination = versions.join(identity);
        if destination.exists() {
            return Err("revision identity is already published".into());
        }
        fs::rename(staged, &destination).map_err(|e| format!("publish staged payload: {e}"))?;

        let current = self.path(&self.current_pointer);
        let previous = self.path(&self.previous_pointer);
        if current.is_file() {
            let old =
                fs::read_to_string(&current).map_err(|e| format!("read current pointer: {e}"))?;
            write_pointer_atomic(&previous, old.trim())?;
        }
        write_pointer_atomic(&current, &destination.to_string_lossy())?;
        Ok(destination)
    }

    pub fn rollback(&self) -> Result<(), String> {
        let previous = self.path(&self.previous_pointer);
        let value = fs::read_to_string(&previous)
            .map_err(|e| format!("no previous revision to roll back: {e}"))?;
        let target = PathBuf::from(value.trim());
        if !target.is_dir() {
            return Err("previous revision payload is missing".into());
        }
        write_pointer_atomic(
            &self.path(&self.current_pointer),
            target.to_string_lossy().as_ref(),
        )
    }

    pub fn current(&self) -> Option<PathBuf> {
        fs::read_to_string(self.path(&self.current_pointer))
            .ok()
            .map(|v| PathBuf::from(v.trim()))
            .filter(|p| p.is_dir())
    }
}

fn lock_owner_is_alive(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Some(pid) = raw.lines().find_map(|line| line.strip_prefix("pid=")) else {
        return false;
    };
    let Ok(pid) = pid.trim().parse::<u32>() else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    return std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("tasklist");
        command.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        crate::process::configure_hidden(&mut command);
        return command
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
        .unwrap_or(false);
    }
    #[allow(unreachable_code)]
    false
}

fn write_pointer_atomic(path: &Path, value: &str) -> Result<(), String> {
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp, format!("{value}\n")).map_err(|e| format!("write pointer: {e}"))?;
    fs::rename(&temp, path).map_err(|e| format!("commit pointer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("vcpchat-layout-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn publishes_atomically_and_rolls_back() {
        let root = fixture();
        let layout = InstallLayout::new(&root);
        let first = root.join("staging/first");
        fs::create_dir_all(&first).unwrap();
        fs::write(first.join("marker"), "one").unwrap();
        layout.publish_staged(&first, "commit-one").unwrap();
        assert_eq!(layout.current().unwrap().file_name().unwrap(), "commit-one");
        let second = root.join("staging/second");
        fs::create_dir_all(&second).unwrap();
        layout.publish_staged(&second, "commit-two").unwrap();
        assert_eq!(layout.current().unwrap().file_name().unwrap(), "commit-two");
        assert!(root.join("versions/commit-one").is_dir());
        layout.rollback().unwrap();
        assert_eq!(layout.current().unwrap().file_name().unwrap(), "commit-one");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn lock_rejects_second_owner() {
        let root = fixture();
        let layout = InstallLayout::new(&root);
        let _first = layout.acquire_lock().unwrap();
        assert!(layout.acquire_lock().is_err());
        drop(_first);
        assert!(layout.acquire_lock().is_ok());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_lock_is_recovered() {
        let root = fixture();
        let layout = InstallLayout::new(&root);
        fs::write(&layout.lock, "pid=4294967295\n").unwrap();
        assert!(layout.acquire_lock().is_ok());
        let _ = fs::remove_dir_all(root);
    }
}
