//! 目录扫描 + 符号搜索：遵守 .gitignore 与默认忽略目录，按 (mtime, size) 缓存每个文件的 Outline，
//! 未变化的文件不重复解析。
//!
//! 忽略规则单一来源：插件通过 `ignoreDirs` 传入 modules/services/workspaceIndex.js 的
//! DEFAULT_IGNORED_DIRS；这里的内置列表只在未传入时兜底。含 pyvenv.cfg 的目录视为 Python 虚拟环境。
//!
//! 新鲜度说明：mtime+size 只用于筛选；Node 端对需要精确区间的文件（编辑 / 读取符号）
//! 始终以当前磁盘内容调用 outline，不依赖本缓存。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use rayon::prelude::*;
use serde::Serialize;
use tree_sitter::Parser;

use crate::facts::{extract_facts, html_facts, FileFacts};
use crate::lang::Lang;
use crate::symbols::{outline, Outline, Symbol};

pub const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git", ".svn", ".hg",
    "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".hypothesis", ".ipynb_checkpoints",
    ".venv", "venv", "env", ".env", "virtualenv", ".conda",
    ".next", ".nuxt", ".svelte-kit", ".angular", ".parcel-cache", ".turbo", ".vercel", ".cache", ".gradle",
    "dist", "build", "out", "target", "coverage", ".nyc_output",
    ".idea", ".vs", ".vscode-test",
];

pub const MAX_SCAN_FILES: usize = 20_000;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 50_000;

fn is_ignored_dir(name: &str, ignored: &HashSet<String>) -> bool {
    let lower = name.to_ascii_lowercase();
    ignored.contains(&lower) || lower.ends_with(".egg-info")
}

fn ignored_set(extra: &[String]) -> HashSet<String> {
    if extra.is_empty() {
        DEFAULT_IGNORED_DIRS.iter().map(|s| s.to_string()).collect()
    } else {
        extra.iter().map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
    }
}

#[derive(Clone)]
struct Entry {
    mtime_ms: u128,
    size: u64,
    outline: Arc<Outline>,
}

#[derive(Clone)]
struct FactsEntry {
    mtime_ms: u128,
    size: u64,
    /// 桥接全局名集合变化时事实需要重算
    bridge_key: String,
    facts: Arc<FileFacts>,
}

#[derive(Default)]
pub struct Cache {
    files: HashMap<PathBuf, Entry>,
    facts: HashMap<PathBuf, FactsEntry>,
}

/// facts 扫描的文件类别：源码文件或 HTML 页面。
#[derive(Clone, Copy)]
enum FactKind {
    Source(Lang),
    Html,
}

