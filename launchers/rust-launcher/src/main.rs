// VCP 一键启动器
// 只做一件事：拉起后端（隐藏窗口）→ 等 6005 就绪 → 拉起前端 → 自己退出。
// 无控制台窗口、无外部依赖，编译后几百 KB。
#![windows_subsystem = "windows"]

use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const ROOT: &str = r"D:\AI\vcp";
const VCP_ROOT: &str = r"D:\AI\vcp\VCP_AIOS";
const NODE: &str = r"D:\AI\vcp\VCP_AIOS\runtimes\node\node.exe";
const TOOLBOX: &str = r"D:\AI\vcp\VCP_AIOS\VCPToolBox";
const CHAT: &str = r"D:\AI\vcp\VCP_AIOS\VCPChat";
const CHAT_EXE: &str = r"D:\AI\vcp\VCP_AIOS\VCPChat\StartVCPchat.exe";
const LOG: &str = r"D:\AI\vcp\logs\launcher.log";

#[repr(C)]
struct SystemTime {
    year: u16,
    month: u16,
    day_of_week: u16,
    day: u16,
    hour: u16,
    minute: u16,
    second: u16,
    millis: u16,
}

extern "system" {
    fn GetLocalTime(lp_system_time: *mut SystemTime);
}

fn log(msg: &str) {
    let line = format!("[{}] {}\n", now_string(), msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn now_string() -> String {
    let mut t = SystemTime {
        year: 0, month: 0, day_of_week: 0, day: 0,
        hour: 0, minute: 0, second: 0, millis: 0,
    };
    unsafe { GetLocalTime(&mut t) };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

fn port_open(port: u16) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(_) => true,
        Err(_) => false,
    }
}

fn spawn_hidden(exe: &str, args: &[&str], cwd: &str) -> bool {
    let mut cmd = Command::new(exe);
    // 把便携 node 加进 PATH：静态插件会直接调 `node`，不加会报 'node' is not recognized
    let node_dir = r"D:\AI\vcp\VCP_AIOS\runtimes\node";
    let old_path = std::env::var("PATH").unwrap_or_default();
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", format!("{};{}", node_dir, old_path))
        .creation_flags(CREATE_NO_WINDOW);
    match cmd.spawn() {
        Ok(_) => true,
        Err(e) => {
            log(&format!("spawn 失败 {}: {}", exe, e));
            false
        }
    }
}

fn wait_port(port: u16, timeout_secs: u64) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(timeout_secs) {
        if port_open(port) {
            return true;
        }
        sleep(Duration::from_millis(300));
    }
    false
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dry_run = args.iter().any(|a| a == "--dry-run");

    log("=== launcher 启动 ===");

    // 1. 后端：6005 没监听才启动
    if port_open(6005) {
        log("后端已在运行（6005 已监听），跳过启动");
    } else {
        log("启动后端 server.js");
        if !dry_run && Path::new(NODE).exists() {
            spawn_hidden(NODE, &["server.js"], TOOLBOX);
        }
        if !dry_run && !wait_port(6005, 45) {
            log("等待 6005 超时，继续尝试拉起前端");
        } else if !dry_run {
            log("后端 6005 已就绪");
        }
    }

    // 2. 管理面板：6006 没监听才启动
    if !port_open(6006) {
        log("启动管理面板 adminServer.js");
        if !dry_run && Path::new(NODE).exists() {
            spawn_hidden(NODE, &["adminServer.js"], TOOLBOX);
        }
    }

    // 3. 前端：VCPChat 自己有单实例锁，重复启动只会激活已有窗口
    log("启动前端 VCPChat");
    if !dry_run {
        if Path::new(CHAT_EXE).exists() {
            let mut cmd = Command::new(CHAT_EXE);
            cmd.current_dir(CHAT);
            if let Err(e) = cmd.spawn() {
                log(&format!("启动前端失败: {}", e));
            }
        } else {
            log("找不到 StartVCPchat.exe");
        }
    }

    log("launcher 退出");
}
