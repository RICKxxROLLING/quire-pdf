import { useEffect, useState } from 'react'
import { Copy, GripVertical, Keyboard, Plus, Trash2 } from 'lucide-react'
import type { Doc } from '@/types'
import {
  applyBytes,
  closeDialog,
  exportBytes,
  flattenAnnotations,
  openBytes,
  saveNewFile,
  setDocPassword,
  toast,
  useStore,
  withBusy
} from '@/store'
import { toolById } from '@/lib/catalog'
import { Check, Field, Modal, OptionCards, Progress } from '@/components/ui'
import { Thumb } from '@/components/Thumb'
import {
  COMPRESS_PRESETS,
  addHeaderFooter,
  addTextLayer,
  addWatermark,
  compressPdf,
  cropPages,
  extractPages,
  flattenForm,
  getMetadata,
  imagesToPdf,
  mergePdfs,
  setMetadata,
  encrypt,
  type HeaderFooterOptions,
  type Metadata
} from '@/lib/ops'
import { canvasToBytes, loadPdf, renderPageToCanvas } from '@/lib/pdfjs'
import { extractAllText } from '@/lib/text'
import { OCR_LANGS, runOcr } from '@/lib/ocr'
import { baseName, formatBytes, mimeFromName, modKey, parseRangeGroups, parseRanges } from '@/lib/util'
import { SignatureDialog } from './Signature'
import { DigitalSignDialog } from './DigitalSign'

export function DialogHost() {
  const dialog = useStore((s) => s.dialog)
  const doc = useStore((s) => (s.dialog?.docId ? s.tabs.find((t) => t.id === s.dialog!.docId) : undefined))
  if (!dialog) return null
  const k = dialog.kind
  if (k === 'merge') return <MergeDialog />
  if (k === 'imagesToPdf') return <ImagesToPdfDialog />
  if (k === 'shortcuts') return <ShortcutsDialog />
  if (k === 'about') return <ShortcutsDialog />
  if (!doc) return null
  switch (k) {
    case 'split':
      return <SplitDialog doc={doc} />
    case 'compress':
      return <CompressDialog doc={doc} />
    case 'pdfToImages':
      return <PdfToImagesDialog doc={doc} />
    case 'extractText':
      return <ExtractTextDialog doc={doc} />
    case 'watermark':
      return <WatermarkDialog doc={doc} />
    case 'headerFooter':
      return <HeaderFooterDialog doc={doc} />
    case 'protect':
      return <ProtectDialog doc={doc} />
    case 'unlock':
      return <UnlockDialog doc={doc} />
    case 'metadata':
      return <MetadataDialog doc={doc} />
    case 'ocr':
      return <OcrDialog doc={doc} />
    case 'crop':
      return <CropDialog doc={doc} />
    case 'flatten':
      return <FlattenDialog doc={doc} />
    case 'signature':
      return <SignatureDialog />
    case 'digitalSign':
      return <DigitalSignDialog doc={doc} />
    default:
      return null
  }
}

const meta = (id: string) => {
  const t = toolById(id)!
  return { title: t.title, icon: t.icon, color: t.color }
}

// ---------------------------------------------------------------------------
// Page selection

type PageMode = 'all' | 'current' | 'custom'

function usePages(doc: Doc, initial: PageMode = 'all') {
  const [mode, setMode] = useState<PageMode>(initial)
  const [text, setText] = useState('')
  const n = doc.pageSizes.length
  let pages: number[] = []
  let error: string | null = null
  try {
    pages = mode === 'all' ? Array.from({ length: n }, (_, i) => i) : mode === 'current' ? [doc.currentPage] : parseRanges(text, n)
    if (mode === 'custom' && !text.trim()) error = 'Enter pages, e.g. 1-3, 7'
  } catch (e) {
    error = (e as Error).message
  }
  const ui = (
    <Field label="Pages" hint={mode === 'custom' ? (error ?? `${pages.length} page${pages.length === 1 ? '' : 's'} selected`) : undefined}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div className="segmented">
          <button className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>
            All ({n})
          </button>
          <button className={mode === 'current' ? 'on' : ''} onClick={() => setMode('current')}>
            Current ({doc.currentPage + 1})
          </button>
          <button className={mode === 'custom' ? 'on' : ''} onClick={() => setMode('custom')}>
            Custom
          </button>
        </div>
        {mode === 'custom' && <input className="input" autoFocus placeholder="1-3, 5, 8-" value={text} onChange={(e) => setText(e.target.value)} />}
      </div>
    </Field>
  )
  return { pages, error, ui }
}

const Cancel = () => (
  <button className="btn" onClick={closeDialog}>
    Cancel
  </button>
)

// ---------------------------------------------------------------------------
// Merge

interface MergeItem {
  id: string
  name: string
  pages?: number
  size: number
  load: () => Promise<Uint8Array>
}

