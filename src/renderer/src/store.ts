import { create } from 'zustand'
import type { Annot, DialogKind, Doc, PageSize, Rect, Snapshot, Tool, ToolStyle } from './types'
import { loadPdf, PasswordRequired, type PDFDocumentProxy } from './lib/pdfjs'
import { decrypt, exportPdf, hasSignatures, needsNormalizing, stripNoteAnnots } from './lib/ops'
import type { SearchHit } from './lib/text'
import { rgb01ToHex, uid } from './lib/util'
import { NOTE_SIZE, localToUser } from './lib/geom'

export type Panel = 'thumbs' | 'outline' | 'search' | 'comments' | 'forms' | 'signatures'

export interface Toast {
  id: string
  kind: 'info' | 'success' | 'error'
  text: string
  action?: { label: string; run: () => void }
}

export type Prompt =
  | { kind: 'confirm'; title: string; message: string; ok: string; cancel?: string; alt?: string; danger?: boolean; resolve: (v: 'ok' | 'alt' | 'cancel') => void }
  | { kind: 'password'; name: string; incorrect: boolean; resolve: (v: string | null) => void }

export interface Nav {
  docId: string
  page: number
  rect?: Rect
  nonce: number
}

export interface SearchState {
  docId: string
  query: string
  hits: SearchHit[]
  index: number
  running: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

type ThemePref = 'system' | 'light' | 'dark'

interface State {
  platform: string
  version: string
  tabs: Doc[]
  active: string
  themePref: ThemePref
  tool: Tool
  style: ToolStyle
  selected: string | null
  editing: string | null
  panel: Panel | null
  dialog: { kind: DialogKind; docId?: string } | null
  busy: { label: string; progress?: number } | null
  toasts: Toast[]
  prompt: Prompt | null
  nav: Nav | null
  pendingImage: { src: string; w: number; h: number } | null
  search: SearchState
  author: string
  sigDraft: SigDraft
}

export interface SigDraft {
  idId?: string
  reason: string
  location: string
  visible: boolean
  placement?: { docId: string; page: number; rect: Rect }
  image?: string | null
  timestamp: boolean
}

const lsGet = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
export const lsSet = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

export const useStore = create<State>(() => ({
  platform: 'win32',
  version: '',
  tabs: [],
  active: 'home',
  themePref: lsGet<ThemePref>('quire.theme', 'system'),
  tool: 'select',
  style: lsGet<ToolStyle>('quire.style', { color: '#e5484d', highlight: '#ffd43b', strokeWidth: 2, opacity: 1, fontSize: 14 }),
  selected: null,
  editing: null,
  panel: lsGet<Panel | null>('quire.panel', 'thumbs'),
  dialog: null,
  busy: null,
  toasts: [],
  prompt: null,
  nav: null,
  pendingImage: null,
  search: { docId: '', query: '', hits: [], index: 0, running: false, caseSensitive: false, wholeWord: false },
  author: lsGet<string>('quire.author', ''),
  sigDraft: { reason: 'I approve this document', location: '', visible: true, timestamp: true, ...lsGet<Partial<SigDraft>>('quire.sigDraft', {}) }
}))

const set = useStore.setState
const get = useStore.getState

// ---------------------------------------------------------------------------
// UI helpers

export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']): void {
  const id = uid()
  set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500)
}

export function confirmDialog(o: { title: string; message: string; ok: string; cancel?: string; alt?: string; danger?: boolean }) {
  return new Promise<'ok' | 'alt' | 'cancel'>((resolve) =>
    set({
      prompt: {
        kind: 'confirm',
        ...o,
        resolve: (v) => {
          set({ prompt: null })
          resolve(v)
        }
      }
    })
  )
}

function askPassword(name: string, incorrect: boolean) {
  return new Promise<string | null>((resolve) =>
    set({
      prompt: {
        kind: 'password',
        name,
        incorrect,
        resolve: (v) => {
          set({ prompt: null })
          resolve(v)
        }
      }
    })
  )
}

export function setBusy(label: string | null, progress?: number): void {
  set({ busy: label ? { label, progress } : null })
}

