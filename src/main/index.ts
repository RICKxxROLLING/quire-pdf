import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { promises as fs, existsSync, unlinkSync, writeFileSync } from 'fs'
import { basename, join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { createId, importId, listIds, removeId, signPdf, verifySignatures } from './signing'
import { initUpdater } from './updater'
import { log } from './log'

const isMac = process.platform === 'darwin'
const RECENT_FILE = () => join(app.getPath('userData'), 'recent.json')
const MAX_RECENT = 15

// A launch whose window never painted (typically a GPU driver problem) leaves LAUNCH_PENDING behind. The
// next launch then renders in software, and once that works NO_GPU keeps it that way.
const LAUNCH_PENDING = () => join(app.getPath('userData'), 'launch-pending')
const NO_GPU = () => join(app.getPath('userData'), 'disable-gpu')
const recoveringFromHiddenLaunch = existsSync(LAUNCH_PENDING())
if (recoveringFromHiddenLaunch || existsSync(NO_GPU())) app.disableHardwareAcceleration()

// The packaged UI is served from app://quire/ so workers, wasm and fetch() behave like a normal origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

function registerAppProtocol(): void {
  const root = normalize(join(__dirname, '../renderer'))
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url)
    const target = normalize(join(root, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)))
    if (target !== root && !target.startsWith(root + sep)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(target).toString())
  })
}

let win: BrowserWindow | null = null
let forceClose = false
const pendingOpen: string[] = []

const overlayColors = (dark: boolean) =>
  dark ? { color: '#00000000', symbolColor: '#e6e6ea', height: 44 } : { color: '#00000000', symbolColor: '#2b2b33', height: 44 }

function pdfArgs(argv: string[]): string[] {
  return argv.filter((a) => /\.pdf$/i.test(a) && existsSync(a))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161a' : '#f6f6f8',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 14 },
    ...(isMac ? {} : { titleBarOverlay: overlayColors(nativeTheme.shouldUseDarkColors) }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: process.env.QUIRE_DEBUG ? ['--quire-debug'] : []
    }
  })

  const shown = Date.now()
  win.once('ready-to-show', () => {
    log(`window ready after ${Date.now() - shown}ms`)
    win?.show()
    try {
      unlinkSync(LAUNCH_PENDING())
      if (recoveringFromHiddenLaunch) writeFileSync(NO_GPU(), 'Previous launch never showed its window; rendering in software.\n')
    } catch (e) {
      log('launch marker', e)
    }
  })
  // Never leave the app running invisibly: if the page hasn't painted by now, show the window anyway.
  setTimeout(() => {
    if (win && !win.isVisible()) {
      log('window not ready after 8s; showing it anyway')
      win.show()
    }
  }, 8000)
  win.webContents.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url))
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone', d))
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) log('renderer error:', message, `${source}:${line}`)
  })

  win.on('close', (e) => {
    if (forceClose || !win) return
    e.preventDefault()
    win.webContents.send('app:close-request')
  })
  win.on('closed', () => {
    win = null
  })

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !url.startsWith('http://localhost')) e.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadURL('app://quire/index.html')
  }
}

function sendOpen(paths: string[]): void {
  if (!paths.length) return
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('app:open-paths', paths)
    if (win.isMinimized()) win.restore()
    win.focus()
  } else {
    pendingOpen.push(...paths)
  }
}

async function readRecent(): Promise<string[]> {
  try {
    const list = JSON.parse(await fs.readFile(RECENT_FILE(), 'utf8'))
    return Array.isArray(list) ? list.filter((p: unknown) => typeof p === 'string') : []
  } catch {
    return []
  }
}

async function addRecent(path: string): Promise<void> {
  const list = (await readRecent()).filter((p) => p !== path)
  list.unshift(path)
  await fs.writeFile(RECENT_FILE(), JSON.stringify(list.slice(0, MAX_RECENT)))
  app.addRecentDocument(path)
}

async function readFileEntry(path: string) {
  const data = await fs.readFile(path)
  const stat = await fs.stat(path)
  return { path, name: basename(path), data: new Uint8Array(data), size: stat.size, modified: stat.mtimeMs }
}

