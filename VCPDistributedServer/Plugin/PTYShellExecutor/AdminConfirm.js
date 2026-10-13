/**
 * Linux / POSIX 桌面环境下的安全确认与管理员提权模块 (AdminConfirm.js)
 * 支持基于 Electron dialog 的可视化权限确认与高危命令审核。
 */
"use strict";

const { dialog } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function confirmAdminExecution(command, { keyword = "", reason = "" } = {}) {
    // 1. 如果在 Electron 环境中且有窗口支持，弹出确认框
    const title = "⚠️ VCP 终端命令执行确认";
    const detail = [
        "AI 正在请求以提权或敏感模式执行以下 Shell 命令：",
        "",
        command,
        "",
        reason ? `触发规则: ${reason}` : "",
        keyword ? `命中关键字: ${keyword}` : "",
        "",
        "请确认是否允许执行此命令？"
    ].filter(Boolean).join("\n");

    try {
        if (dialog && typeof dialog.showMessageBox === "function") {
            const response = await dialog.showMessageBox({
                type: "warning",
                buttons: ["允许执行", "拒绝取消"],
                defaultId: 1,
                cancelId: 1,
                title,
                message: "安全审核警告：高危或管理员命令确认",
                detail,
                noLink: true
            });
            return response.response === 0;
        }
    } catch (e) {
        console.warn("[AdminConfirm] Electron dialog unavailable, falling back to zenity/cli:", e.message);
    }

    // 2. 回退到 Linux 原生 zenity (如果可用)
    try {
        const { spawnSync } = require("child_process");
        const res = spawnSync("zenity", [
            "--question",
            `--title=${title}`,
            `--text=${detail}`,
            "--ok-label=允许执行",
            "--cancel-label=拒绝取消"
        ], { timeout: 30000 });
        return res.status === 0;
    } catch (_) {}

    // 默认安全拒绝
    return false;
}

function executeAdminCommand(command) {
    return new Promise(async (resolve, reject) => {
        const allowed = await confirmAdminExecution(command, { reason: "管理员提权请求" });
        if (!allowed) {
            return reject(new Error("用户在安全确认窗口中拒绝了提权执行请求。"));
        }

        const tmpFile = path.join(os.tmpdir(), `vcp-admin-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
        // 使用 pkexec 或 直接 bash 执行命令并捕获输出
        const cmdScript = `(${command}) > "${tmpFile}" 2>&1`;
        
        let runner = "bash";
        let args = ["-c", cmdScript];
        
        // 尝试用 pkexec 执行提权，若不可用则普通 bash
        try {
            const { spawnSync } = require("child_process");
            if (spawnSync("which", ["pkexec"]).status === 0) {
                runner = "pkexec";
                args = ["bash", "-c", cmdScript];
            }
        } catch (_) {}

        const child = spawn(runner, args);
        child.on("error", err => {
            try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
            reject(new Error(`提权执行启动失败: ${err.message}`));
        });

        child.on("close", code => {
            let output = "";
            try {
                if (fs.existsSync(tmpFile)) {
                    output = fs.readFileSync(tmpFile, "utf8");
                    fs.unlinkSync(tmpFile);
                }
            } catch (_) {}

            if (code !== 0) {
                return reject(new Error(`管理员提权命令执行失败 (退出码 ${code}):\n${output}`));
            }
            resolve(output);
        });
    });
}

module.exports = {
    confirmAdminExecution,
    executeAdminCommand
};