export async function withBusy<T>(label: string, fn: (progress: (d: number, t: number, l?: string) => void) => Promise<T>): Promise<T | undefined> {
  setBusy(label)
  try {
    return await fn((d, t, l) => setBusy(l ?? label, t ? d / t : undefined))
  } catch (e) {
    console.error(e)
    toast((e as Error).message || 'Something went wrong', 'error')
    return undefined
  } finally {
    setBusy(null)
  }
}

export function setTheme(pref: ThemePref): void {
  lsSet('quire.theme', pref)
  set({ themePref: pref })
  window.quire?.setTheme(pref)
}

export function setTool(tool: Tool): void {
  set({ tool, selected: null, editing: null, pendingImage: tool === 'image' ? get().pendingImage : null })
}

export function setStyle(patch: Partial<ToolStyle>): void {
  const style = { ...get().style, ...patch }
  lsSet('quire.style', style)
  set({ style })
}

export function setPanel(panel: Panel | null): void {
  lsSet('quire.panel', panel)
  set({ panel })
}

export function openDialog(kind: DialogKind, docId?: string): void {
  set({ dialog: { kind, docId: docId ?? (get().active !== 'home' ? get().active : undefined) } })
}

export function closeDialog(): void {
  set({ dialog: null })
}

export function navigate(docId: string, page: number, rect?: Rect): void {
  set({ nav: { docId, page, rect, nonce: Date.now() + Math.random() } })
}

// ---------------------------------------------------------------------------
// Documents

export const getDoc = (id?: string): Doc | undefined => get().tabs.find((t) => t.id === (id ?? get().active))
export const activeDoc = (): Doc | undefined => getDoc(get().active)

function patchDoc(id: string, patch: Partial<Doc> | ((d: Doc) => Partial<Doc>)): void {
  set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)) }))
}

async function pageSizes(pdf: PDFDocumentProxy): Promise<PageSize[]> {
  const out: PageSize[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i)
    const vp = p.getViewport({ scale: 1 })
    out.push({ width: vp.width, height: vp.height, rotation: p.rotate })
  }
  return out
}

/** Read existing sticky notes so they become editable; the originals are stripped from the bytes. */
async function importNotes(pdf: PDFDocumentProxy, pageIds: string[]): Promise<Annot[]> {
  const notes: Annot[] = []
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1)
    const annots = await page.getAnnotations()
    for (const a of annots) {
      if (a.subtype !== 'Text') continue
      const [x0, y0, x1, y1] = a.rect as number[]
      const rot = page.rotate
      // Pick the rect corner that is the visual top-left for this rotation.
      const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
      const anchor = corners.find(([cx, cy]) => {
        const probe = { x: cx, y: cy, rot }
        const [ex, ey] = localToUser(probe, NOTE_SIZE / 2, NOTE_SIZE / 2)
        return ex >= Math.min(x0, x1) - 1 && ex <= Math.max(x0, x1) + NOTE_SIZE && ey >= Math.min(y0, y1) - NOTE_SIZE && ey <= Math.max(y0, y1) + 1
      }) ?? [x0, y1]
      const c = a.color as Uint8ClampedArray | null
      notes.push({
        id: uid(),
        kind: 'note',
        page: pageIds[i],
        x: anchor[0],
        y: anchor[1],
        rot,
        text: a.contentsObj?.str ?? a.contents ?? '',
        color: c ? rgb01ToHex(c[0] / 255, c[1] / 255, c[2] / 255) : '#ffd43b',
        opacity: 1,
        author: a.titleObj?.str,
        created: Date.now()
      })
    }
  }
  return notes
}