fn fact_kind(path: &Path) -> Option<FactKind> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name == "go.mod" {
            return Some(FactKind::Source(Lang::Go));
        }
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext == "html" || ext == "htm" {
        return Some(FactKind::Html);
    }
    Lang::from_name(&ext).map(FactKind::Source)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsFile {
    pub path: String,
    #[serde(flatten)]
    pub facts: FileFacts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsResult {
    pub files: Vec<FactsFile>,
    pub scanned: usize,
    pub parsed: usize,
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub lang: &'static str,
    pub score: u32,
    #[serde(flatten)]
    pub symbol: Symbol,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub total: usize,
    pub scanned: usize,
    pub parsed: usize,
    /// 参与解析的源文件总行数（不含被忽略 / 超限文件）。
    pub lines: usize,
    pub truncated: bool,
}

pub struct Query {
    pub name: String,
    pub kind: Option<String>,
    pub glob: Vec<String>,
    pub exact: bool,
    pub limit: usize,
    /// 忽略目录名（小写比较）；为空时使用内置 DEFAULT_IGNORED_DIRS。
    pub ignore_dirs: Vec<String>,
}

/// 名称打分：限定名全等 > 名称全等 > 限定名后缀 > 前缀 > 包含；exact 时只接受前三种。
fn score(sym: &Symbol, query: &str, exact: bool) -> u32 {
    let q = query.to_lowercase();
    let name = sym.name.to_lowercase();
    let qual = sym.qualified.to_lowercase();
    let norm_qual = qual.replace("::", ".");
    let norm_q = q.replace("::", ".");
    if norm_qual == norm_q {
        return 1000;
    }
    if name == q {
        return 900;
    }
    if norm_qual.ends_with(&format!(".{norm_q}")) {
        return 800;
    }
    if exact {
        return 0;
    }
    if name.starts_with(&q) {
        return 500;
    }
    if name.contains(&q) {
        return 300;
    }
    if norm_qual.contains(&norm_q) {
        return 200;
    }
    0
}

fn to_posix(root: &Path, abs: &Path) -> String {
    abs.strip_prefix(root)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

fn mtime_ms(meta: &fs::Metadata) -> u128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 列出 root 下可解析的源文件（遵守忽略规则与 glob）。
fn list_files(root: &Path, globs: &[String], ignore_dirs: &[String]) -> Result<(Vec<(PathBuf, Lang)>, bool), String> {
    list_by(root, globs, ignore_dirs, Lang::from_path)
}

fn list_by<T>(
    root: &Path,
    globs: &[String],
    ignore_dirs: &[String],
    classify: impl Fn(&Path) -> Option<T>,
) -> Result<(Vec<(PathBuf, T)>, bool), String> {
    let ignored = ignored_set(ignore_dirs);
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(true)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |e| {
            if !(e.file_type().is_some_and(|t| t.is_dir()) && e.depth() > 0) {
                return true;
            }
            !(is_ignored_dir(&e.file_name().to_string_lossy(), &ignored)
                || e.path().join("pyvenv.cfg").is_file())
        });
    if !globs.is_empty() {
        let mut ob = OverrideBuilder::new(root);
        for g in globs {
            ob.add(g).map_err(|e| format!("glob 无效：{g}（{e}）"))?;
        }
        builder.overrides(ob.build().map_err(|e| e.to_string())?);
    }
    let mut out = Vec::new();
    let mut truncated = false;
    for entry in builder.build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(lang) = classify(entry.path()) else { continue };
        if out.len() >= MAX_SCAN_FILES {
            truncated = true;
            break;
        }
        out.push((entry.into_path(), lang));
    }
    Ok((out, truncated))
}

impl Cache {
    pub fn len(&self) -> usize {
        self.files.len()
    }

    pub fn clear(&mut self) {
        self.files.clear();
        self.facts.clear();
    }

    /// 扫描 root 下 JS 族源码与 HTML 页面的链路事实（mtime+size+桥接名缓存）。只返回非空事实的文件。
    pub fn facts(&mut self, root: &Path, globs: &[String], ignore_dirs: &[String], bridge: &[String]) -> Result<FactsResult, String> {
        if !root.is_dir() {
            return Err(format!("目录不存在：{}", root.display()));
        }
        let (files, truncated) = list_by(root, globs, ignore_dirs, fact_kind)?;
        let scanned = files.len();
        let bridge_key = bridge.join(",");
        let mut fresh: Vec<(PathBuf, Arc<FileFacts>)> = Vec::with_capacity(files.len());
        let mut dirty: Vec<(PathBuf, FactKind, u128, u64)> = Vec::new();
        for (path, kind) in files {
            let Ok(meta) = fs::metadata(&path) else { continue };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let (m, s) = (mtime_ms(&meta), meta.len());
            match self.facts.get(&path) {
                Some(e) if e.mtime_ms == m && e.size == s && e.bridge_key == bridge_key => fresh.push((path, e.facts.clone())),
                _ => dirty.push((path, kind, m, s)),
            }
        }
        let parsed: Vec<(PathBuf, FactsEntry)> = dirty
            .into_par_iter()
            .map_init(Parser::new, |parser, (path, kind, m, s)| {
                let bytes = fs::read(&path).ok()?;
                let text = String::from_utf8_lossy(&bytes);
                let facts = match kind {
                    FactKind::Source(lang) => extract_facts(lang, &text, parser, bridge, Some(&path)).ok()?,
                    FactKind::Html => html_facts(&text, parser, bridge),
                };
                Some((path, FactsEntry { mtime_ms: m, size: s, bridge_key: bridge_key.clone(), facts: Arc::new(facts) }))
            })
            .flatten()
            .collect();
        let parsed_count = parsed.len();
        if self.facts.len() + parsed_count > MAX_CACHE_ENTRIES {
            self.facts.clear();
        }
        for (path, entry) in parsed {
            fresh.push((path.clone(), entry.facts.clone()));
            self.facts.insert(path, entry);
        }
        // 保留无出边孤立源文件作为合法图顶点（Vertex），确保反向被依赖能正确解析到目标文件
        let mut out: Vec<FactsFile> = fresh
            .into_iter()
            .map(|(ref p, ref f)| FactsFile { path: to_posix(root, p.as_path()), facts: (**f).clone() })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(FactsResult { files: out, scanned, parsed: parsed_count, truncated })
    }

