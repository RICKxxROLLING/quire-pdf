/**
 * In-app updates from GitHub Releases (electron-updater reads latest.yml / latest-mac.yml from the
 * newest release). The Windows installer build downloads updates in the background and applies them on
 * restart. The portable .exe and the unsigned macOS build can't replace themselves (Squirrel.Mac only
 * accepts signed apps), so they only announce the new version and link to the release page.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

export type UpdateState =
  | { status: 'idle' | 'checking' | 'none' }
  | { status: 'available'; version: string; canInstall: boolean }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }

const RELEASES_URL = 'https://github.com/RICKxxROLLING/quire-pdf/releases/latest'
const CHECK_EVERY = 4 * 60 * 60 * 1000
const canInstall = process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR

let state: UpdateState = { status: 'idle' }
let pending: Promise<UpdateState> | null = null

function setState(s: UpdateState): UpdateState {
  state = s
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', s)
  return s
}

async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return { status: 'error', message: 'Updates are only available in installed builds.' }
  // Nothing new to learn while an update is downloading or waiting for a restart.
  if (state.status === 'downloading' || state.status === 'ready') return state
  pending ??= autoUpdater
    .checkForUpdates()
    .then(() => state)
    .catch((e: Error) => setState({ status: 'error', message: e.message || String(e) }))
    .finally(() => (pending = null))
  return pending
}

/** `beforeInstall` runs right before the app quits to install, so window close guards can stand down. */
export function initUpdater(beforeInstall: () => void): void {
  ipcMain.handle('update:get', () => state)
  ipcMain.handle('update:check', () => check())
  ipcMain.handle('update:open-page', () => shell.openExternal(RELEASES_URL))
  ipcMain.handle('update:install', () => {
    if (state.status !== 'ready') return
    beforeInstall()
    autoUpdater.quitAndInstall(true, true)
  })

  if (!app.isPackaged) return
  autoUpdater.autoDownload = canInstall
  autoUpdater.autoInstallOnAppQuit = canInstall
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }))
  autoUpdater.on('update-not-available', () => setState({ status: 'none' }))
  autoUpdater.on('update-available', (info) => setState({ status: 'available', version: info.version, canInstall }))
  autoUpdater.on('download-progress', (p) => {
    if (state.status === 'available' || state.status === 'downloading')
      setState({ status: 'downloading', version: state.version, percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => setState({ status: 'ready', version: info.version }))
  autoUpdater.on('error', (e) => {
    // A failed download leaves the previous state stale; surface it so the UI stops showing progress.
    if (state.status !== 'ready') setState({ status: 'error', message: e?.message || String(e) })
  })

  setTimeout(check, 10_000)
  setInterval(check, CHECK_EVERY)
}
