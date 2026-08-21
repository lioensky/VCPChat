import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { atom } from 'nanostores'

export type Route = 'welcome' | 'progress' | 'success' | 'failure'
export type InstallerMode = 'install' | 'update'

export interface InstallerStatus {
  running: boolean
  completed: boolean
  version: string | null
  lastError: string | null
  currentStage: string | null
  source: SourceSnapshot
}

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
  note: string
}

export interface InstallerStage {
  name: string
  state: 'pending' | 'running' | 'succeeded' | 'skipped' | 'failed'
}

export const $route = atom<Route>('welcome')
export const $mode = atom<InstallerMode>('install')
export const $status = atom<InstallerStatus>({ running: false, completed: false, version: null, lastError: null, currentStage: null, source: { mode: 'source-missing', root: null, branch: null, commit: null, treeHash: null, dirty: false, packageLockHash: null, electronVersion: null, nodeVersion: null, npmVersion: null, note: '' } })
export const $stages = atom<InstallerStage[]>([])
export const $updateMessage = atom<string | null>(null)
export const $logs = atom<string[]>([])
export const $launchProgress = atom<{ running: boolean; progress: number; message: string }>({ running: false, progress: 0, message: '' })

type InstallerEvent =
  | { type: 'manifest'; stages: string[] }
  | { type: 'stage'; name: string; state: InstallerStage['state'] }
  | { type: 'log'; line: string }
  | { type: 'launchProgress'; progress: number; message: string }
  | { type: 'complete'; version: string }
  | { type: 'failed'; error: string }

let unlisten: UnlistenFn | null = null

export async function initialize() {
  if (!unlisten) {
    try {
      unlisten = await listen<InstallerEvent>('installer', ({ payload }) => {
        if (payload.type === 'manifest') {
          $stages.set(payload.stages.map((name) => ({ name, state: 'pending' })))
          $route.set('progress')
        } else if (payload.type === 'stage') {
          $stages.set($stages.get().map((stage) => stage.name === payload.name ? { ...stage, state: payload.state } : stage))
          $status.set({ ...$status.get(), currentStage: payload.state === 'running' ? payload.name : $status.get().currentStage })
        } else if (payload.type === 'complete') {
          $status.set({ ...$status.get(), running: false, completed: true, version: payload.version, lastError: null, currentStage: null })
          $route.set('success')
        } else if (payload.type === 'failed') {
          $status.set({ ...$status.get(), running: false, completed: false, version: null, lastError: payload.error, currentStage: null })
          $route.set('failure')
        } else if (payload.type === 'log') {
          $logs.set([...$logs.get(), payload.line].slice(-200))
        } else if (payload.type === 'launchProgress') {
          $launchProgress.set({ running: true, progress: payload.progress, message: payload.message })
        }
      })
    } catch {
      // Browser-only preview has no Tauri event bridge.
    }
  }
  try {
    $mode.set(await invoke<InstallerMode>('get_mode'))
    const status = await invoke<InstallerStatus>('get_installer_status')
    $status.set(status)
    if (status.running) {
      if (status.currentStage) $stages.set([{ name: status.currentStage, state: 'running' }])
      $route.set('progress')
    } else if (status.completed) {
      $route.set('success')
    } else if (status.lastError) {
      $route.set('failure')
    }
  } catch {
    // Browser-only preview keeps the welcome route usable without Tauri.
  }
}

export async function startInstall() {
  $stages.set([])
  $logs.set([])
  $route.set('progress')
  $status.set({ ...$status.get(), running: true, completed: false, version: null, lastError: null, currentStage: null })
  try {
    await invoke('start_installer')
  } catch (error) {
    $status.set({ ...$status.get(), running: false, completed: false, version: null, lastError: String(error), currentStage: null })
    $route.set('failure')
  }
}

export async function cancelInstall() {
  try { await invoke('cancel_installer') } catch { /* preview/no bridge */ }
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

export async function inspectUpdate() {
  try {
    const snapshot = await invoke<UpdateSnapshot>('get_update_snapshot')
    $updateMessage.set(snapshot.note)
  } catch (error) {
    $updateMessage.set(String(error))
  }
}
