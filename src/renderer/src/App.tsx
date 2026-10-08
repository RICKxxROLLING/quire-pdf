import { useEffect, useState } from 'react'
import { FileUp } from 'lucide-react'
import {
  activeDoc,
  checkForUpdates,
  closeDirtyTabs,
  closeTab,
  deleteAnnot,
  checkpoint,
  installUpdate,
  navigate,
  openBytes,
  openPaths,
  openWithDialog,
  redo,
  replaceAnnot,
  saveDocument,
  setDocView,
  setPanel,
  setTool,
  toast,
  undo,
  useStore
} from './store'
import { Home, Palette, TitleBar, Workspace } from './components/Shell'
import { Busy, PromptHost, Toasts } from './components/ui'
import { DialogHost, openImagesToPdfWith } from './tools/Dialogs'
import { TOOL_KEYS } from './components/Toolbar'
import { MAX_ZOOM, MIN_ZOOM } from './components/Viewer'
import { printDoc } from './lib/print'
import { translateAnnot } from './lib/geom'
import { clamp } from './lib/util'
import type { Tool } from './types'

const lastRun: Record<string, number> = {}

/** Commands can arrive from both the native menu and keydown; run each at most once per keypress. */
function command(cmd: string): void {
  const now = performance.now()
  if (now - (lastRun[cmd] ?? 0) < 300) return
  lastRun[cmd] = now
  const doc = activeDoc()
  const zoom = (f: number | null) => doc && setDocView(doc.id, { scale: f === null ? 1 : clamp(doc.scale * f, MIN_ZOOM, MAX_ZOOM), fit: 'none' })
  switch (cmd) {
    case 'open':
      return void openWithDialog()
    case 'save':
      return void (doc && saveDocument(doc.id))
    case 'saveAs':
      return void (doc && saveDocument(doc.id, true))
    case 'print':
      return void (doc && printDoc(doc.id))
    case 'closeTab':
      return void (doc && closeTab(doc.id))
    case 'undo':
      if (isTextInput(document.activeElement)) return void document.execCommand('undo')
      return void undo()
    case 'redo':
      if (isTextInput(document.activeElement)) return void document.execCommand('redo')
      return void redo()
    case 'zoomIn':
      return zoom(1.2)
    case 'zoomOut':
      return zoom(1 / 1.2)
    case 'zoomReset':
      return zoom(null)
    case 'toggleSidebar': {
      const p = useStore.getState().panel
      return setPanel(p ? null : 'thumbs')
    }
    case 'find':
      if (!doc) return
      setDocView(doc.id, { view: 'read' })
      setPanel('search')
      setTimeout(() => window.dispatchEvent(new Event('quire:focus-search')), 30)
      return
    case 'palette':
      return void window.dispatchEvent(new Event('quire:palette'))
    case 'checkUpdates':
      return void checkForUpdates()
  }
}