async function buildDoc(name: string, bytes: Uint8Array, path?: string): Promise<Doc | null> {
  let password: string | undefined
  let pdf: PDFDocumentProxy
  for (let incorrect = false; ; ) {
    try {
      pdf = await loadPdf(bytes, password)
      break
    } catch (e) {
      if (!(e instanceof PasswordRequired)) throw e
      incorrect = e.incorrect || password !== undefined
      setBusy(null)
      const pw = await askPassword(name, incorrect)
      if (pw === null) return null
      password = pw
      setBusy(`Opening ${name}…`)
    }
  }
  let base = bytes
  if (password !== undefined || (await needsNormalizing(bytes))) {
    try {
      base = await decrypt(bytes, password ?? '')
      await pdf.destroy()
      pdf = await loadPdf(base)
    } catch (e) {
      console.warn('decrypt failed', e)
      toast('This PDF is encrypted in a way Quire can display but not edit.', 'error')
    }
  }
  const pageIds = Array.from({ length: pdf.numPages }, () => uid())
  const notes = await importNotes(pdf, pageIds).catch(() => [] as Annot[])
  if (notes.length) {
    try {
      base = await stripNoteAnnots(base)
      await pdf.destroy()
      pdf = await loadPdf(base)
    } catch {
      notes.length = 0
    }
  }
  return {
    id: uid(),
    name,
    path,
    original: hasSignatures(bytes) ? bytes : undefined,
    bytes: base,
    pdf,
    pageIds,
    pageSizes: await pageSizes(pdf),
    annots: notes,
    password,
    dirty: false,
    history: [],
    future: [],
    version: 1,
    scale: 1,
    fit: 'width',
    currentPage: 0,
    view: 'read'
  }
}

export async function openBytes(name: string, bytes: Uint8Array, path?: string, opts?: { dirty?: boolean }): Promise<Doc | null> {
  if (path) {
    const existing = get().tabs.find((t) => t.path === path)
    if (existing) {
      set({ active: existing.id })
      return existing
    }
  }
  setBusy(`Opening ${name}…`)
  try {
    const doc = await buildDoc(name, bytes, path)
    if (!doc) return null
    if (opts?.dirty) doc.dirty = true
    set((s) => ({ tabs: [...s.tabs, doc], active: doc.id, selected: null, editing: null }))
    if (path) window.quire.addRecent(path)
    if (doc.original) refreshSignatures(doc.id)
    return doc
  } catch (e) {
    console.error(e)
    toast(`Couldn't open ${name}: ${(e as Error).message}`, 'error')
    return null
  } finally {
    setBusy(null)
  }
}

export async function openPaths(paths: string[]): Promise<void> {
  for (const p of paths) {
    try {
      const f = await window.quire.readFile(p)
      await openBytes(f.name, f.data, f.path)
    } catch (e) {
      toast(`Couldn't open ${p}: ${(e as Error).message}`, 'error')
    }
  }
}

export async function openWithDialog(): Promise<Doc | null> {
  const files = await window.quire.openDialog({ kind: 'pdf', multi: true })
  let last: Doc | null = null
  for (const f of files) last = await openBytes(f.name, f.data, f.path)
  return last
}

/** Ensure there's a document to run a tool on, prompting to open one if needed. */
export async function requireDoc(): Promise<Doc | null> {
  return activeDoc() ?? (await openWithDialog())
}

export async function closeTab(id: string): Promise<boolean> {
  const doc = getDoc(id)
  if (!doc) return true
  if (doc.dirty) {
    set({ active: id })
    const r = await confirmDialog({
      title: `Save changes to “${doc.name}”?`,
      message: 'Your changes will be lost if you close without saving.',
      ok: 'Save',
      alt: "Don't save",
      cancel: 'Cancel'
    })
    if (r === 'cancel') return false
    if (r === 'ok' && !(await saveDocument(id))) return false
  }
  set((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id)
    const tabs = s.tabs.filter((t) => t.id !== id)
    const active = s.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? 'home') : s.active
    return { tabs, active, selected: null, editing: null }
  })
  setTimeout(() => doc.pdf.destroy(), 1000)
  return true
}

// ---------------------------------------------------------------------------
// History

const MAX_HISTORY = 60
const snap = (d: Doc): Snapshot => ({ bytes: d.bytes, pageIds: d.pageIds, annots: d.annots })

/** Record the current state so the next change can be undone. */
export function checkpoint(id: string): void {
  patchDoc(id, (d) => ({ history: [...d.history.slice(-MAX_HISTORY + 1), snap(d)], future: [], dirty: true }))
}

