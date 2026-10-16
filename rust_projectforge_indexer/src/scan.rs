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
use crate::lang::{Lang, SrcLang};
use crate::symbols::{Outline, Symbol};

use crate::binary;
pub const DEFAULT_IGNORED_DIRS: &[&str] = &[
    ".git", ".svn", ".hg",
    "node_modules", "bower_components", "jspm_packages", ".pnpm-store", ".yarn",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".hypothesis", ".ipynb_checkpoints",
    ".venv", "venv", "env", ".env", "virtualenv", ".conda",
    ".next", ".nuxt", ".svelte-kit", ".angular", ".parcel-cache", ".turbo", ".vercel", ".cache", ".gradle",
    "dist", "build", "out", "target", "coverage", ".nyc_output",
    ".idea", ".vs", ".vscode-test",
    // 以下与 VCPChat/modules/services/workspaceIndex.js 的 DEFAULT_IGNORED_DIRS（真源）同步；
    // 插件正常会显式传入 ignoreDirs，此处仅为未传时的回退。
    "assets", "asset", "appdata",
    "artifacts", "artifact", "vendor",
    "release", "releases", "temp", "tmp",
];

pub const MAX_SCAN_FILES: usize = 20_000;
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 50_000;
/// 脏文件超过该数量才启用文本预筛（少量脏文件直接全解析，行为与旧版一致）。
const PREFILTER_MIN_DIRTY: usize = 64;
/// 查询末段短于该字符数时不预筛（`e`、`ui` 几乎命中所有文件，筛选无意义）。
const PREFILTER_MIN_NEEDLE: usize = 3;

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
    /// 被文本预筛推迟解析的文件，由主线程空闲时 step_pending 分批补齐。
    /// 值为 (语言, 文件字节数, 已被中止次数)；字节数用于按预算分批，
    /// 中止次数用于防饿死：被中止过的文件下次以不可中断方式解析。
    pending: HashMap<PathBuf, (SrcLang, u64, u8)>,
}

/// 单个脏文件在一次 search 中的处理结果。
enum DirtyOutcome {
    Parsed(Entry),
    /// 不含查询末段：本次不可能命中，推迟解析；行数仍计入统计。
    Deferred { lang: SrcLang, size: u64, lines: usize },
}

/// facts 扫描的文件类别：源码文件或 HTML 页面。
#[derive(Clone, Copy)]
enum FactKind {
    Source(Lang),
    Html,
    Binary,
}

