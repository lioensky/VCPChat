import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { atom, computed } from 'nanostores'

export type Route = 'welcome' | 'progress' | 'success' | 'cancelled' | 'failure'
export type InstallerMode = 'install' | 'update'
export type StageState = 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'

export interface SourceSnapshot {
  mode: 'source-present' | 'source-missing'
  root: string | null
  branch: string | null
  commit: string | null
  treeHash: string | null
  dirty: boolean
  packageLockHash: string | null
  electronVersion: string | null
  nodeVersion: string | null
  npmVersion: string | null
  note: string
}

export interface UpdateSnapshot {
  available: boolean
  dirty: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  changes: string[]
  note: string
}

export interface InstallerStatus {
  running: boolean
  cancelling: boolean
  cancelled: boolean
  completed: boolean
  version: string | null
  lastError: string | null
  currentStage: string | null
  source: SourceSnapshot
}

export interface StageInfo {
  id: string
  title: string
  detail: string
}

export interface InstallerStage extends StageInfo {
  state: StageState
  startedAt?: number
  durationMs?: number
}

const EMPTY_SOURCE: SourceSnapshot = {
  mode: 'source-missing', root: null, branch: null, commit: null, treeHash: null,
  dirty: false, packageLockHash: null, electronVersion: null, nodeVersion: null,
  npmVersion: null, note: '正在定位 VCPChat 项目…',
}

const EMPTY_STATUS: InstallerStatus = {
  running: false, cancelling: false, cancelled: false, completed: false,
  version: null, lastError: null, currentStage: null, source: EMPTY_SOURCE,
}

export const $route = atom<Route>('welcome')
export const $mode = atom<InstallerMode>('install')
export const $status = atom<InstallerStatus>(EMPTY_STATUS)
export const $stages = atom<InstallerStage[]>([])
export const $logs = atom<string[]>([])
export const $logPath = atom<string | null>(null)
export const $failedStage = atom<string | null>(null)
export const $updateSnapshot = atom<UpdateSnapshot | null>(null)
export const $launchProgress = atom({ running: false, progress: 0, message: '' })
export const $progress = computed($stages, (stages) => {
  const done = stages.filter((stage) => ['succeeded', 'skipped', 'failed'].includes(stage.state)).length
  return { done, total: stages.length, fraction: stages.length === 0 ? 0 : done / stages.length }
})

type InstallerEvent =
  | { type: 'manifest'; stages: StageInfo[] }
  | { type: 'stage'; name: string; state: StageState; durationMs?: number }
  | { type: 'log'; line: string }
  | { type: 'launchProgress'; progress: number; message: string }
  | { type: 'complete'; version: string }
  | { type: 'cancelled' }
  | { type: 'failed'; stage?: string; error: string }

let unlisten: UnlistenFn | null = null

function updateStage(name: string, state: StageState, durationMs?: number) {
  $stages.set($stages.get().map((stage) => stage.id === name ? {
    ...stage,
    state,
    startedAt: state === 'running' ? (stage.startedAt ?? Date.now()) : stage.startedAt,
    durationMs,
  } : stage))
}

