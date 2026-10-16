//! ProjectForge AST 符号索引 sidecar。
//!
//! 由 ProjectForge 插件进程拉起并独占持有，stdio JSON-lines 通信：
//! - 启动后 stdout 输出一行 READY：`{"type":"ready","protocolVersion":1,"languages":[...]}`；
//! - 之后每行一个请求 `{"id":1,"method":"outline","params":{...}}`，
//!   每行一个响应 `{"id":1,"ok":true,"result":{...}}` 或 `{"id":1,"ok":false,"error":{"code","message"}}`；
//! - stdin 关闭（插件进程退出）即退出，不会遗留孤儿进程；日志只写 stderr。
//!
//! 方法：
//! - `ping`
//! - `outline { text, lang? , path? }`：解析调用方给出的文本（调用方持有内容与 hash，区间与之严格对应）；
//! - `findSymbols { root, name, kind?, glob?, exact?, limit?, ignoreDirs? }`：扫描目录按名称查找定义（mtime+size 缓存）；
//!   ignoreDirs 由插件传入（单一来源：workspaceIndex.js 的 DEFAULT_IGNORED_DIRS），缺省用内置列表；
//! - `facts { root, glob?, ignoreDirs?, bridgeGlobals? }`（协议 2 起）：扫描 JS 族源码与 HTML 页面的链路事实
//!   （require/import、IPC 注册/调用/推送、preload 桥接成员访问、window 全局、exposeInMainWorld、HTML 脚本顺序）；
//! - `clearCache`、`shutdown`。

mod facts;
mod binary;
mod lang;
mod scan;
mod symbols;
mod geo;