fn fact_kind(path: &Path) -> Option<FactKind> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name == "go.mod" {
            return Some(FactKind::Source(Lang::Go));
        }
    }
    if Lang::is_binary_path(path) {
        return Some(FactKind::Binary);
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryFactsFile {
    pub path: String,
    pub format: String,
    pub architecture: String,
    pub exports: Vec<String>,
    pub imports: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactsResult {
    pub files: Vec<FactsFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub binary_files: Vec<BinaryFactsFile>,
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
    /// 因文本预筛推迟、等待空闲补齐的文件数（不影响本次命中完整性）。
    pub pending: usize,
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

/// 诊断开关：设置环境变量 PF_INDEXER_TRACE 时输出补齐批次耗时到 stderr（只读取一次）。
fn trace_enabled() -> bool {
    static T: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *T.get_or_init(|| std::env::var_os("PF_INDEXER_TRACE").is_some())
}

/// 文本预筛用的查询末段：小写、`::` 归一为 `.` 后取最后一个非空段。
/// 与 score() 的所有命中分支都兼容：任何命中的符号，其名字或限定名某段必含该末段。
fn prefilter_needle(query: &str) -> Option<String> {
    let q = query.to_lowercase().replace("::", ".");
    let seg = q.rsplit('.').find(|s| !s.is_empty())?;
    (seg.chars().count() >= PREFILTER_MIN_NEEDLE).then(|| seg.to_string())
}

/// 与 symbols::line_count 同口径（末尾换行不计额外一行）；推迟文件不归一化 CR，仅用于统计。
fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    let n = text.matches('\n').count();
    if text.ends_with('\n') {
        n
    } else {
        n + 1
    }
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
        self.pending.clear();
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// 空闲补齐：按字节预算取出一批待解析文件（至少 1 个），按大小降序并行解析写入缓存，返回本批完成数。
    /// - 降序：大文件先开工，小文件填满其余核，减少批尾单文件拖尾。
    /// - 可中断：`should_stop()` 为 true（有新请求到达）时，未开始的文件直接回队，解析中的文件中止后回队，
    ///   请求等待时间不再取决于最大文件。
    /// - 先移出队列再解析：解析失败的文件丢弃（下次 search 判脏会重来），不会卡住队列。
    /// - 以解析时的 metadata 为准；解析期间若文件再被修改，下次 search 会因 mtime/size 不符重新判脏。
    pub fn step_pending(&mut self, byte_budget: u64, should_stop: &(dyn Fn() -> bool + Sync)) -> usize {
        if self.pending.is_empty() {
            return 0;
        }
        let t0 = std::time::Instant::now();
        let mut chosen: Vec<(PathBuf, u64)> = Vec::new();
        let mut bytes = 0u64;
        for (p, (_, size, _)) in &self.pending {
            if !chosen.is_empty() && bytes + size > byte_budget {
                break;
            }
            bytes += size;
            chosen.push((p.clone(), *size));
        }
        chosen.sort_by(|a, b| b.1.cmp(&a.1));
        let max_size = chosen.first().map(|c| c.1).unwrap_or(0);
        let work: Vec<(PathBuf, SrcLang, u64, u8)> = chosen
            .into_iter()
            .filter_map(|(p, _)| self.pending.remove(&p).map(|(lang, size, att)| (p, lang, size, att)))
            .collect();

        enum Fill {
            Done(PathBuf, Entry),
            /// 回队：最后一项为新的已中止次数（未开始的文件不计数）。
            Requeue(PathBuf, SrcLang, u64, u8),
            Drop,
        }
        let results: Vec<Fill> = work
            .into_par_iter()
            .map_init(Parser::new, |parser, (path, lang, size, att)| {
                if should_stop() {
                    return Fill::Requeue(path, lang, size, att);
                }
                let Ok(meta) = fs::metadata(&path) else { return Fill::Drop };
                if meta.len() > MAX_FILE_BYTES {
                    return Fill::Drop;
                }
                let Ok(raw) = fs::read(&path) else { return Fill::Drop };
                let text = String::from_utf8_lossy(&raw);
                let entry = |o: Outline| Entry { mtime_ms: mtime_ms(&meta), size: meta.len(), outline: Arc::new(o) };
                if att > 0 {
                    // 防饿死：已被中止过，本次不可中断，保证补齐必然结束。
                    // 代价：请求最坏等待此文件一次完整解析。
                    return match lang.outline(&text, parser) {
                        Ok(o) => Fill::Done(path, entry(o)),
                        Err(_) => Fill::Drop,
                    };
                }
                match lang.outline_cancellable(&text, parser, should_stop) {
                    Ok(Some(o)) => Fill::Done(path, entry(o)),
                    Ok(None) => Fill::Requeue(path, lang, size, att.saturating_add(1)),
                    Err(_) => Fill::Drop,
                }
            })
            .collect();

        let mut done: Vec<(PathBuf, Entry)> = Vec::new();
        let mut requeued = 0usize;
        for r in results {
            match r {
                Fill::Done(p, e) => done.push((p, e)),
                Fill::Requeue(p, lang, size, att) => {
                    requeued += 1;
                    self.pending.insert(p, (lang, size, att));
                }
                Fill::Drop => {}
            }
        }
        let n = done.len();
        if self.files.len() + n > MAX_CACHE_ENTRIES {
            self.files.clear();
        }
        for (path, entry) in done {
            self.files.insert(path, entry);
        }
        if trace_enabled() {
            eprintln!(
                "[pf-trace] batch files={} bytes={} max={} ms={:.1} requeued={} left={}",
                n + requeued,
                bytes,
                max_size,
                t0.elapsed().as_secs_f64() * 1000.0,
                requeued,
                self.pending.len()
            );
        }
        n
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
        let mut dirty_source: Vec<(PathBuf, FactKind, u128, u64)> = Vec::new();
        let mut binary_paths: Vec<PathBuf> = Vec::new();

        for (path, kind) in files {
            let Ok(meta) = fs::metadata(&path) else { continue };
            if matches!(kind, FactKind::Binary) {
                binary_paths.push(path);
                continue;
            }
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let (m, s) = (mtime_ms(&meta), meta.len());
            match self.facts.get(&path) {
                Some(e) if e.mtime_ms == m && e.size == s && e.bridge_key == bridge_key => fresh.push((path, e.facts.clone())),
                _ => dirty_source.push((path, kind, m, s)),
            }
        }

        let parsed: Vec<(PathBuf, FactsEntry)> = dirty_source
            .into_par_iter()
            .map_init(Parser::new, |parser, (path, kind, m, s)| {
                let bytes = fs::read(&path).ok()?;
                let text = String::from_utf8_lossy(&bytes);
                let facts = match kind {
                    FactKind::Source(lang) => extract_facts(lang, &text, parser, bridge, Some(&path)).ok()?,
                    FactKind::Html => html_facts(&text, parser, bridge),
                    FactKind::Binary => return None,
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

        // 并行提取二进制文件事实 (导出符号与依赖库)
        let binary_files: Vec<BinaryFactsFile> = binary_paths
            .into_par_iter()
            .filter_map(|path| {
                let meta = binary::parse_binary(&path).ok()?;
                Some(BinaryFactsFile {
                    path: to_posix(root, &path),
                    format: meta.format,
                    architecture: meta.architecture,
                    exports: meta.symbols.into_iter().map(|s| s.name).collect(),
                    imports: meta.imports.into_iter().map(|i| i.library).collect(),
                })
            })
            .collect();

        // 保留无出边孤立源文件作为合法图顶点（Vertex），确保反向被依赖能正确解析到目标文件
        let mut out: Vec<FactsFile> = fresh
            .into_iter()
            .map(|(ref p, ref f)| FactsFile { path: to_posix(root, p.as_path()), facts: (**f).clone() })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(FactsResult { files: out, binary_files, scanned, parsed: parsed_count, truncated })
    }

    pub fn search(&mut self, root: &Path, q: &Query) -> Result<SearchResult, String> {
        if !root.is_dir() {
            return Err(format!("目录不存在：{}", root.display()));
        }
        let (files, truncated) = list_by(root, &q.glob, &q.ignore_dirs, SrcLang::from_path)?;
        let scanned = files.len();

        // 1) 按 mtime+size 判定哪些需要（重新）解析
        let mut fresh: Vec<(PathBuf, Arc<Outline>)> = Vec::with_capacity(files.len());
        let mut dirty: Vec<(PathBuf, SrcLang, u128, u64)> = Vec::new();
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

        // 2) 并行处理脏文件（每线程一个 Parser）。
        //    脏文件较多且查询末段足够长时启用文本预筛：符号名必以原文出现在所在文件
        //    （VCP 全库 77k 符号实测无例外），不含末段的文件不可能命中 → 推迟到空闲补齐，召回不变。
        let needle = prefilter_needle(&q.name).filter(|_| dirty.len() > PREFILTER_MIN_DIRTY);
        let needle_ref = needle.as_deref();
        let outcomes: Vec<(PathBuf, DirtyOutcome)> = dirty
            .into_par_iter()
            .map_init(Parser::new, |parser, (path, lang, m, s)| {
                let bytes = fs::read(&path).ok()?;
                let text = String::from_utf8_lossy(&bytes);
                if let Some(nd) = needle_ref {
                    if !text.to_lowercase().contains(nd) {
                        return Some((path, DirtyOutcome::Deferred { lang, size: s, lines: count_lines(&text) }));
                    }
                }
                let o = lang.outline(&text, parser).ok()?;
                Some((path, DirtyOutcome::Parsed(Entry { mtime_ms: m, size: s, outline: Arc::new(o) })))
            })
            .flatten()
            .collect();
        let mut parsed: Vec<(PathBuf, Entry)> = Vec::with_capacity(outcomes.len());
        let mut deferred_lines = 0usize;
        for (path, oc) in outcomes {
            match oc {
                DirtyOutcome::Parsed(entry) => {
                    self.pending.remove(&path);
                    parsed.push((path, entry));
                }
                DirtyOutcome::Deferred { lang, size, lines } => {
                    deferred_lines += lines;
                    if self.pending.len() < MAX_CACHE_ENTRIES {
                        self.pending.insert(path, (lang, size, 0));
                    }
                }
            }
        }
        let parsed_count = parsed.len();
        if self.files.len() + parsed_count > MAX_CACHE_ENTRIES {
            self.files.clear();
        }
        for (path, entry) in parsed {
            fresh.push((path.clone(), entry.outline.clone()));
            self.files.insert(path, entry);
        }

        let lines = fresh.iter().map(|(_, o)| o.line_count).sum::<usize>() + deferred_lines;

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
        Ok(SearchResult { hits, total, scanned, parsed: parsed_count, lines, truncated, pending: self.pending.len() })
    }
}
#[cfg(test)]
mod prefilter_tests {
    use super::*;

    fn query(name: &str) -> Query {
        Query { name: name.to_string(), kind: None, glob: Vec::new(), exact: false, limit: 50, ignore_dirs: Vec::new() }
    }

    fn write_files(dir: &Path, n: usize) {
        for i in 0..n {
            let body = if i == 0 {
                "function targetHandler() {\n  return 1;\n}\n".to_string()
            } else {
                format!("function other{i}() {{\n  return {i};\n}}\n")
            };
            fs::write(dir.join(format!("f{i}.js")), body).unwrap();
        }
    }

    #[test]
    fn prefilter_defers_non_candidates_and_idle_fill_completes_cache() {
        let dir = tempfile::tempdir().expect("tempdir");
        let n = PREFILTER_MIN_DIRTY + 6;
        write_files(dir.path(), n);
        let mut cache = Cache::default();

        let r = cache.search(dir.path(), &query("targetHandler")).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.parsed, 1);
        assert_eq!(r.pending, n - 1);
        assert_eq!(r.lines, n * 3);

        // 有请求到达：本批全部回队，不丢文件
        let before = cache.pending_len();
        assert_eq!(cache.step_pending(1 << 20, &|| true), 0);
        assert_eq!(cache.pending_len(), before, "中止的文件必须回队");

        while cache.step_pending(4096, &|| false) > 0 {}
        assert_eq!(cache.pending_len(), 0);

        let r2 = cache.search(dir.path(), &query("other")).unwrap();
        assert_eq!(r2.parsed, 0, "补齐后应全部命中缓存");
        assert_eq!(r2.total, n - 1);
        assert_eq!(r2.pending, 0);
    }

    #[test]
    fn short_query_parses_everything() {
        let dir = tempfile::tempdir().expect("tempdir");
        let n = PREFILTER_MIN_DIRTY + 6;
        write_files(dir.path(), n);
        let mut cache = Cache::default();
        let r = cache.search(dir.path(), &query("ta")).unwrap();
        assert_eq!(r.parsed, n);
        assert_eq!(r.pending, 0);
    }

    #[test]
    fn qualified_query_uses_last_segment() {
        assert_eq!(prefilter_needle("Store::put_blob").as_deref(), Some("put_blob"));
        assert_eq!(prefilter_needle("Store.").as_deref(), Some("store"));
        assert_eq!(prefilter_needle("a.ui"), None);
    }
}


#[cfg(test)]
mod srclang_tests {
    use super::*;

    fn q(name: &str) -> Query {
        Query { name: name.to_string(), kind: None, glob: Vec::new(), exact: false, limit: 50, ignore_dirs: Vec::new() }
    }

    #[test]
    fn search_recalls_symbols_in_geomtry_languages() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("deploy.ps1"), "function Get-Foo {\n    return 1\n}\n").unwrap();
        std::fs::write(dir.path().join("build.sh"), "build_all() {\n    make\n}\n").unwrap();
        std::fs::write(dir.path().join("shader.wgsl"), "fn vs_main() {\n    return;\n}\n").unwrap();

        let mut cache = Cache::default();

        let r = cache.search(dir.path(), &q("Get-Foo")).unwrap();
        assert_eq!(r.total, 1, "ps1 函数应被召回");
        assert_eq!(r.hits[0].symbol.qualified, "Get-Foo");
        assert_eq!(r.hits[0].symbol.kind, "function");

        let r = cache.search(dir.path(), &q("build_all")).unwrap();
        assert_eq!(r.total, 1, "sh 函数应被召回");

        let r = cache.search(dir.path(), &q("vs_main")).unwrap();
        assert_eq!(r.total, 1, "wgsl 函数应被召回");
    }
}