export async function initialize() {
  if (!unlisten) {
    try {
      unlisten = await listen<InstallerEvent>('installer', ({ payload }) => {
        if (payload.type === 'manifest') {
          $stages.set(payload.stages.map((stage) => ({ ...stage, state: 'pending' })))
          $route.set('progress')
        } else if (payload.type === 'stage') {
          updateStage(payload.name, payload.state, payload.durationMs)
          $status.set({ ...$status.get(), currentStage: payload.state === 'running' ? payload.name : $status.get().currentStage })
        } else if (payload.type === 'complete') {
          $status.set({ ...$status.get(), running: false, cancelling: false, cancelled: false, completed: true, version: payload.version, lastError: null, currentStage: null })
          $route.set('success')
        } else if (payload.type === 'cancelled') {
          $status.set({ ...$status.get(), running: false, cancelling: false, cancelled: true, completed: false, lastError: null, currentStage: null })
          $route.set('cancelled')
        } else if (payload.type === 'failed') {
          $failedStage.set(payload.stage ?? null)
          $status.set({ ...$status.get(), running: false, cancelling: false, cancelled: false, completed: false, version: null, lastError: payload.error, currentStage: null })
          $route.set('failure')
        } else if (payload.type === 'log') {
          $logs.set([...$logs.get(), payload.line].slice(-2000))
        } else if (payload.type === 'launchProgress') {
          $launchProgress.set({ running: true, progress: payload.progress, message: payload.message })
        }
      })
    } catch {
      // Browser preview has no Tauri bridge.
    }
  }

  try {
    const [mode, status, logPath] = await Promise.all([
      invoke<InstallerMode>('get_mode'),
      invoke<InstallerStatus>('get_installer_status'),
      invoke<string>('get_log_path'),
    ])
    $mode.set(mode)
    $status.set(status)
    $logPath.set(logPath)
    if (mode === 'update') {
      try { $updateSnapshot.set(await invoke<UpdateSnapshot>('get_update_snapshot')) } catch { /* best effort */ }
    }
    if (status.running) {
      if (status.currentStage) {
        const info = fallbackStageInfo(status.currentStage)
        $stages.set([{ ...info, state: 'running', startedAt: Date.now() }])
      }
      $route.set('progress')
    } else if (status.completed) {
      $route.set('success')
    } else if (status.cancelled) {
      $route.set('cancelled')
    } else if (status.lastError) {
      $route.set('failure')
    }
  } catch {
    // Browser preview keeps the welcome screen usable.
  }
}

function fallbackStageInfo(id: string): StageInfo {
  const labels: Record<string, [string, string]> = {
    'locate-source': ['定位 VCPChat', '确认项目目录和启动入口'],
    'inspect-git': ['检查项目状态', '保护尚未提交的本地修改'],
    'stash-changes': ['保护本地修改', '创建可恢复的命名 Git stash'],
    'fetch-upstream': ['获取上游更新', '刷新当前分支的远端提交'],
    'update-source': ['更新项目源码', '仅执行 fast-forward 更新'],
    'restore-changes': ['恢复本地修改', '按记录的 stash OID 恢复并确认'],
    'repair-environment': ['准备运行环境', '安装依赖并适配 Electron 原生模块'],
    'final-doctor': ['验证运行环境', '确认 Electron、ABI 和原生服务均可用'],
  }
  const [title, detail] = labels[id] ?? [id, '正在处理当前步骤']
  return { id, title, detail }
}

export async function startInstall(strategy?: 'stash') {
  $stages.set([{
    id: 'prepare-plan', title: '生成检查计划', detail: '正在读取项目和运行环境信息',
    state: 'running', startedAt: Date.now(),
  }])
  $logs.set([])
  $failedStage.set(null)
  $route.set('progress')
  $status.set({ ...$status.get(), running: true, cancelling: false, cancelled: false, completed: false, version: null, lastError: null, currentStage: null })
  try {
    await invoke('start_installer', { strategy: strategy ?? null })
  } catch (error) {
    $status.set({ ...$status.get(), running: false, lastError: String(error) })
    $route.set('failure')
  }
}

export async function cancelInstall() {
  const installationRunning = $status.get().running
  const launchRunning = $launchProgress.get().running
  if ((!installationRunning && !launchRunning) || $status.get().cancelling) return
  if (installationRunning) $status.set({ ...$status.get(), cancelling: true })
  try {
    await invoke('cancel_installer')
  } catch (error) {
    $status.set({ ...$status.get(), cancelling: false, lastError: String(error) })
  }
}

export async function launchVcpchat() {
  $launchProgress.set({ running: true, progress: 0.02, message: '正在启动 VCPChat' })
  try {
    await invoke('launch_vcpchat')
  } catch (error) {
    $launchProgress.set({ running: false, progress: 0, message: '' })
    throw error
  }
}

export async function openLogDirectory() {
  await invoke('open_log_directory')
}

export function returnToWelcome() {
  $route.set('welcome')
}