use std::io::{self, BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{self, TryRecvError};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use tree_sitter::Parser;

use lang::Lang;
use scan::{Cache, Query};

pub const PROTOCOL_VERSION: u32 = 3;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// 每次空闲补齐的字节预算（并行解析，批内按大小降序）。
/// 补齐可被新请求中止，因此预算只影响吞吐，不影响请求等待时间。
const PENDING_BATCH_BYTES: u64 = 4 * 1024 * 1024;

struct Failure {
    code: &'static str,
    message: String,
}

fn fail(code: &'static str, message: impl Into<String>) -> Failure {
    Failure { code, message: message.into() }
}

struct State {
    parser: Parser,
    cache: Cache,
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn str_list(params: &Value, key: &str) -> Vec<String> {
    match params.get(key) {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.trim().to_string()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    }
}

fn handle(state: &mut State, method: &str, params: &Value) -> Result<Value, Failure> {
    match method {
        "ping" => Ok(json!({ "pong": true, "cached": state.cache.len(), "pending": state.cache.pending_len() })),
        "outline" => {
            let path_opt = str_param(params, "path");
            let lang_opt = str_param(params, "lang");
            let is_bin = path_opt.is_some_and(|p| Lang::is_binary_path(Path::new(p)))
                || lang_opt == Some("binary");

            if is_bin {
                let p = path_opt.ok_or_else(|| fail("INVALID_PARAMS", "二进制 outline 需要 path 参数"))?;
                let meta = binary::parse_binary(Path::new(p)).map_err(|e| fail("PARSE_FAILED", e))?;
                return serde_json::to_value(meta).map_err(|e| fail("INTERNAL", e.to_string()));
            }

            let text = params
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| fail("INVALID_PARAMS", "outline 需要 text"))?;
            if text.len() > MAX_TEXT_BYTES {
                return Err(fail("TOO_LARGE", format!("文本超过 {MAX_TEXT_BYTES} 字节上限")));
            }
            // 优先 Tree-sitter grammar；无 grammar 的语言回退几何 Outline（二期①）
            if let Some(lang) = lang_opt
                .and_then(Lang::from_name)
                .or_else(|| path_opt.and_then(|p| Lang::from_path(Path::new(p))))
            {
                let mut o = symbols::outline(lang, text, &mut state.parser).map_err(|e| fail("PARSE_FAILED", e))?;
                if o.has_error {
                    // 二期②：语法破损时用几何拱修正符号边界（保守止血）
                    geo::heal_outline(&mut o, text, geo::ScanStyle::for_lang(lang));
                }
                return serde_json::to_value(&o).map_err(|e| fail("INTERNAL", e.to_string()));
            }
            if let Some(prof) = lang_opt
                .and_then(geo::profile_from_name)
                .or_else(|| path_opt.and_then(|p| geo::profile_from_path(Path::new(p))))
            {
                let o = geo::geo_outline(text, &prof);
                return serde_json::to_value(o).map_err(|e| fail("INTERNAL", e.to_string()));
            }
            Err(fail("UNSUPPORTED_LANG", "不支持的语言（无 grammar 且无几何档案）"))
        }
        "findSymbols" => {
            let root = str_param(params, "root").ok_or_else(|| fail("INVALID_PARAMS", "findSymbols 需要 root"))?;
            let name = str_param(params, "name").ok_or_else(|| fail("INVALID_PARAMS", "findSymbols 需要 name"))?;
            let glob = str_list(params, "glob");
            let q = Query {
                name: name.to_string(),
                kind: str_param(params, "kind").map(String::from),
                glob,
                exact: params.get("exact").and_then(Value::as_bool).unwrap_or(false),
                limit: params.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as usize,
                ignore_dirs: params
                    .get("ignoreDirs")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default(),
            };
            let r = state.cache.search(&PathBuf::from(root), &q).map_err(|e| fail("SEARCH_FAILED", e))?;
            serde_json::to_value(r).map_err(|e| fail("INTERNAL", e.to_string()))
        }
        "facts" => {
            let root = str_param(params, "root").ok_or_else(|| fail("INVALID_PARAMS", "facts 需要 root"))?;
            let mut bridge = str_list(params, "bridgeGlobals");
            if bridge.is_empty() {
                bridge = facts::DEFAULT_BRIDGE_GLOBALS.iter().map(|&s| s.to_string()).collect();
            }
            let r = state
                .cache
                .facts(&PathBuf::from(root), &str_list(params, "glob"), &str_list(params, "ignoreDirs"), &bridge)
                .map_err(|e| fail("SEARCH_FAILED", e))?;
            serde_json::to_value(r).map_err(|e| fail("INTERNAL", e.to_string()))
        }
        "clearCache" => {
            state.cache.clear();
            Ok(json!({ "cleared": true }))
        }
        _ => Err(fail("UNKNOWN_METHOD", format!("未知方法：{method}"))),
    }
}

fn write_line(out: &mut impl Write, value: &Value) -> io::Result<()> {
    serde_json::to_writer(&mut *out, value)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut languages: Vec<&str> = Lang::ALL.iter().map(|l| l.name()).collect();
    languages.push("binary");
    if write_line(&mut out, &json!({ "type": "ready", "protocolVersion": PROTOCOL_VERSION, "languages": languages })).is_err() {
        return;
    }

    let mut state = State { parser: Parser::new(), cache: Cache::default() };

    // 独立线程读 stdin；缓存始终只由主线程持有，空闲补齐无需加锁。
    // stdin 关闭 → 读线程结束 → 发送端释放 → 主线程收到 Disconnected 退出，不遗留孤儿进程。
    // 在途请求计数：读线程发送前 +1，主线程取出后 -1；>0 时正在进行的补齐立即中止。
    // 用计数而非布尔：避免"清标志"与"新请求到达"之间的竞态。
    let (tx, rx) = mpsc::channel::<String>();
    let queued = Arc::new(AtomicUsize::new(0));
    let reader_queued = Arc::clone(&queued);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            reader_queued.fetch_add(1, Ordering::SeqCst);
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let should_stop = {
        let q = Arc::clone(&queued);
        move || q.load(Ordering::SeqCst) > 0
    };

    loop {
        let line = if state.cache.pending_len() > 0 {
            // 有待补齐文件：请求优先；无请求则立即补下一批，不空等。
            match rx.try_recv() {
                Ok(line) => line,
                Err(TryRecvError::Empty) => {
                    // 该批已先移出队列，panic 不会造成死循环。
                    if catch_unwind(AssertUnwindSafe(|| state.cache.step_pending(PENDING_BATCH_BYTES, &should_stop))).is_err() {
                        eprintln!("[projectforge_indexer] panic while filling pending cache");
                    }
                    continue;
                }
                Err(TryRecvError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(line) => line,
                Err(_) => break,
            }
        };
        queued.fetch_sub(1, Ordering::SeqCst);
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({ "id": null, "ok": false, "error": { "code": "INVALID_JSON", "message": e.to_string() } });
                if write_line(&mut out, &resp).is_err() {
                    break;
                }
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        if method == "shutdown" {
            let _ = write_line(&mut out, &json!({ "id": id, "ok": true, "result": { "bye": true } }));
            break;
        }
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        let outcome = catch_unwind(AssertUnwindSafe(|| handle(&mut state, &method, &params)));
        let resp = match outcome {
            Ok(Ok(result)) => json!({ "id": id, "ok": true, "result": result }),
            Ok(Err(f)) => json!({ "id": id, "ok": false, "error": { "code": f.code, "message": f.message } }),
            Err(_) => {
                // panic 后 parser 状态不可信，重建
                state.parser = Parser::new();
                eprintln!("[projectforge_indexer] panic while handling {method}");
                json!({ "id": id, "ok": false, "error": { "code": "PANIC", "message": "索引器内部错误（已恢复）" } })
            }
        };
        if write_line(&mut out, &resp).is_err() {
            break;
        }
    }
}