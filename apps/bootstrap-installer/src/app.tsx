import { useStore } from '@nanostores/react'
import { Check, ChevronRight, CircleAlert, FileText, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  $failedStage, $launchProgress, $logPath, $logs, $mode, $progress, $route, $stages, $status, $updateSnapshot,
  cancelInstall, initialize, launchVcpchat, openLogDirectory, returnToWelcome, startInstall,
  type InstallerStage,
} from './store'

export default function App() {
  const route = useStore($route)

  useEffect(() => { void initialize() }, [])

  return <div className="app-shell">
    {route === 'welcome' && <Welcome />}
    {route === 'progress' && <Progress />}
    {route === 'success' && <Success />}
    {route === 'cancelled' && <Cancelled />}
    {route === 'failure' && <Failure />}
  </div>
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? 'brand compact' : 'brand'} aria-label="VCPChat">VCPCHAT</div>
}

function Welcome() {
  const mode = useStore($mode)
  const status = useStore($status)
  const update = useStore($updateSnapshot)
  const locating = status.source.note === '正在定位 VCPChat 项目…'
  const sourceMissing = !locating && status.source.mode === 'source-missing'

  return <main className="route welcome-route">
    <section className="welcome-copy">
      <Brand />
      <h1>{mode === 'update' ? '更新 VCPChat' : '准备你的 VCPChat 工作台'}</h1>
      <p>安装器会检查依赖、Electron 原生模块和本地服务。不会自动拉取代码，也不会覆盖尚未提交的修改。</p>
    </section>
    <section className={`source-summary ${sourceMissing ? 'blocked' : ''}`} aria-live="polite">
      <span className="status-dot" aria-hidden="true" />
      <div><strong>{locating ? '正在检查项目' : sourceMissing ? '没有找到 VCPChat 项目' : '已找到 VCPChat 项目'}</strong><small>{status.source.note}</small></div>
    </section>
    {mode === 'update' && update?.available ? <UpdateChoice snapshot={update} /> : <button className="primary-action" disabled={locating || sourceMissing} onClick={() => void startInstall()}>
      {locating ? '正在检查' : mode === 'update' ? '开始更新' : '开始准备'} <ChevronRight size={17} aria-hidden="true" />
    </button>}
  </main>
}

function UpdateChoice({ snapshot }: { snapshot: import('./store').UpdateSnapshot }) {
  const [expanded, setExpanded] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)
  async function launchExisting() {
    setLaunchError(null)
    try { await launchVcpchat() } catch (value) { setLaunchError(String(value)) }
  }
  const hasLocalChanges = snapshot.dirty
  return <section className="update-choice" aria-live="polite">
    <div className="update-choice-copy"><strong>发现上游有新版本</strong><p>{hasLocalChanges ? '更新前检测到本地修改。你可以安全暂存后更新，也可以继续使用当前版本。' : snapshot.note}</p>{hasLocalChanges && expanded && <ul>{snapshot.changes.map((change) => <li key={change}>{change}</li>)}</ul>}</div>
    <div className="update-choice-actions"><button className="primary-action" onClick={() => void startInstall(hasLocalChanges ? 'stash' : undefined)}><RotateCcw size={16} />更新到最新版本</button>{hasLocalChanges && <button className="secondary-action" onClick={() => setExpanded((value) => !value)}>{expanded ? '隐藏修改' : `查看修改（${snapshot.changes.length}）`}</button>}<button className="text-action centered" onClick={() => void launchExisting()}>跳过更新，启动当前版本</button></div>
    {launchError && <p className="inline-error" role="alert">{launchError}</p>}
  </section>
}

function Progress() {
  const status = useStore($status)
  const stages = useStore($stages)
  const progress = useStore($progress)
  const logs = useStore($logs)
  const [showLogs, setShowLogs] = useState(false)
  const [now, setNow] = useState(Date.now())
  const logEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!status.running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [status.running])
  useEffect(() => { if (showLogs) logEnd.current?.scrollIntoView({ block: 'end' }) }, [logs.length, showLogs])

  const percent = Math.round(progress.fraction * 100)
  return <main className="route progress-route">
    <header className="route-header"><Brand compact /><div><h1>{status.cancelling ? '正在安全停止' : '正在准备 VCPChat'}</h1><p>{status.cancelling ? '正在结束当前进程并保存诊断记录。' : '完成后会再次验证整个运行环境。'}</p></div></header>
    <section className="progress-summary" aria-live="polite">
      <div><span>{progress.done} / {progress.total} 步骤</span><strong>{percent}%</strong></div>
      <div className="progress-track" role="progressbar" aria-label="准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></div>
    </section>
    <div className={`progress-body ${showLogs ? 'with-logs' : ''}`}>
      <ol className="stage-list">{stages.map((stage) => <StageRow key={stage.id} stage={stage} now={now} />)}</ol>
      {showLogs && <aside className="live-output" aria-label="运行详情"><header><span>运行详情</span><span>{logs.length} 行</span></header><pre>{logs.join('\n')}<div ref={logEnd} /></pre></aside>}
    </div>
    <footer className="route-footer">
      <button className="text-action" onClick={() => setShowLogs((value) => !value)}><FileText size={15} />{showLogs ? '隐藏详情' : '显示详情'}<ChevronRight className={showLogs ? 'rotated' : ''} size={14} /></button>
      <button className="secondary-action" disabled={status.cancelling} onClick={() => void cancelInstall()}>{status.cancelling ? '正在停止…' : '取消'}</button>
    </footer>
  </main>
}