async function restore(id: string, s: Snapshot, history: Snapshot[], future: Snapshot[]): Promise<void> {
  const d = getDoc(id)!
  if (s.bytes !== d.bytes) {
    const pdf = await loadPdf(s.bytes)
    const sizes = await pageSizes(pdf)
    const old = d.pdf
    patchDoc(id, { ...s, pdf, pageSizes: sizes, history, future, version: d.version + 1, dirty: true })
    setTimeout(() => old.destroy(), 2000)
  } else {
    patchDoc(id, { annots: s.annots, pageIds: s.pageIds, history, future, dirty: true })
  }
  set({ selected: null, editing: null })
}

export async function undo(id = get().active): Promise<void> {
  const d = getDoc(id)
  if (!d?.history.length) return
  const prev = d.history[d.history.length - 1]
  await restore(id, prev, d.history.slice(0, -1), [snap(d), ...d.future])
}

export async function redo(id = get().active): Promise<void> {
  const d = getDoc(id)
  if (!d?.future.length) return
  const next = d.future[0]
  await restore(id, next, [...d.history, snap(d)], d.future.slice(1))
}

// ---------------------------------------------------------------------------
// Mutations

export function addAnnot(id: string, a: Annot): void {
  checkpoint(id)
  patchDoc(id, (d) => ({ annots: [...d.annots, a] }))
}

/** Update an annotation. Pass history=false for continuous edits (dragging) after a manual checkpoint. */
export function updateAnnot(id: string, annotId: string, patch: Partial<Annot>, history = true): void {
  if (history) checkpoint(id)
  patchDoc(id, (d) => ({ annots: d.annots.map((a) => (a.id === annotId ? ({ ...a, ...patch } as Annot) : a)), dirty: true }))
}

export function replaceAnnot(id: string, annot: Annot): void {
  patchDoc(id, (d) => ({ annots: d.annots.map((a) => (a.id === annot.id ? annot : a)), dirty: true }))
}

export function deleteAnnot(id: string, annotId: string): void {
  checkpoint(id)
  patchDoc(id, (d) => ({ annots: d.annots.filter((a) => a.id !== annotId) }))
  if (get().selected === annotId) set({ selected: null, editing: null })
}

export function setDocView(id: string, patch: Partial<Pick<Doc, 'scale' | 'fit' | 'currentPage' | 'view'>>): void {
  patchDoc(id, patch)
}

/**
 * Replace the document bytes via `fn`, which may also return a new page-id order
 * (for reorders/deletes). Annotations on removed pages are dropped (undo brings them back).
 */
export async function applyBytes(
  id: string,
  label: string,
  fn: (d: Doc, progress: (done: number, total: number, label?: string) => void) => Promise<{ bytes: Uint8Array; pageIds?: string[] } | Uint8Array>,
  successText?: string
): Promise<boolean> {
  const d = getDoc(id)
  if (!d) return false
  const ok = await withBusy(label, async (progress) => {
    const res = await fn(d, progress)
    const bytes = res instanceof Uint8Array ? res : res.bytes
    const pdf = await loadPdf(bytes)
    const sizes = await pageSizes(pdf)
    const pageIds =
      !(res instanceof Uint8Array) && res.pageIds
        ? res.pageIds
        : pdf.numPages === d.pageIds.length
          ? d.pageIds
          : Array.from({ length: pdf.numPages }, (_, i) => d.pageIds[i] ?? uid())
    const live = new Set(pageIds)
    const cur = getDoc(id)!
    patchDoc(id, {
      history: [...cur.history.slice(-MAX_HISTORY + 1), snap(cur)],
      future: [],
      bytes,
      pdf,
      pageSizes: sizes,
      pageIds,
      annots: cur.annots.filter((a) => live.has(a.page)),
      version: cur.version + 1,
      dirty: true,
      currentPage: Math.min(cur.currentPage, pdf.numPages - 1)
    })
    setTimeout(() => cur.pdf.destroy(), 2000)
    return true
  })
  if (ok && successText) toast(successText, 'success')
  return !!ok
}