function MergeDialog() {
  const tabs = useStore((s) => s.tabs)
  const [items, setItems] = useState<MergeItem[]>(() =>
    tabs.map((t) => ({ id: t.id, name: t.name, pages: t.pageSizes.length, size: t.bytes.length, load: () => exportBytes(t.id, { keepPassword: false }) }))
  )
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)

  const add = async () => {
    const files = await window.quire.openDialog({ kind: 'pdf', multi: true })
    const added: MergeItem[] = []
    for (const f of files) {
      let pages: number | undefined
      try {
        const p = await loadPdf(f.data)
        pages = p.numPages
        p.destroy()
      } catch {
        toast(`${f.name} is password-protected — open and unlock it first.`, 'error')
        continue
      }
      added.push({ id: f.path, name: f.name, pages, size: f.size, load: async () => f.data })
    }
    setItems((s) => [...s, ...added])
  }

  const run = async () => {
    const out = await withBusy('Merging…', async (progress) => {
      const all: Uint8Array[] = []
      for (const it of items) all.push(await it.load())
      return mergePdfs(all, progress)
    })
    if (!out) return
    closeDialog()
    await openBytes('Merged document.pdf', out, undefined, { dirty: true })
    toast(`Merged ${items.length} files — remember to save`, 'success')
  }

  const total = items.reduce((s, i) => s + (i.pages ?? 0), 0)
  return (
    <Modal
      {...meta('merge')}
      subtitle="Drag to set the order. The result opens as a new tab."
      onClose={closeDialog}
      footerLeft={items.length ? `${items.length} files · ${total} pages` : undefined}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={items.length < 2} onClick={run}>
            Merge {items.length > 1 ? `${items.length} files` : ''}
          </button>
        </>
      }
    >
      {items.length > 0 && (
        <div className="file-list">
          {items.map((it, i) => (
            <div
              key={it.id + i}
              className={`file-row ${overIdx === i && dragIdx !== i ? 'drag-over' : ''}`}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => {
                e.preventDefault()
                setOverIdx(i)
              }}
              onDragEnd={() => {
                setDragIdx(null)
                setOverIdx(null)
              }}
              onDrop={() => {
                if (dragIdx === null) return
                const next = [...items]
                const [m] = next.splice(dragIdx, 1)
                next.splice(i, 0, m)
                setItems(next)
              }}
            >
              <GripVertical size={15} className="grip" />
              <div className="nm">{it.name}</div>
              <div className="meta">
                {it.pages ?? '?'} pp · {formatBytes(it.size)}
              </div>
              <button className="icon-btn sm" onClick={() => setItems(items.filter((_, k) => k !== i))} title="Remove">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="btn" onClick={add} style={{ alignSelf: 'flex-start' }}>
        <Plus size={15} /> Add PDFs
      </button>
      {items.length < 2 && <div className="note">Add at least two files. Documents already open in tabs are included automatically, with their annotations.</div>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Split

function SplitDialog({ doc }: { doc: Doc }) {
  const n = doc.pageSizes.length
  const [mode, setMode] = useState<'every' | 'ranges' | 'each'>('every')
  const [every, setEvery] = useState(Math.max(1, Math.ceil(n / 2)))
  const [ranges, setRanges] = useState('')
  let groups: number[][] = []
  let error: string | null = null
  try {
    if (mode === 'each') groups = Array.from({ length: n }, (_, i) => [i])
    else if (mode === 'every') {
      const k = Math.max(1, every | 0)
      for (let i = 0; i < n; i += k) groups.push(Array.from({ length: Math.min(k, n - i) }, (_, j) => i + j))
    } else {
      groups = parseRangeGroups(ranges, n)
      if (!groups.length) error = 'Enter ranges like 1-3, 4-8, 9-'
    }
  } catch (e) {
    error = (e as Error).message
  }

  const run = async () => {
    const files = await withBusy('Splitting…', async (progress) => {
      const baked = await exportBytes(doc.id, { keepPassword: false })
      const out: { name: string; data: Uint8Array }[] = []
      for (let i = 0; i < groups.length; i++) {
        progress(i, groups.length)
        const g = groups[i]
        const label = g.length === 1 ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`
        out.push({ name: `${baseName(doc.name)}_${label}.pdf`, data: await extractPages(baked, g) })
      }
      return out
    })
    if (!files) return
    const dir = await window.quire.saveMany(files)
    if (dir) {
      closeDialog()
      toast(`Saved ${files.length} files`, 'success', { label: 'Show folder', run: () => window.quire.reveal(dir + '/' + files[0].name) })
    }
  }

  return (
    <Modal
      {...meta('split')}
      subtitle={`${doc.name} · ${n} pages`}
      onClose={closeDialog}
      footerLeft={!error && groups.length ? `Creates ${groups.length} file${groups.length === 1 ? '' : 's'}` : undefined}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!!error || groups.length < 1} onClick={run}>
            Split & save…
          </button>
        </>
      }
    >
      <OptionCards
        value={mode}
        onChange={setMode}
        options={[
          { value: 'every', title: 'Every N pages', desc: 'Equal-sized chunks' },
          { value: 'ranges', title: 'Custom ranges', desc: 'e.g. 1-3, 4-10' },
          { value: 'each', title: 'Every page', desc: 'One file per page' }
        ]}
      />
      {mode === 'every' && (
        <Field label="Pages per file">
          <input className="input" type="number" min={1} max={n} value={every} onChange={(e) => setEvery(+e.target.value)} style={{ width: 120 }} />
        </Field>
      )}
      {mode === 'ranges' && (
        <Field label="Ranges (comma-separated, each becomes a file)" hint={error ?? undefined}>
          <input className="input" autoFocus placeholder="1-3, 4-8, 9-" value={ranges} onChange={(e) => setRanges(e.target.value)} />
        </Field>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Compress

function CompressDialog({ doc }: { doc: Doc }) {
  const [preset, setPreset] = useState<keyof typeof COMPRESS_PRESETS>('balanced')
  const [result, setResult] = useState<{ before: number; after: number; bytes: Uint8Array; images: number; recompressed: number } | null>(null)

  const run = async () => {
    const r = await withBusy('Compressing…', async (progress) => {
      const baked = await exportBytes(doc.id, { keepPassword: false })
      const out = await compressPdf(baked, COMPRESS_PRESETS[preset], progress)
      return { before: baked.length, after: Math.min(out.bytes.length, baked.length), bytes: out.bytes.length < baked.length ? out.bytes : baked, images: out.images, recompressed: out.recompressed }
    })
    if (r) setResult(r)
  }

  const saved = result ? 1 - result.after / result.before : 0
  return (
    <Modal
      {...meta('compress')}
      subtitle={`${doc.name} · ${formatBytes(doc.bytes.length)}`}
      onClose={closeDialog}
      footer={
        result ? (
          <>
            <button className="btn" onClick={() => setResult(null)}>
              Try another level
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                await saveNewFile(`${baseName(doc.name)} (compressed).pdf`, result.bytes)
                closeDialog()
              }}
            >
              Save compressed copy…
            </button>
          </>
        ) : (
          <>
            <Cancel />
            <button className="btn primary" onClick={run}>
              Compress
            </button>
          </>
        )
      }
    >
      {!result ? (
        <>
          <OptionCards
            value={preset}
            onChange={setPreset}
            options={[
              { value: 'light', title: 'Light', desc: 'Best quality, modest savings' },
              { value: 'balanced', title: 'Balanced', desc: 'Great for email and sharing' },
              { value: 'strong', title: 'Strong', desc: 'Smallest file, lower image quality' }
            ]}
          />
          <div className="note">Images are downsampled and re-encoded. Text and vector graphics stay sharp and selectable.</div>
        </>
      ) : (
        <>
          <div className="result-stat">
            <div>
              <div className="k">Before</div>
              <div className="v">{formatBytes(result.before)}</div>
            </div>
            <div>
              <div className="k">After</div>
              <div className="v">{formatBytes(result.after)}</div>
            </div>
            <div>
              <div className="k">Saved</div>
              <div className="v" style={{ color: saved > 0.01 ? 'var(--success)' : undefined }}>
                {Math.max(0, Math.round(saved * 100))}%
              </div>
            </div>
          </div>
          <div className="note">
            {result.recompressed
              ? `Optimized ${result.recompressed} of ${result.images} images.`
              : result.images
                ? 'The images in this file are already well compressed.'
                : 'This file has no raster images to optimize; it was re-saved with compact object streams.'}
          </div>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Images → PDF

function ImagesToPdfDialog() {
  const [files, setFiles] = useState<{ name: string; data: Uint8Array; url: string }[]>([])
  const [pageSize, setPageSize] = useState<'fit' | 'a4' | 'letter'>('a4')
  const [orientation, setOrientation] = useState<'auto' | 'portrait' | 'landscape'>('auto')
  const [margin, setMargin] = useState(24)
  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.url)), [])

  const add = async () => {
    const picked = await window.quire.openDialog({ kind: 'image', multi: true })
    setFiles((s) => [...s, ...picked.map((f) => ({ name: f.name, data: f.data, url: URL.createObjectURL(new Blob([f.data], { type: mimeFromName(f.name) })) }))])
  }
  useEffect(() => {
    const pending = (window as unknown as { __quireDroppedImages?: { name: string; data: Uint8Array }[] }).__quireDroppedImages
    if (pending?.length) {
      setFiles(pending.map((f) => ({ ...f, url: URL.createObjectURL(new Blob([f.data], { type: mimeFromName(f.name) })) })))
      ;(window as unknown as { __quireDroppedImages?: unknown }).__quireDroppedImages = undefined
    }
  }, [])

  const run = async () => {
    const out = await withBusy('Creating PDF…', (progress) =>
      imagesToPdf(files.map((f) => ({ bytes: f.data, mime: mimeFromName(f.name) })), { pageSize, orientation, margin: pageSize === 'fit' ? 0 : margin }, progress)
    )
    if (!out) return
    closeDialog()
    await openBytes(files.length === 1 ? baseName(files[0].name.replace(/\.[^.]+$/, '')) + '.pdf' : 'Images.pdf', out, undefined, { dirty: true })
  }

  const move = (i: number, d: number) => {
    const next = [...files]
    const [m] = next.splice(i, 1)
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, m)
    setFiles(next)
  }

  return (
    <Modal
      {...meta('imagesToPdf')}
      subtitle="Each image becomes a page, in this order."
      wide
      onClose={closeDialog}
      footerLeft={files.length ? `${files.length} image${files.length === 1 ? '' : 's'}` : undefined}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!files.length} onClick={run}>
            Create PDF
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 }}>
        {files.map((f, i) => (
          <div key={f.url} style={{ position: 'relative', borderRadius: 10, border: '1px solid var(--border)', padding: 6, background: 'var(--surface-2)' }}>
            <img src={f.url} style={{ width: '100%', height: 100, objectFit: 'contain', display: 'block' }} />
            <div style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4 }}>
              {i + 1}. {f.name}
            </div>
            <div style={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <button className="icon-btn sm" onClick={() => move(i, -1)} disabled={i === 0} title="Move earlier">
                ‹
              </button>
              <button className="icon-btn sm" onClick={() => setFiles(files.filter((_, k) => k !== i))} title="Remove">
                <Trash2 size={13} />
              </button>
              <button className="icon-btn sm" onClick={() => move(i, 1)} disabled={i === files.length - 1} title="Move later">
                ›
              </button>
            </div>
          </div>
        ))}
        <button className="option-card" style={{ alignItems: 'center', justifyContent: 'center', minHeight: 150, color: 'var(--muted)' }} onClick={add}>
          <Plus size={22} />
          Add images
        </button>
      </div>
      <div className="row">
        <Field label="Page size">
          <select className="input" value={pageSize} onChange={(e) => setPageSize(e.target.value as typeof pageSize)}>
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
            <option value="fit">Fit to image</option>
          </select>
        </Field>
        <Field label="Orientation">
          <select className="input" disabled={pageSize === 'fit'} value={orientation} onChange={(e) => setOrientation(e.target.value as typeof orientation)}>
            <option value="auto">Automatic</option>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
        <Field label="Margin (pt)">
          <input className="input" type="number" min={0} max={144} disabled={pageSize === 'fit'} value={margin} onChange={(e) => setMargin(+e.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// PDF → images

function PdfToImagesDialog({ doc }: { doc: Doc }) {
  const [format, setFormat] = useState<'png' | 'jpg'>('png')
  const [dpi, setDpi] = useState(150)
  const { pages, error, ui } = usePages(doc)

  const run = async () => {
    const files = await withBusy('Rendering pages…', async (progress) => {
      const pdf = await loadPdf(await exportBytes(doc.id, { keepPassword: false }))
      const out: { name: string; data: Uint8Array }[] = []
      for (let k = 0; k < pages.length; k++) {
        progress(k, pages.length, `Rendering page ${pages[k] + 1}`)
        const canvas = await renderPageToCanvas(await pdf.getPage(pages[k] + 1), dpi / 72, undefined, 'print')
        out.push({
          name: `${baseName(doc.name)}-${String(pages[k] + 1).padStart(String(doc.pageSizes.length).length, '0')}.${format}`,
          data: await canvasToBytes(canvas, format === 'png' ? 'image/png' : 'image/jpeg', 0.9)
        })
      }
      pdf.destroy()
      return out
    })
    if (!files) return
    if (files.length === 1) {
      const p = await window.quire.saveDialog(files[0].name, files[0].data, format)
      if (p) toast('Image saved', 'success', { label: 'Show', run: () => window.quire.reveal(p) })
    } else {
      const dir = await window.quire.saveMany(files)
      if (dir) toast(`Saved ${files.length} images`, 'success', { label: 'Show folder', run: () => window.quire.reveal(dir + '/' + files[0].name) })
    }
    closeDialog()
  }

  const s = doc.pageSizes[0]
  return (
    <Modal
      {...meta('pdfToImages')}
      subtitle={doc.name}
      onClose={closeDialog}
      footerLeft={s ? `≈ ${Math.round((s.width * dpi) / 72)} × ${Math.round((s.height * dpi) / 72)} px per page` : undefined}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!!error || !pages.length} onClick={run}>
            Export {pages.length} image{pages.length === 1 ? '' : 's'}…
          </button>
        </>
      }
    >
      <OptionCards
        value={format}
        onChange={setFormat}
        options={[
          { value: 'png', title: 'PNG', desc: 'Lossless, crisp text' },
          { value: 'jpg', title: 'JPG', desc: 'Smaller, best for photos' }
        ]}
      />
      <Field label="Resolution">
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          {[72, 150, 300, 600].map((d) => (
            <button key={d} className={dpi === d ? 'on' : ''} onClick={() => setDpi(d)}>
              {d} dpi
            </button>
          ))}
        </div>
      </Field>
      {ui}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Extract text

function ExtractTextDialog({ doc }: { doc: Doc }) {
  const [text, setText] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    let alive = true
    extractAllText(doc.pdf, (d, t) => alive && setProgress(d / t)).then((t) => alive && setText(t))
    return () => {
      alive = false
    }
  }, [doc.pdf])
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0
  return (
    <Modal
      {...meta('extractText')}
      subtitle={doc.name}
      wide
      onClose={closeDialog}
      footerLeft={text !== null ? `${words.toLocaleString()} words · ${text.length.toLocaleString()} characters` : undefined}
      footer={
        <>
          <button
            className="btn"
            disabled={!text}
            onClick={() => {
              navigator.clipboard.writeText(text!)
              toast('Copied to clipboard', 'success')
            }}
          >
            <Copy size={14} /> Copy
          </button>
          <button
            className="btn primary"
            disabled={!text}
            onClick={async () => {
              const p = await window.quire.saveDialog(baseName(doc.name) + '.txt', new TextEncoder().encode(text!.replace(/\f/g, '')), 'txt')
              if (p) {
                toast('Text saved', 'success', { label: 'Show', run: () => window.quire.reveal(p) })
                closeDialog()
              }
            }}
          >
            Save .txt…
          </button>
        </>
      }
    >
      {text === null ? (
        <Progress value={progress} />
      ) : text.trim() ? (
        <div className="pre" style={{ maxHeight: 380 }}>
          {text.replace(/\f/g, '\n──────────\n')}
        </div>
      ) : (
        <div className="note warn">No text found. This looks like a scanned document — run OCR first to make its text extractable.</div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Watermark

function WatermarkDialog({ doc }: { doc: Doc }) {
  const [text, setText] = useState('CONFIDENTIAL')
  const [size, setSize] = useState(64)
  const [color, setColor] = useState('#e5484d')
  const [opacity, setOpacity] = useState(0.2)
  const [angle, setAngle] = useState(45)
  const [layout, setLayout] = useState<'center' | 'tile'>('center')
  const [bold, setBold] = useState(true)
  const { pages, error, ui } = usePages(doc)

  const ps = doc.pageSizes[doc.currentPage]
  const pw = 200
  const k = pw / ps.width
  const run = async () => {
    const ok = await applyBytes(doc.id, 'Adding watermark…', (d) => addWatermark(d.bytes, { text, size, color, opacity, angle, layout, bold, pages }), 'Watermark added')
    if (ok) closeDialog()
  }
  return (
    <Modal
      {...meta('watermark')}
      wide
      onClose={closeDialog}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!text.trim() || !!error || !pages.length} onClick={run}>
            Apply watermark
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Field label="Text">
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row">
            <Field label={`Size · ${size}pt`}>
              <input type="range" min={12} max={160} value={size} onChange={(e) => setSize(+e.target.value)} style={{ accentColor: 'var(--accent)' }} />
            </Field>
            <Field label={`Angle · ${angle}°`}>
              <input type="range" min={-90} max={90} value={angle} onChange={(e) => setAngle(+e.target.value)} style={{ accentColor: 'var(--accent)' }} />
            </Field>
          </div>
          <div className="row">
            <Field label={`Opacity · ${Math.round(opacity * 100)}%`}>
              <input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(+e.target.value)} style={{ accentColor: 'var(--accent)' }} />
            </Field>
            <Field label="Color">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 36, height: 30, border: 0, background: 'none', padding: 0 }} />
                <Check checked={bold} onChange={setBold}>
                  Bold
                </Check>
              </div>
            </Field>
          </div>
          <Field label="Layout">
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              <button className={layout === 'center' ? 'on' : ''} onClick={() => setLayout('center')}>
                Centered
              </button>
              <button className={layout === 'tile' ? 'on' : ''} onClick={() => setLayout('tile')}>
                Tiled
              </button>
            </div>
          </Field>
          {ui}
        </div>
        <div className="preview-page" style={{ width: pw, height: ps.height * k, flex: 'none' }}>
          <Thumb pdf={doc.pdf} index={doc.currentPage} width={pw} height={ps.height * k} />
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
            {(layout === 'center' ? [0] : Array.from({ length: 16 }, (_, i) => i)).map((i) => (
              <div
                key={i}
                style={{
                  position: layout === 'center' ? 'static' : 'absolute',
                  left: layout === 'tile' ? `${(i % 4) * 33 - 15 + (Math.floor(i / 4) % 2) * 16}%` : undefined,
                  top: layout === 'tile' ? `${Math.floor(i / 4) * 28 - 4}%` : undefined,
                  transform: `rotate(${-angle}deg)`,
                  fontSize: size * k,
                  fontWeight: bold ? 700 : 400,
                  color,
                  opacity,
                  whiteSpace: 'nowrap',
                  fontFamily: 'Helvetica, Arial, sans-serif'
                }}
              >
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Header / footer / page numbers

type Slot = keyof HeaderFooterOptions['slots']
const PRESETS: { label: string; slots: HeaderFooterOptions['slots'] }[] = [
  { label: '1', slots: { bc: '{page}' } },
  { label: 'Page 1 of 9', slots: { bc: 'Page {page} of {total}' } },
  { label: '1 (bottom right)', slots: { br: '{page}' } },
  { label: 'Name + page', slots: { bl: '{name}', br: '{page} / {total}' } },
  { label: 'Header date', slots: { tr: '{date}', bc: '{page}' } }
]

function HeaderFooterDialog({ doc }: { doc: Doc }) {
  const [slots, setSlots] = useState<HeaderFooterOptions['slots']>({ bc: 'Page {page} of {total}' })
  const [size, setSize] = useState(10)
  const [margin, setMargin] = useState(28)
  const [startAt, setStartAt] = useState(1)
  const [color, setColor] = useState('#333333')
  const { pages, error, ui } = usePages(doc)
  const slot = (s: Slot, ph: string) => (
    <input className="input" placeholder={ph} value={slots[s] ?? ''} onChange={(e) => setSlots({ ...slots, [s]: e.target.value })} />
  )
  const run = async () => {
    const ok = await applyBytes(
      doc.id,
      'Adding page numbers…',
      (d) => addHeaderFooter(d.bytes, { slots, size, margin, startAt, color, pages, name: baseName(doc.name) }),
      'Header & footer added'
    )
    if (ok) closeDialog()
  }
  return (
    <Modal
      {...meta('headerFooter')}
      title="Page numbers, headers & footers"
      wide
      onClose={closeDialog}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!!error || !pages.length || !Object.values(slots).some((v) => v?.trim())} onClick={run}>
            Apply
          </button>
        </>
      }
    >
      <Field label="Quick presets">
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.label} className="chip" onClick={() => setSlots(p.slots)}>
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Header" hint={<>Tokens: <code>{'{page}'}</code> <code>{'{total}'}</code> <code>{'{date}'}</code> <code>{'{name}'}</code></>}>
        <div className="position-grid">
          {slot('tl', 'Left')}
          {slot('tc', 'Center')}
          {slot('tr', 'Right')}
        </div>
      </Field>
      <Field label="Footer">
        <div className="position-grid">
          {slot('bl', 'Left')}
          {slot('bc', 'Center')}
          {slot('br', 'Right')}
        </div>
      </Field>
      <div className="row">
        <Field label="Font size">
          <input className="input" type="number" min={5} max={48} value={size} onChange={(e) => setSize(+e.target.value)} />
        </Field>
        <Field label="Margin (pt)">
          <input className="input" type="number" min={0} max={200} value={margin} onChange={(e) => setMargin(+e.target.value)} />
        </Field>
        <Field label="Start numbering at">
          <input className="input" type="number" min={0} value={startAt} onChange={(e) => setStartAt(+e.target.value)} />
        </Field>
        <Field label="Color">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: '100%', height: 32, border: 0, background: 'none', padding: 0 }} />
        </Field>
      </div>
      {ui}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Protect / unlock

function ProtectDialog({ doc }: { doc: Doc }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [owner, setOwner] = useState('')
  const [perm, setPerm] = useState({ printing: true, copying: false, modifying: false, annotating: false, fillingForms: true, documentAssembly: false })
  const mismatch = pw2.length > 0 && pw !== pw2
  const strength = pw.length >= 12 && /\d/.test(pw) && /[^a-z0-9]/i.test(pw) ? 'Strong' : pw.length >= 8 ? 'Okay' : pw ? 'Weak' : ''
  const run = async () => {
    const out = await withBusy('Encrypting…', async () =>
      encrypt(await exportBytes(doc.id, { keepPassword: false }), { userPassword: pw, ownerPassword: owner || undefined, permissions: perm })
    )
    if (!out) return
    await saveNewFile(`${baseName(doc.name)} (protected).pdf`, out, false)
    closeDialog()
  }
  const P = (k: keyof typeof perm, label: string) => (
    <Check checked={perm[k]} onChange={(v) => setPerm({ ...perm, [k]: v })}>
      {label}
    </Check>
  )
  return (
    <Modal
      {...meta('protect')}
      subtitle="AES-256 encryption. Anyone opening the file will need the password."
      onClose={closeDialog}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!pw || pw !== pw2} onClick={run}>
            Save protected copy…
          </button>
        </>
      }
    >
      <div className="row">
        <Field label="Password" hint={strength && `Strength: ${strength}`}>
          <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm password" hint={mismatch ? "Passwords don't match" : undefined}>
          <input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} style={mismatch ? { borderColor: 'var(--danger)' } : undefined} />
        </Field>
      </div>
      <Field label="Permissions password (optional)" hint="Lets you change restrictions later. Without it, the open password grants full access.">
        <input className="input" type="password" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </Field>
      <Field label="Allow people with the open password to…">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {P('printing', 'Print')}
          {P('copying', 'Copy text & images')}
          {P('modifying', 'Edit content')}
          {P('annotating', 'Add comments')}
          {P('fillingForms', 'Fill forms')}
          {P('documentAssembly', 'Insert, rotate, delete pages')}
        </div>
      </Field>
    </Modal>
  )
}

function UnlockDialog({ doc }: { doc: Doc }) {
  const locked = !!doc.password
  return (
    <Modal
      {...meta('unlock')}
      subtitle={doc.name}
      onClose={closeDialog}
      footer={
        locked ? (
          <>
            <Cancel />
            <button
              className="btn primary"
              onClick={async () => {
                const out = await withBusy('Removing password…', () => exportBytes(doc.id, { keepPassword: false }))
                if (!out) return
                await saveNewFile(`${baseName(doc.name)} (unlocked).pdf`, out, false)
                setDocPassword(doc.id, undefined)
                closeDialog()
              }}
            >
              Save unlocked copy…
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={closeDialog}>
            OK
          </button>
        )
      }
    >
      {locked ? (
        <div style={{ lineHeight: 1.5, color: 'var(--text-2)' }}>
          You opened this document with its password. Quire will save a copy with the password and all restrictions removed. Future saves of this tab will also be unprotected.
        </div>
      ) : (
        <div className="note">This document isn't password-protected. To open a locked PDF, just open it — Quire will ask for the password.</div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Metadata

function MetadataDialog({ doc }: { doc: Doc }) {
  const [m, setM] = useState<Metadata | null>(null)
  useEffect(() => {
    getMetadata(doc.bytes).then(setM, (e) => toast(e.message, 'error'))
  }, [doc.version])
  if (!m) return null
  const f = (k: keyof Metadata, label: string, multiline = false) => (
    <Field label={label}>
      {multiline ? (
        <textarea className="input" rows={2} value={m[k] ?? ''} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
      ) : (
        <input className="input" value={m[k] ?? ''} onChange={(e) => setM({ ...m, [k]: e.target.value })} />
      )}
    </Field>
  )
  const s = doc.pageSizes[0]
  return (
    <Modal
      {...meta('metadata')}
      title="Document properties"
      subtitle={doc.path ?? doc.name}
      onClose={closeDialog}
      footerLeft={`${doc.pageSizes.length} pages · ${s ? `${Math.round(s.width)} × ${Math.round(s.height)} pt` : ''} · ${formatBytes(doc.bytes.length)}${doc.password ? ' · encrypted' : ''}`}
      footer={
        <>
          <Cancel />
          <button
            className="btn primary"
            onClick={async () => {
              if (await applyBytes(doc.id, 'Updating properties…', (d) => setMetadata(d.bytes, m), 'Properties updated')) closeDialog()
            }}
          >
            Save properties
          </button>
        </>
      }
    >
      {f('title', 'Title')}
      <div className="row">
        {f('author', 'Author')}
        {f('subject', 'Subject')}
      </div>
      {f('keywords', 'Keywords (comma-separated)')}
      <div className="row">
        {f('creator', 'Creator application')}
        {f('producer', 'PDF producer')}
      </div>
      <div className="row" style={{ color: 'var(--muted)', fontSize: 12 }}>
        <div>Created: {m.created ?? '—'}</div>
        <div>Modified: {m.modified ?? '—'}</div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// OCR

function OcrDialog({ doc }: { doc: Doc }) {
  const [lang, setLang] = useState('eng')
  const [dpi, setDpi] = useState(300)
  const [state, setState] = useState<{ p: number; label: string } | null>(null)
  const [done, setDone] = useState<{ text: string; confidence: number; pages: number } | null>(null)
  const [signal] = useState({ cancelled: false })
  const { pages, error, ui } = usePages(doc)
  useEffect(() => () => void (signal.cancelled = true), [])

  const run = async () => {
    setState({ p: 0, label: 'Starting…' })
    try {
      const res = await runOcr(doc.pdf, pages, lang, dpi, (p, label) => setState({ p, label }), signal)
      if (signal.cancelled) return
      await applyBytes(doc.id, 'Adding text layer…', (d) => addTextLayer(d.bytes, res.pages))
      setDone({ text: res.text, confidence: res.confidence, pages: res.pages.size })
    } catch (e) {
      console.error(e)
      toast(`OCR failed: ${(e as Error).message ?? e}. The first run needs an internet connection to download language data.`, 'error')
    } finally {
      setState(null)
    }
  }

  return (
    <Modal
      {...meta('ocr')}
      title="Recognize text (OCR)"
      subtitle="Makes scanned pages searchable and selectable."
      onClose={() => {
        signal.cancelled = true
        closeDialog()
      }}
      wide={!!done}
      footer={
        done ? (
          <>
            <button
              className="btn"
              onClick={() => {
                navigator.clipboard.writeText(done.text)
                toast('Copied to clipboard', 'success')
              }}
            >
              <Copy size={14} /> Copy text
            </button>
            <button className="btn primary" onClick={closeDialog}>
              Done
            </button>
          </>
        ) : (
          <>
            <Cancel />
            <button className="btn primary" disabled={!!state || !!error || !pages.length} onClick={run}>
              Recognize {pages.length} page{pages.length === 1 ? '' : 's'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <>
          <div className="result-stat">
            <div>
              <div className="k">Pages processed</div>
              <div className="v">{done.pages}</div>
            </div>
            <div>
              <div className="k">Average confidence</div>
              <div className="v">{Math.round(done.confidence)}%</div>
            </div>
          </div>
          <div className="note">An invisible text layer was added. You can now search, select and copy text. Save to keep it.</div>
          <div className="pre">{done.text.replace(/\f/g, '\n──────────\n') || '(no text recognized)'}</div>
        </>
      ) : state ? (
        <>
          <div>{state.label}</div>
          <Progress value={state.p} />
        </>
      ) : (
        <>
          <div className="row">
            <Field label="Document language">
              <select className="input" value={lang} onChange={(e) => setLang(e.target.value)}>
                {OCR_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Accuracy">
              <select className="input" value={dpi} onChange={(e) => setDpi(+e.target.value)}>
                <option value={200}>Fast (200 dpi)</option>
                <option value={300}>Accurate (300 dpi)</option>
                <option value={400}>Best (400 dpi)</option>
              </select>
            </Field>
          </div>
          {ui}
          <div className="note">Recognition runs entirely on your computer. The first time you use a language, its data (~10–20 MB) is downloaded once and cached.</div>
        </>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Crop

function CropDialog({ doc }: { doc: Doc }) {
  const [m, setM] = useState({ top: 36, right: 36, bottom: 36, left: 36 })
  const [linked, setLinked] = useState(true)
  const { pages, error, ui } = usePages(doc)
  const ps = doc.pageSizes[doc.currentPage]
  const pw = 220
  const k = pw / ps.width
  const set = (side: keyof typeof m, v: number) => setM(linked ? { top: v, right: v, bottom: v, left: v } : { ...m, [side]: v })
  const run = async () => {
    if (await applyBytes(doc.id, 'Cropping…', (d) => cropPages(d.bytes, pages, m), 'Pages cropped')) closeDialog()
  }
  const input = (side: keyof typeof m) => (
    <Field label={side[0].toUpperCase() + side.slice(1)}>
      <input className="input" type="number" min={0} value={m[side]} onChange={(e) => set(side, Math.max(0, +e.target.value))} />
    </Field>
  )
  return (
    <Modal
      {...meta('crop')}
      subtitle="Margins are in points (72 pt = 1 inch)."
      wide
      onClose={closeDialog}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!!error || !pages.length} onClick={run}>
            Crop {pages.length} page{pages.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 20 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="row">
            {input('top')}
            {input('bottom')}
          </div>
          <div className="row">
            {input('left')}
            {input('right')}
          </div>
          <Check checked={linked} onChange={setLinked}>
            Same margin on all sides
          </Check>
          {ui}
        </div>
        <div className="preview-page" style={{ width: pw, height: ps.height * k, flex: 'none' }}>
          <Thumb pdf={doc.pdf} index={doc.currentPage} width={pw} height={ps.height * k} />
          <div
            style={{
              position: 'absolute',
              left: m.left * k,
              top: m.top * k,
              right: m.right * k,
              bottom: m.bottom * k,
              outline: '2px solid var(--accent)',
              boxShadow: '0 0 0 9999px rgba(20,20,40,.45)'
            }}
          />
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Flatten

function FlattenDialog({ doc }: { doc: Doc }) {
  const [forms, setForms] = useState(true)
  const [annots, setAnnots] = useState(doc.annots.length > 0)
  const run = async () => {
    if (annots) await flattenAnnotations(doc.id)
    if (forms) await applyBytes(doc.id, 'Flattening forms…', (d) => flattenForm(d.bytes))
    toast('Flattened', 'success')
    closeDialog()
  }
  return (
    <Modal
      {...meta('flatten')}
      subtitle="Make content permanent so it can't be changed."
      onClose={closeDialog}
      footer={
        <>
          <Cancel />
          <button className="btn primary" disabled={!forms && !annots} onClick={run}>
            Flatten
          </button>
        </>
      }
    >
      <Check checked={forms} onChange={setForms}>
        Form fields — values become regular page content
      </Check>
      <Check checked={annots} onChange={setAnnots}>
        Annotations ({doc.annots.length}) — highlights, drawings, text and signatures can no longer be edited
      </Check>
      {doc.annots.some((a) => a.kind === 'redact') && annots && <div className="note warn">Redactions will be applied now, permanently removing the covered content.</div>}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Shortcuts

function ShortcutsDialog() {
  const version = useStore((s) => s.version)
  const rows: [string, string][] = [
    ['Open', `${modKey} O`],
    ['Save / Save as', `${modKey} S / ${modKey} ⇧ S`],
    ['Print', `${modKey} P`],
    ['Close tab', `${modKey} W`],
    ['Next / previous tab', `${modKey} Tab / ${modKey} ⇧ Tab`],
    ['Command palette', `${modKey} K`],
    ['Find in document', `${modKey} F`],
    ['Undo / redo', `${modKey} Z / ${modKey} ⇧ Z`],
    ['Zoom in / out / reset', `${modKey} + / ${modKey} − / ${modKey} 0`],
    ['Toggle sidebar', `${modKey} B`],
    ['Select · Hand', 'V · H (hold Space to pan)'],
    ['Highlight · Underline', 'K · U'],
    ['Draw · Text · Note', 'P · T · N'],
    ['Rectangle · Ellipse · Line · Arrow', 'R · O · L · A'],
    ['Eraser', 'E'],
    ['Delete selected annotation', 'Delete'],
    ['Nudge selection', 'Arrow keys (⇧ for 10pt)']
  ]
  return (
    <Modal title="Keyboard shortcuts" subtitle={version ? `Quire ${version}` : undefined} icon={Keyboard} onClose={closeDialog}>
      <div className="shortcut-grid">
        {rows.map(([a, b]) => (
          <div key={a} style={{ display: 'contents' }}>
            <span>{a}</span>
            <span className="kbd" style={{ justifySelf: 'end' }}>
              {b}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// Re-exported so the drop handler can route images here.
export function openImagesToPdfWith(files: { name: string; data: Uint8Array }[]): void {
  ;(window as unknown as { __quireDroppedImages?: unknown }).__quireDroppedImages = files
  useStore.setState({ dialog: { kind: 'imagesToPdf' } })
}