    pub fn search(&mut self, root: &Path, q: &Query) -> Result<SearchResult, String> {
        if !root.is_dir() {
            return Err(format!("目录不存在：{}", root.display()));
        }
        let (files, truncated) = list_files(root, &q.glob, &q.ignore_dirs)?;
        let scanned = files.len();

        // 1) 按 mtime+size 判定哪些需要（重新）解析
        let mut fresh: Vec<(PathBuf, Arc<Outline>)> = Vec::with_capacity(files.len());
        let mut dirty: Vec<(PathBuf, Lang, u128, u64)> = Vec::new();
        for (path, lang) in files {
            let Ok(meta) = fs::metadata(&path) else { continue };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let (m, s) = (mtime_ms(&meta), meta.len());
            match self.files.get(&path) {
                Some(e) if e.mtime_ms == m && e.size == s => fresh.push((path, e.outline.clone())),
                _ => dirty.push((path, lang, m, s)),
            }
        }

        // 2) 并行解析脏文件（每线程一个 Parser）
        let parsed: Vec<(PathBuf, Entry)> = dirty
            .into_par_iter()
            .map_init(Parser::new, |parser, (path, lang, m, s)| {
                let bytes = fs::read(&path).ok()?;
                let text = String::from_utf8_lossy(&bytes);
                let o = outline(lang, &text, parser).ok()?;
                Some((path, Entry { mtime_ms: m, size: s, outline: Arc::new(o) }))
            })
            .flatten()
            .collect();
        let parsed_count = parsed.len();
        if self.files.len() + parsed_count > MAX_CACHE_ENTRIES {
            self.files.clear();
        }
        for (path, entry) in parsed {
            fresh.push((path.clone(), entry.outline.clone()));
            self.files.insert(path, entry);
        }

        let lines = fresh.iter().map(|(_, o)| o.line_count).sum();

        // 3) 打分
        let kind = q.kind.as_ref().map(|k| k.to_lowercase());
        let mut hits = Vec::new();
        for (path, o) in &fresh {
            for sym in &o.symbols {
                if let Some(k) = &kind {
                    if sym.kind != k.as_str() {
                        continue;
                    }
                }
                let sc = score(sym, &q.name, q.exact);
                if sc > 0 {
                    hits.push(Hit { path: to_posix(root, path), lang: o.lang, score: sc, symbol: sym.clone() });
                }
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.symbol.depth.cmp(&b.symbol.depth))
                .then(a.path.cmp(&b.path))
                .then(a.symbol.start.cmp(&b.symbol.start))
        });
        let total = hits.len();
        hits.truncate(q.limit.max(1));
        Ok(SearchResult { hits, total, scanned, parsed: parsed_count, lines, truncated })
    }
}