const isTextInput = (el: Element | null) =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable)

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.metaKey || e.ctrlKey
  const k = e.key.toLowerCase()
  const inText = isTextInput(e.target as Element)

  if (mod) {
    const map: Record<string, string> = {
      o: 'open',
      s: e.shiftKey ? 'saveAs' : 'save',
      p: 'print',
      w: 'closeTab',
      z: e.shiftKey ? 'redo' : 'undo',
      y: 'redo',
      '=': 'zoomIn',
      '+': 'zoomIn',
      '-': 'zoomOut',
      '0': 'zoomReset',
      b: 'toggleSidebar',
      f: 'find',
      k: 'palette'
    }
    if (k === 'tab') {
      e.preventDefault()
      const { tabs, active } = useStore.getState()
      const ids = ['home', ...tabs.map((t) => t.id)]
      const i = ids.indexOf(active)
      useStore.setState({ active: ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length], selected: null, editing: null })
      return
    }
    const cmd = map[k]
    if (!cmd) return
    if (inText && (cmd === 'undo' || cmd === 'redo')) {
      lastRun[cmd] = performance.now() // let the text field handle it natively
      return
    }
    e.preventDefault()
    command(cmd)
    return
  }

  if (inText || e.altKey) return
  const s = useStore.getState()
  const doc = activeDoc()
  if (!doc || doc.view !== 'read') return

  if (e.key === 'Escape') {
    if (s.editing || s.selected) useStore.setState({ selected: null, editing: null })
    else if (s.tool !== 'select') setTool('select')
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && s.selected) {
    e.preventDefault()
    deleteAnnot(doc.id, s.selected)
    return
  }
  if (s.selected && e.key.startsWith('Arrow')) {
    e.preventDefault()
    const a = doc.annots.find((x) => x.id === s.selected)
    if (!a) return
    const step = e.shiftKey ? 10 : 1
    // Nudge in visual space: convert screen direction to user space using the page rotation.
    const rot = doc.pageSizes[doc.pageIds.indexOf(a.page)]?.rotation ?? 0
    let [dx, dy] = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0] : e.key === 'ArrowUp' ? [0, step] : [0, -step]
    for (let r = 0; r < ((rot % 360) + 360) % 360; r += 90) [dx, dy] = [-dy, dx]
    checkpoint(doc.id)
    replaceAnnot(doc.id, translateAnnot(a, dx, dy))
    return
  }
  if (e.key === ' ' && !e.repeat && s.tool !== 'pan') {
    e.preventDefault()
    const prev = s.tool
    setTool('pan')
    const up = (ev: KeyboardEvent) => {
      if (ev.key !== ' ') return
      window.removeEventListener('keyup', up)
      if (useStore.getState().tool === 'pan') setTool(prev as Tool)
    }
    window.addEventListener('keyup', up)
    return
  }
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    e.preventDefault()
    navigate(doc.id, clamp(doc.currentPage + (e.key === 'PageDown' ? 1 : -1), 0, doc.pageSizes.length - 1))
    return
  }
  const t = TOOL_KEYS[k]
  if (t && !e.shiftKey) setTool(t)
}

async function handleDrop(files: File[]): Promise<void> {
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf')
  const images = files.filter((f) => f.type.startsWith('image/'))
  for (const f of pdfs) {
    const path = window.quire.pathForFile(f)
    if (path) await openPaths([path])
    else await openBytes(f.name, new Uint8Array(await f.arrayBuffer()))
  }
  if (images.length) openImagesToPdfWith(await Promise.all(images.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))))
}

export function App() {
  const active = useStore((s) => s.active)
  const themePref = useStore((s) => s.themePref)
  const [palette, setPalette] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Theme
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = themePref === 'dark' || (themePref === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    window.quire.setTheme(themePref)
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [themePref])

  // Startup, IPC, keyboard
  useEffect(() => {
    window.quire.update.get().then((update) => useStore.setState({ update }))
    window.quire.ready().then(({ platform, version, openPaths: paths }) => {
      useStore.setState({ platform, version })
      document.documentElement.dataset.platform = platform
      if (paths.length) openPaths(paths)
    })
    const offs = [
      window.quire.onOpenPaths((p) => openPaths(p)),
      window.quire.onMenu(command),
      window.quire.onCloseRequest(async () => {
        if (await closeDirtyTabs()) window.quire.confirmClose()
      }),
      window.quire.update.onState((update) => {
        if (update.status === 'ready' && useStore.getState().update.status !== 'ready')
          toast(`Quire ${update.version} is ready to install`, 'success', { label: 'Restart', run: installUpdate })
        useStore.setState({ update })
      })
    ]
    const openPalette = () => setPalette(true)
    window.addEventListener('quire:palette', openPalette)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      offs.forEach((off) => off())
      window.removeEventListener('quire:palette', openPalette)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // Drag files onto the window
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (--depth <= 0) {
        depth = 0
        setDragging(false)
      }
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      handleDrop(Array.from(e.dataTransfer!.files))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Keep the window title in sync for the taskbar / Mission Control.
  const title = useStore((s) => s.tabs.find((t) => t.id === s.active)?.name)
  useEffect(() => {
    document.title = title ? `${title} — Quire` : 'Quire'
  }, [title])

  return (
    <div className="app">
      <TitleBar />
      {active === 'home' ? <Home /> : <Workspace />}
      <DialogHost />
      <PromptHost />
      <Busy />
      <Toasts />
      {palette && <Palette onClose={() => setPalette(false)} />}
      {dragging && (
        <div className="drop-overlay">
          <div>
            <FileUp size={20} /> Drop to open PDFs · images become a new PDF
          </div>
        </div>
      )}
    </div>
  )
}
