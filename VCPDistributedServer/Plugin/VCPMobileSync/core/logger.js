/**
 * SyncLogger - 桌面端同步日志系统
 * 结构与手机端对齐：Session → Phase → Operation
 * 前缀强制为 [VCPMobileSync]，支持文件持久化与 WebSocket 广播
 */

const fs = require("fs");
const path = require("path");

let wssRef = null;

/**
 * 设置 WebSocket 服务器引用，用于广播日志事件
 */
function setWss(wss) {
  wssRef = wss;
}

class SyncLogger {
  constructor() {
    this.currentSession = null;
    this.currentPhase = "system"; // 默认相位
    this.logDir = path.join(__dirname, "..", "logs", "sync");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.cleanupOldLogs(30); // 插件初始化时自动轮转，最多保留 30 个历史 log
  }

  cleanupOldLogs(maxKeep = 30) {
    try {
      if (!fs.existsSync(this.logDir)) return;
      const files = fs.readdirSync(this.logDir);
      
      const logFiles = files
        .filter(f => f.endsWith(".log"))
        .map(f => {
          const filePath = path.join(this.logDir, f);
          const stats = fs.statSync(filePath);
          return { name: f, path: filePath, mtime: stats.mtimeMs };
        });

      if (logFiles.length > maxKeep) {
        logFiles.sort((a, b) => a.mtime - b.mtime);
        const toDelete = logFiles.slice(0, logFiles.length - maxKeep);
        toDelete.forEach(file => {
          try {
            fs.unlinkSync(file.path);
            console.log(`[VCPMobileSync] Purged old log: ${file.name}`);
          } catch (e) {
            console.error(`[VCPMobileSync] Failed to delete old log ${file.name}:`, e);
          }
        });
      }
    } catch (err) {
      console.error("[VCPMobileSync] Error during cleaning up old logs:", err);
    }
  }

  startSession(prefix = "sync") {
    if (this.currentSession) {
      this.endSession();
    }

    if (this.logStream) {
      try { this.logStream.end(); } catch {}
      this.logStream = null;
    }

    this.currentSession = {
      id: `${prefix}_${Date.now()}`,
      phases: new Map(),
    };
    this.currentPhase = "system";

    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.logFilePath = path.join(this.logDir, `${prefix}_${Date.now()}.log`);
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "a" });

    this.log("╔══════════════════════════════════════════════════════════════════════════════╗");
    this.log(`║ SESSION START: ${this.currentSession.id.padEnd(61)} ║`);
    this.log("╚══════════════════════════════════════════════════════════════════════════════╝");
    this.writeToFile(`=== SESSION START: ${this.currentSession.id} ===`);
    return this.currentSession.id;
  }

  startPhase(phase, expected = 0) {
    const session = this.currentSession;
    if (!session) return;

    // 自动结束上一个正在运行的相位
    if (this.currentPhase && this.currentPhase !== "system" && this.currentPhase !== phase) {
      const prevPhase = session.phases.get(this.currentPhase);
      if (prevPhase && !prevPhase.completed) {
        this.completePhase(this.currentPhase);
      }
    }

    const phaseData = {
      startedAt: Date.now(),
      expected,
      processed: 0,
      success: 0,
      errors: 0,
      completed: false,
    };

    session.phases.set(phase, phaseData);
    this.currentPhase = phase;

    this.log("");
    this.log(`┌─── PHASE START: [${phase}] (expected: ${expected}) ──────────────────────────────`);
    this.writeToFile(`--- PHASE START: [${phase}] (expected: ${expected}) ---`);

    this.broadcast({ type: "DESKTOP_PHASE_START", phase, ts: Date.now() });
    return phaseData;
  }

  logOperation(phase, type, id, result, detail = null) {
    const session = this.currentSession;
    const targetPhase = phase || this.currentPhase;

    if (session) {
      const phaseData = session.phases.get(targetPhase);
      if (phaseData) {
        phaseData.processed++;
        if (result === "success") phaseData.success++;
        else if (result === "error") phaseData.errors++;

        if (phaseData.processed % 100 === 0) {
          const progressMsg = `[PROGRESS] ${targetPhase}: ${phaseData.processed}/${phaseData.expected || "?"} (OK:${phaseData.success} ERR:${phaseData.errors})`;
          this.log(`│ ${progressMsg}`);
          this.writeToFile(progressMsg);
        }
      }
    }

    const message = detail ? `${type}:${id} -> ${result} (${detail})` : `${type}:${id} -> ${result}`;
    const level = result === "error" ? "error" : result === "warn" ? "warn" : "info";
    
    this.log(`│ [${targetPhase.padEnd(14)}] ${message}`);
    this.writeToFile(`[${targetPhase}] ${message}`);

    this.broadcast({ type: "SYNC_LOG_EVENT", level, phase: targetPhase, message, ts: Date.now() });
  }

  logInfo(phase, message, level = "info") {
    const targetPhase = phase || this.currentPhase;
    this.log(`│ [${targetPhase.padEnd(14)}] ${message}`);
    this.writeToFile(`[${targetPhase}] ${message}`);
    this.broadcast({ type: "SYNC_LOG_EVENT", level, phase: targetPhase, message, ts: Date.now() });
  }

  completePhase(phase) {
    const session = this.currentSession;
    if (!session) return null;

    const targetPhase = phase || this.currentPhase;
    const phaseData = session.phases.get(targetPhase);
    if (!phaseData || phaseData.completed) return null;

    const duration = Date.now() - phaseData.startedAt;
    phaseData.completed = true;

    this.log(`└─── PHASE COMPLETE: [${targetPhase}] duration: ${duration}ms (Total:${phaseData.processed} OK:${phaseData.success} ERR:${phaseData.errors})`);
    this.log("");
    this.writeToFile(`--- PHASE COMPLETE: [${targetPhase}] ---`);

    this.broadcast({ type: "DESKTOP_PHASE_COMPLETE", phase: targetPhase, ts: Date.now() });
    return { phase: targetPhase, duration };
  }

  endSession() {
    const session = this.currentSession;
    if (!session) return;

    // 完成所有未完成的相位
    for (const [phase, data] of session.phases) {
      if (!data.completed) this.completePhase(phase);
    }

    this.log("╔══════════════════════════════════════════════════════════════════════════════╗");
    this.log(`║ SESSION END: ${session.id.padEnd(63)} ║`);
    this.log("╚══════════════════════════════════════════════════════════════════════════════╝");
    this.log("");
    this.writeToFile(`=== SESSION END: ${session.id} ===`);

    this.currentSession = null;
    this.currentPhase = "system";

    if (this.logStream) {
      const stream = this.logStream;
      this.logStream = null;
      setTimeout(() => { if (!stream.destroyed) stream.end(); }, 500);
    }
  }

  log(message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[VCPMobile] [${timestamp}] ${message}`);
  }

  writeToFile(message) {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(`[${new Date().toISOString()}] ${message}\n`);
    }
  }

  broadcast(payload) {
    if (!wssRef) return;
    const text = JSON.stringify(payload);
    wssRef.clients.forEach(c => { if (c.readyState === 1) try { c.send(text); } catch(e) {} });
  }
}

// 全局单例
let globalLogger = null;

function getLogger() {
  if (!globalLogger) {
    globalLogger = new SyncLogger();
  }
  return globalLogger;
}

function resetLogger() {
  if (globalLogger) {
    globalLogger.endSession();
  }
  globalLogger = new SyncLogger();
  return globalLogger;
}

module.exports = {
  SyncLogger,
  getLogger,
  resetLogger,
  setWss,
};
