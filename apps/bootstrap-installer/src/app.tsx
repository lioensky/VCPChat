import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { $launchProgress, $logs, $mode, $route, $stages, $status, $updateMessage, cancelInstall, initialize, inspectUpdate, launchVcpchat, startInstall, type InstallerStage } from './store'

export default function App() {
  const route = useStore($route)
  const mode = useStore($mode)
  const status = useStore($status)
  const stages = useStore($stages)
  const updateMessage = useStore($updateMessage)
  const logs = useStore($logs)

  useEffect(() => { void initialize() }, [])

  if (route === 'progress') {
    return <Progress status={status} stages={stages} logs={logs} />
  }
  if (route === 'success') {
    return <Terminal title="准备完成" message="VCPChat 已经可以使用。" />
  }
  if (route === 'failure') {
    return <Terminal title="准备未完成" message={status.lastError ?? 'VCPChat 没有完成这次准备。'} failure />
  }

  return (
    <main className="route welcome" aria-live="polite">
      <section className="welcome-copy">
        <div className="wordmark" role="img" aria-label="VCPChat">VCPCHAT</div>
        <p>一个更懂你的 AI 聊天工作台。<br />我们只检查当前环境，不会在启动时自动 git pull。</p>
        <p className="source-note">{status.source.note}</p>
      </section>
      <button className="primary-action" onClick={() => void startInstall()}>
        {mode === 'update' ? '更新 VCPChat' : '准备 VCPChat'} <span aria-hidden="true">→</span>
      </button>
      <button className="tertiary-action" onClick={() => void inspectUpdate()}>检查更新状态</button>
      {updateMessage && <p className="source-note" role="status">{updateMessage}</p>}
    </main>
  )
}

function Progress({ status, stages, logs }: { status: ReturnType<typeof $status.get>; stages: InstallerStage[]; logs: string[] }) {
  return (
    <main className="route progress-route" aria-live="polite">
      <header><h1>正在准备 VCPChat</h1><span>{status.running ? '进行中' : '完成'}</span></header>
      <div className="progress-track"><div className={status.running ? 'indeterminate' : 'complete'} /></div>
      <div className="stage-list">{stages.map((stage) => <div className={`stage ${stage.state === 'running' ? 'active' : ''}`} key={stage.name}><i />{stage.name}<span className="stage-state">{stage.state === 'succeeded' ? '✓' : stage.state === 'failed' ? '×' : ''}</span></div>)}</div>
      {logs.length > 0 && <details className="live-output"><summary>运行详情</summary><pre>{logs.join('\n')}</pre></details>}
      {status.running && <button className="secondary-action" onClick={() => void cancelInstall()}>取消</button>}
    </main>
  )
}

function Terminal({ title, message, failure = false }: { title: string; message: string; failure?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const launchProgress = useStore($launchProgress)
  async function handleLaunch() {
    setError(null)
    try {
      if (failure) { await startInstall() } else { await launchVcpchat() }
    } catch (value) { setError(String(value)) }
  }
  return <main className="route terminal-route"><div className="wordmark small">VCPCHAT</div><h1 className={failure ? 'failure-title' : ''}>{title}</h1><p>{launchProgress.running ? launchProgress.message : message}</p>{launchProgress.running && <div className="launch-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(launchProgress.progress * 100)}><i style={{ width: `${Math.max(3, launchProgress.progress * 100)}%` }} /></div>}<button className="primary-action" disabled={launchProgress.running} onClick={() => void handleLaunch()}>{failure ? '重新准备' : launchProgress.running ? '正在启动' : '启动 VCPChat'} <span aria-hidden="true">→</span></button>{launchProgress.running && <button className="tertiary-action" onClick={() => void cancelInstall()}>取消启动</button>}{error && <p className="failure-title" role="alert">{error}</p>}</main>
}