function menuSend(cmd: string) {
  return () => win?.webContents.send('app:menu', cmd)
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: menuSend('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuSend('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: menuSend('saveAs') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: menuSend('print') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuSend('closeTab') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: menuSend('undo') },
        { label: 'Redo', accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y', click: menuSend('redo') },
        { type: 'separator' },
        // Native clipboard roles are only needed on macOS; Windows inputs handle these on their own.
        ...(isMac
          ? ([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' }] as Electron.MenuItemConstructorOptions[])
          : []),
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: menuSend('find') },
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: menuSend('palette') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: menuSend('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: menuSend('zoomOut') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: menuSend('zoomReset') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: menuSend('toggleSidebar') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }])
      ]
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Check for Updates…', click: menuSend('checkUpdates') }] }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- single instance / file association --------------------------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    // Launching Quire again should always bring the existing window forward.
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    sendOpen(pdfArgs(argv))
  })
  app.on('child-process-gone', (_e, d) => log('child-process-gone', d))
  app.on('open-file', (e, path) => {
    e.preventDefault()
    sendOpen([path])
  })
  pendingOpen.push(...pdfArgs(process.argv.slice(1)))

  app.whenReady().then(() => {
    log(`Quire ${app.getVersion()} starting on ${process.platform} ${process.arch} ${process.getSystemVersion()}`,
      recoveringFromHiddenLaunch ? '(previous launch never showed; GPU disabled)' : existsSync(NO_GPU()) ? '(GPU disabled)' : '')
    try {
      writeFileSync(LAUNCH_PENDING(), new Date().toISOString())
    } catch (e) {
      log('launch marker', e)
    }
    registerAppProtocol()
    buildMenu()
    createWindow()
    initUpdater(() => {
      forceClose = true
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })
}

// ---- IPC ----------------------------------------------------------------
const PDF_FILTER = { name: 'PDF Documents', extensions: ['pdf'] }
const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }

ipcMain.handle('app:ready', () => {
  const paths = pendingOpen.splice(0)
  return { platform: process.platform, version: app.getVersion(), openPaths: paths }
})

ipcMain.handle('app:confirm-close', () => {
  forceClose = true
  win?.close()
})

ipcMain.handle('app:set-theme', (_e, theme: 'light' | 'dark' | 'system') => {
  nativeTheme.themeSource = theme
  if (!isMac && win) win.setTitleBarOverlay(overlayColors(nativeTheme.shouldUseDarkColors))
  return nativeTheme.shouldUseDarkColors
})

ipcMain.handle('dialog:open', async (_e, opts: { kind?: 'pdf' | 'image' | 'any'; multi?: boolean }) => {
  if (!win) return []
  const filters =
    opts?.kind === 'image' ? [IMAGE_FILTER] : opts?.kind === 'any' ? [PDF_FILTER, IMAGE_FILTER] : [PDF_FILTER]
  const res = await dialog.showOpenDialog(win, {
    properties: opts?.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters
  })
  if (res.canceled) return []
  return Promise.all(res.filePaths.map(readFileEntry))
})

ipcMain.handle('fs:read', async (_e, path: string) => readFileEntry(path))

ipcMain.handle(
  'dialog:save',
  async (_e, opts: { defaultName: string; data: Uint8Array; ext?: string }) => {
    if (!win) return null
    const ext = opts.ext ?? 'pdf'
    const res = await dialog.showSaveDialog(win, {
      defaultPath: opts.defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (res.canceled || !res.filePath) return null
    await fs.writeFile(res.filePath, opts.data)
    if (ext === 'pdf') await addRecent(res.filePath)
    return res.filePath
  }
)

ipcMain.handle('fs:write', async (_e, path: string, data: Uint8Array) => {
  await fs.writeFile(path, data)
  if (/\.pdf$/i.test(path)) await addRecent(path)
  return path
})

ipcMain.handle('dialog:save-many', async (_e, files: { name: string; data: Uint8Array }[]) => {
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a folder to save into',
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || !res.filePaths[0]) return null
  const dir = res.filePaths[0]
  for (const f of files) await fs.writeFile(join(dir, f.name), f.data)
  return dir
})

ipcMain.handle('recent:get', async () => {
  const list = await readRecent()
  const out: { path: string; name: string; modified: number; size: number }[] = []
  for (const p of list) {
    try {
      const s = await fs.stat(p)
      out.push({ path: p, name: basename(p), modified: s.mtimeMs, size: s.size })
    } catch {
      /* file moved or deleted */
    }
  }
  return out
})
ipcMain.handle('recent:add', (_e, path: string) => addRecent(path))
ipcMain.handle('recent:clear', async () => {
  await fs.writeFile(RECENT_FILE(), '[]')
  app.clearRecentDocuments()
})

ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
ipcMain.handle('shell:open-external', (_e, url: string) => {
  if (/^https?:/.test(url)) shell.openExternal(url)
})

// ---- Digital signatures ---------------------------------------------------
ipcMain.handle('sign:list-ids', () => listIds())
ipcMain.handle('sign:create-id', (_e, o: { name: string; email?: string; org?: string; password: string }) => createId(o))
ipcMain.handle('sign:pick-id-file', async () => {
  if (!win) return null
  const res = await dialog.showOpenDialog(win, {
    title: 'Import a digital ID',
    properties: ['openFile'],
    filters: [{ name: 'Digital IDs', extensions: ['p12', 'pfx'] }]
  })
  return res.canceled ? null : res.filePaths[0]
})
ipcMain.handle('sign:import-id', (_e, path: string, password: string) => importId(path, password))
ipcMain.handle('sign:remove-id', (_e, id: string) => removeId(id))
ipcMain.handle('sign:export-id', async (_e, id: string) => {
  const d = (await listIds()).find((x) => x.id === id)
  if (!d || !win) return null
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${d.name.replace(/[\/:*?"<>|]+/g, '_')}.p12`,
    filters: [{ name: 'Digital ID', extensions: ['p12'] }]
  })
  if (res.canceled || !res.filePath) return null
  await fs.copyFile(d.file, res.filePath)
  return res.filePath
})
ipcMain.handle('sign:sign', (_e, o: { pdf: Uint8Array; idId: string; password: string; timestamp: boolean }) => signPdf(o))
ipcMain.handle('sign:verify', (_e, pdf: Uint8Array) => verifySignatures(pdf))