/** The final, flattened bytes for saving/printing/sharing. */
export async function exportBytes(id: string, opts?: { keepPassword?: boolean }): Promise<Uint8Array> {
  const d = getDoc(id)!
  return exportPdf(d.bytes, {
    pageIds: d.pageIds,
    annots: d.annots,
    password: opts?.keepPassword === false ? undefined : d.password,
    onProgress: (a, b, l) => setBusy(l ?? 'Saving…', b ? a / b : undefined)
  })
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p

export async function saveDocument(id = get().active, saveAs = false): Promise<boolean> {
  const d = getDoc(id)
  if (!d) return false
  set({ editing: null })
  if (!saveAs && !d.dirty && d.path) {
    toast('No changes to save')
    return true
  }
  if (!saveAs && d.signatures?.length) {
    const n = d.signatures.length
    const r = await confirmDialog({
      title: 'This document is digitally signed',
      message: `Saving over it will invalidate ${n === 1 ? 'its signature' : `all ${n} signatures`}. Save your changes as a new file to keep the signed original intact.`,
      ok: 'Save as copy…',
      alt: 'Save anyway',
      cancel: 'Cancel'
    })
    if (r === 'cancel') return false
    if (r === 'ok') saveAs = true
  }
  const res = await withBusy('Saving…', async () => {
    const out = await exportBytes(id)
    let path: string | null | undefined = d.path
    if (saveAs || !path) path = await window.quire.saveDialog(d.name.toLowerCase().endsWith('.pdf') ? d.name : d.name + '.pdf', out)
    else await window.quire.writeFile(path, out)
    if (!path) return false
    patchDoc(id, { path, name: fileName(path), dirty: false })
    return true
  })
  if (res) {
    const savedPath = getDoc(id)?.path
    toast('Saved', 'success', savedPath ? { label: 'Show in folder', run: () => window.quire.reveal(savedPath) } : undefined)
  }
  return !!res
}

/** Save bytes produced by a tool as a new file, then offer to open it. */
export async function saveNewFile(name: string, bytes: Uint8Array, openAfter = true): Promise<void> {
  const path = await window.quire.saveDialog(name, bytes)
  if (!path) return
  if (openAfter) {
    toast(`Saved ${fileName(path)}`, 'success', { label: 'Open', run: () => openPaths([path]) })
  } else {
    toast(`Saved ${fileName(path)}`, 'success', { label: 'Show in folder', run: () => window.quire.reveal(path) })
  }
}

export function setAuthor(name: string): void {
  lsSet('quire.author', name)
  set({ author: name })
}

export function setDocPassword(id: string, password: string | undefined): void {
  patchDoc(id, { password, dirty: true })
}

/** Bake every annotation into the page content so it can no longer be edited. */
export async function flattenAnnotations(id: string): Promise<boolean> {
  const d = getDoc(id)
  if (!d?.annots.length) return false
  const ok = await applyBytes(id, 'Flattening annotations…', async (doc, progress) =>
    exportPdf(doc.bytes, { pageIds: doc.pageIds, annots: doc.annots, onProgress: progress })
  )
  if (ok) patchDoc(id, { annots: [] })
  return ok
}

export async function refreshSignatures(id: string): Promise<void> {
  const d = getDoc(id)
  if (!d?.original) return
  try {
    const signatures = await window.quire.signing.verify(d.original)
    patchDoc(id, { signatures })
  } catch (e) {
    console.warn('signature check failed', e)
  }
}

export function setSigDraft(patch: Partial<SigDraft>): void {
  const sigDraft = { ...get().sigDraft, ...patch }
  const { idId, reason, location, visible, timestamp } = sigDraft
  lsSet('quire.sigDraft', { idId, reason, location, visible, timestamp })
  set({ sigDraft })
}

/** Close a tab without prompting (used when the file it shows was just replaced on disk). */
export function dropTab(id: string): void {
  const d = getDoc(id)
  if (!d) return
  set((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id)
    return { tabs, active: s.active === id ? (tabs[tabs.length - 1]?.id ?? 'home') : s.active }
  })
  setTimeout(() => d.pdf.destroy(), 1000)
}
