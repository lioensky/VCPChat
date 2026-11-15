//! Planning-time path checks, NOT a handle-based race-free filesystem sandbox.
//! Commit must revalidate parents and use platform-specific handle coordination.
use std::path::{Component, Path, PathBuf};

#[derive(Debug)]
pub struct ProjectPath {
    pub root: PathBuf,
    pub absolute: PathBuf,
    pub relative: String,
}

pub fn resolve(root: &Path, input: &str, allow_missing: bool) -> Result<ProjectPath, String> {
    if !root.is_absolute() { return Err("project root must be absolute".into()); }
    if input.is_empty() || input.len() > 4096 || input.contains('\0') {
        return Err("invalid project path".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() { return Err("project root is not a directory".into()); }
    // Normalize both separators even on Unix: callers use Windows-compatible paths.
    let normalized = input.replace('\\', "/");
    let raw = Path::new(&normalized);
    let relative = if raw.is_absolute() {
        raw.strip_prefix(&root).map_err(|_| "absolute path outside project")?
    } else { raw };
    let mut names = Vec::new();
    for component in relative.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                let name = name.to_str().ok_or("non-UTF8 path")?;
                // Avoid ADS, drive-relative paths, device names and Win32 normalization aliases.
                if name.contains(':') || name.ends_with('.') || name.ends_with(' ')
                    || name.chars().any(|c| c.is_control() || matches!(c,'<'|'>'|'"'|'|'|'?'|'*')) {
                    return Err("unsupported path component".into());
                }
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                if matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL")
                    || ["COM","LPT"].iter().any(|prefix| stem.strip_prefix(prefix)
                        .is_some_and(|n| n.len()==1 && matches!(n.as_bytes()[0], b'1'..=b'9'))) {
                    return Err("reserved device path".into());
                }
                names.push(name.to_string());
            }
            _ => return Err("parent traversal or path prefix is forbidden".into()),
        }
    }
    if names.is_empty() { return Err("file path cannot be project root".into()); }
    let mut absolute = root.clone();
    let mut missing = false;
    for name in &names {
        absolute.push(name);
        if missing { continue; }
        match std::fs::symlink_metadata(&absolute) {
            Ok(meta) => {
                if meta.file_type().is_symlink() { return Err("linked path component is forbidden".into()); }
                let actual = absolute.canonicalize().map_err(|e| e.to_string())?;
                if !actual.starts_with(&root) { return Err("resolved path outside project".into()); }
                // Junctions/reparse aliases that resolve elsewhere inside the root also
                // need explicit policy rather than silently changing database file keys.
                if actual != absolute { return Err("aliased path component is forbidden".into()); }
            }
            Err(e) if e.kind()==std::io::ErrorKind::NotFound && allow_missing => missing=true,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(ProjectPath { root, absolute, relative:names.join("/") })
}

/// Authorize a possibly missing project directory using its nearest existing ancestor.
pub fn resolve_new_root(root: &Path, allowed_roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !root.is_absolute() || root.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("project root must be an absolute path without parent traversal".into());
    }
    let mut ancestor = root.to_path_buf();
    let mut missing = Vec::new();
    while !ancestor.exists() {
        missing.push(ancestor.file_name().ok_or("project root has no existing ancestor")?.to_owned());
        if !ancestor.pop() { return Err("project root has no existing ancestor".into()); }
    }
    let ancestor = ancestor.canonicalize().map_err(|e| e.to_string())?;
    if !ancestor.is_dir() { return Err("project root ancestor is not a directory".into()); }
    for allowed in allowed_roots {
        let Ok(prefix) = ancestor.strip_prefix(allowed) else { continue; };
        let mut relative = prefix.to_path_buf();
        for name in missing.iter().rev() { relative.push(name); }
        if relative.as_os_str().is_empty() { return Ok(allowed.clone()); }
        let input = relative.to_str().ok_or("non-UTF8 project root")?;
        return resolve(allowed, input, true).map(|path| path.absolute);
    }
    Err("project root is outside trusted allowed roots".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_project_path_rejects_escape_and_special_names() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"),b"a").unwrap();
        let p=resolve(dir.path(),"a.txt",false).unwrap();
        assert_eq!(p.relative,"a.txt");
        assert!(p.absolute.starts_with(&p.root));
        for bad in ["../other","sub/../../other","C:relative","a:stream","NUL.txt","COM1","a.","a ","a\0b","/outside"] {
            assert!(resolve(dir.path(),bad,true).is_err(),"{bad:?}");
        }
        let p=resolve(dir.path(),"new\\nested.txt",true).unwrap();
        assert_eq!(p.relative,"new/nested.txt");
        assert!(resolve(dir.path(),"missing.txt",false).is_err());
        assert!(resolve(dir.path(),".",true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_rejected_even_when_it_points_inside_project() {
        let dir=tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"),b"a").unwrap();
        std::os::unix::fs::symlink(dir.path().join("a"),dir.path().join("alias")).unwrap();
        assert!(resolve(dir.path(),"alias",false).is_err());
    }
}