function StageRow({ stage, now }: { stage: InstallerStage; now: number }) {
  const elapsed = stage.state === 'running' && stage.startedAt ? now - stage.startedAt : stage.durationMs
  return <li className="stage" data-state={stage.state}>
    <span className="stage-icon" aria-hidden="true">{stage.state === 'running' ? <i /> : stage.state === 'failed' ? <X size={14} /> : ['succeeded', 'skipped'].includes(stage.state) ? <Check size={14} /> : null}</span>
    <span className="stage-copy"><strong>{stage.title}</strong><small>{stage.detail}</small></span>
    {elapsed != null && <time>{formatDuration(elapsed)}</time>}
  </li>
}

function Success() {
  const mode = useStore($mode)
  const launch = useStore($launchProgress)
  const [error, setError] = useState<string | null>(null)
  const alreadyRunning = error?.includes('已经在运行中') ?? false
  async function handleLaunch() {
    setError(null)
    try { await launchVcpchat() } catch (value) { setError(String(value)) }
  }
  return <Terminal icon={<Check />} title={alreadyRunning ? 'VCPChat 已经在运行' : mode === 'update' ? 'VCPChat 已更新完成' : 'VCPChat 已准备完成'} message={alreadyRunning ? '检测到电脑上已有 VCPChat 窗口。请切回任务栏中的已有窗口继续使用，无需重复启动。' : launch.running ? launch.message : '依赖和运行环境均已通过检查。'}>
    {launch.running && <div className="launch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(launch.progress * 100)}><i style={{ width: `${Math.max(3, launch.progress * 100)}%` }} /></div>}
    <button className="primary-action" disabled={launch.running} onClick={() => void handleLaunch()}>{launch.running ? '正在启动' : '打开 VCPChat'} <ChevronRight size={17} /></button>
    {launch.running && <button className="text-action centered" onClick={() => void cancelInstall()}>取消启动</button>}
    {error && <p className="inline-error" role="alert">{alreadyRunning ? '启动请求已安全取消：已有实例正在使用中。' : error}</p>}
  </Terminal>
}

function Cancelled() {
  const mode = useStore($mode)
  const update = useStore($updateSnapshot)
  return <Terminal icon={<X />} title="准备已取消" message="没有继续修改运行环境。你可以返回后重新开始。">
    <button className="primary-action" onClick={() => void startInstall(mode === 'update' && update?.dirty ? 'stash' : undefined)}><RotateCcw size={16} />重新开始</button>
    <button className="text-action centered" onClick={returnToWelcome}>返回</button>
  </Terminal>
}

function Failure() {
  const mode = useStore($mode)
  const update = useStore($updateSnapshot)
  const status = useStore($status)
  const stages = useStore($stages)
  const failedStage = useStore($failedStage)
  const logPath = useStore($logPath)
  const stageTitle = stages.find((stage) => stage.id === failedStage)?.title
  const manualStashRecovery = status.lastError?.includes('git stash apply --index') ?? false
  return <Terminal danger icon={<CircleAlert />} title="准备未完成" message={stageTitle ? `${stageTitle}未能完成。` : '安装器安全停止，没有继续执行后续步骤。'}>
    <div className="error-detail" role="alert"><strong>{status.lastError ?? '发生未知错误'}</strong>{logPath && <small>诊断记录：{logPath}</small>}</div>
    <div className="terminal-actions">{!manualStashRecovery && <button className="primary-action" onClick={() => void startInstall(mode === 'update' && update?.dirty ? 'stash' : undefined)}><RotateCcw size={16} />重新检查并重试</button>}<button className={manualStashRecovery ? 'primary-action' : 'secondary-action'} onClick={() => void openLogDirectory()}><FileText size={16} />打开诊断记录</button></div>
  </Terminal>
}

function Terminal({ icon, title, message, danger = false, children }: { icon: ReactNode; title: string; message: string; danger?: boolean; children: ReactNode }) {
  return <main className="route terminal-route"><Brand compact /><div className={`terminal-icon ${danger ? 'danger' : ''}`} aria-hidden="true">{icon}</div><h1>{title}</h1><p>{message}</p>{children}</main>
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1000) return '<1 秒'
  const seconds = Math.floor(milliseconds / 1000)
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.floor(seconds / 60)}分 ${seconds % 60}秒`
}
