import { useEffect, useState } from 'react'
import {
  ArrowUpRight,
  BadgeCheck,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Circle,
  Eraser,
  EyeOff,
  FileDown,
  Hand,
  Highlighter,
  ImagePlus,
  LayoutGrid,
  Minus,
  MousePointer2,
  PenLine,
  Printer,
  Redo2,
  Save,
  Signature,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  Wrench,
  ZoomIn,
  ZoomOut,
  type LucideIcon
} from 'lucide-react'
import type { Doc, Tool } from '@/types'
import { navigate, openDialog, redo, saveDocument, setDocView, setTool, toast, undo, useStore } from '@/store'
import { Menu, useMenu, type MenuEntry } from './ui'
import { CATEGORIES, TOOLS } from '@/lib/catalog'
import { printDoc } from '@/lib/print'
import { bytesToDataUrl, clamp, mimeFromName, modKey } from '@/lib/util'
import { MAX_ZOOM, MIN_ZOOM } from './Viewer'

interface ToolBtn {
  tool: Tool
  icon: LucideIcon
  label: string
  key?: string
}

const GROUPS: ToolBtn[][] = [
  [
    { tool: 'select', icon: MousePointer2, label: 'Select', key: 'V' },
    { tool: 'pan', icon: Hand, label: 'Hand', key: 'H' }
  ],
  [
    { tool: 'highlight', icon: Highlighter, label: 'Highlight', key: 'K' },
    { tool: 'underline', icon: Underline, label: 'Underline', key: 'U' },
    { tool: 'strike', icon: Strikethrough, label: 'Strikethrough' }
  ],
  [
    { tool: 'ink', icon: PenLine, label: 'Draw', key: 'P' },
    { tool: 'text', icon: Type, label: 'Text', key: 'T' },
    { tool: 'note', icon: StickyNote, label: 'Sticky note', key: 'N' }
  ],
  [
    { tool: 'rect', icon: Square, label: 'Rectangle', key: 'R' },
    { tool: 'ellipse', icon: Circle, label: 'Ellipse', key: 'O' },
    { tool: 'line', icon: Minus, label: 'Line', key: 'L' },
    { tool: 'arrow', icon: ArrowUpRight, label: 'Arrow', key: 'A' }
  ],
  [{ tool: 'redact', icon: EyeOff, label: 'Redact' }, { tool: 'eraser', icon: Eraser, label: 'Eraser', key: 'E' }]
]

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  GROUPS.flat()
    .filter((t) => t.key)
    .map((t) => [t.key!.toLowerCase(), t.tool])
)

export async function pickImageForPlacement(): Promise<void> {
  const files = await window.quire.openDialog({ kind: 'image' })
  const f = files[0]
  if (!f) return
  const src = await bytesToDataUrl(f.data, mimeFromName(f.name))
  const img = new Image()
  img.src = src
  await img.decode()
  useStore.setState({ tool: 'image', selected: null, pendingImage: { src, w: img.naturalWidth * 0.75, h: img.naturalHeight * 0.75 } })
  toast('Click or drag on a page to place the image')
}

export function Toolbar({ doc }: { doc: Doc }) {
  const tool = useStore((s) => s.tool)
  const style = useStore((s) => s.style)
  const zoomMenu = useMenu()
  const toolsMenu = useMenu()
  const moreMenu = useMenu()
  const [pageText, setPageText] = useState(String(doc.currentPage + 1))
  useEffect(() => setPageText(String(doc.currentPage + 1)), [doc.currentPage])

  const n = doc.pageSizes.length
  const zoomTo = (scale: number) => setDocView(doc.id, { scale: clamp(scale, MIN_ZOOM, MAX_ZOOM), fit: 'none' })
  const reading = doc.view === 'read'

  const zoomItems: MenuEntry[] = [
    { label: 'Fit width', checked: doc.fit === 'width', onClick: () => setDocView(doc.id, { fit: 'width' }) },
    { label: 'Fit page', checked: doc.fit === 'page', onClick: () => setDocView(doc.id, { fit: 'page' }) },
    { separator: true },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((z) => ({
      label: `${Math.round(z * 100)}%`,
      checked: doc.fit === 'none' && Math.abs(doc.scale - z) < 0.001,
      onClick: () => zoomTo(z)
    }))
  ]

  const toolsItems: MenuEntry[] = CATEGORIES.flatMap((c, i) => [
    ...(i ? [{ separator: true }] : []),
    { heading: c },
    ...TOOLS.filter((t) => t.category === c).map((t) => ({ label: t.title, icon: t.icon, onClick: t.run }))
  ])

  const moreItems: MenuEntry[] = [
    { label: 'Save as…', icon: FileDown, shortcut: `${modKey}⇧S`, onClick: () => saveDocument(doc.id, true) },
    { label: 'Print…', icon: Printer, shortcut: `${modKey}P`, onClick: () => printDoc(doc.id) },
    { separator: true },
    { label: 'Document properties', onClick: () => openDialog('metadata', doc.id) },
    { label: 'Keyboard shortcuts', onClick: () => openDialog('shortcuts') },
    ...(doc.path ? [{ label: 'Show in folder', onClick: () => window.quire.reveal(doc.path!) }] : [])
  ]

  return (
    <div className="toolbar">
      <div className="group">
        <div className="segmented">
          <button className={reading ? 'on' : ''} onClick={() => setDocView(doc.id, { view: 'read' })}>
            <BookOpen size={15} /> Read
          </button>
          <button className={!reading ? 'on' : ''} onClick={() => setDocView(doc.id, { view: 'organize' })}>
            <LayoutGrid size={15} /> Pages
          </button>
        </div>
      </div>
      {reading && (
        <>
          <div className="sep" />
          <div className="group page-input">
            <button className="icon-btn sm" disabled={doc.currentPage <= 0} onClick={() => navigate(doc.id, doc.currentPage - 1)} title="Previous page">
              <ChevronUp size={17} />
            </button>
            <input
              value={pageText}
              onChange={(e) => setPageText(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  const p = clamp(parseInt(pageText) || 1, 1, n)
                  navigate(doc.id, p - 1)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              onBlur={() => setPageText(String(doc.currentPage + 1))}
            />
            <span>/ {n}</span>
            <button className="icon-btn sm" disabled={doc.currentPage >= n - 1} onClick={() => navigate(doc.id, doc.currentPage + 1)} title="Next page">
              <ChevronDown size={17} />
            </button>
          </div>
        </>
      )}

      <div className="center">
        {reading && (
          <div className="tool-pill">
            {GROUPS.map((g, gi) => (
              <div key={gi} style={{ display: 'contents' }}>
                {gi > 0 && <div className="sep" />}
                {g.map((t) => (
                  <button
                    key={t.tool}
                    className={`icon-btn ${tool === t.tool ? 'on' : ''}`}
                    title={t.key ? `${t.label} (${t.key})` : t.label}
                    onClick={() => setTool(tool === t.tool && t.tool !== 'select' ? 'select' : t.tool)}
                  >
                    <t.icon size={18} />
                    {['highlight'].includes(t.tool) && <span className="swatch-dot" style={{ background: style.highlight }} />}
                    {['ink', 'text', 'rect', 'ellipse', 'line', 'arrow', 'underline', 'strike'].includes(t.tool) && tool === t.tool && (
                      <span className="swatch-dot" style={{ background: style.color }} />
                    )}
                  </button>
                ))}
              </div>
            ))}
            <div className="sep" />
            <button className={`icon-btn ${tool === 'image' ? 'on' : ''}`} title="Insert image" onClick={pickImageForPlacement}>
              <ImagePlus size={18} />
            </button>
            <button className="icon-btn" title="Sign" onClick={() => openDialog('signature', doc.id)}>
              <Signature size={18} />
            </button>
            <button className="icon-btn" title="Digitally sign (certificate)" onClick={() => openDialog('digitalSign', doc.id)}>
              <BadgeCheck size={18} />
            </button>
          </div>
        )}
      </div>

      <div className="group">
        {reading && (
          <>
            <button className="icon-btn" onClick={() => zoomTo(doc.scale / 1.2)} title="Zoom out">
              <ZoomOut size={18} />
            </button>
            <button className="zoom-label" onClick={zoomMenu.open}>
              {Math.round(doc.scale * 100)}%
            </button>
            <button className="icon-btn" onClick={() => zoomTo(doc.scale * 1.2)} title="Zoom in">
              <ZoomIn size={18} />
            </button>
            <div className="sep" />
          </>
        )}
        <button className="icon-btn" disabled={!doc.history.length} onClick={() => undo(doc.id)} title={`Undo (${modKey}Z)`}>
          <Undo2 size={18} />
        </button>
        <button className="icon-btn" disabled={!doc.future.length} onClick={() => redo(doc.id)} title={`Redo (${modKey}⇧Z)`}>
          <Redo2 size={18} />
        </button>
        <div className="sep" />
        <button className="btn ghost" onClick={toolsMenu.open}>
          <Wrench size={16} /> Tools
        </button>
        <button className="btn ghost" style={{ padding: '0 8px' }} onClick={moreMenu.open} title="More">
          <ChevronDown size={16} />
        </button>
        <button className="btn primary" onClick={() => saveDocument(doc.id)} title={`Save (${modKey}S)`}>
          <Save size={15} /> Save
        </button>
      </div>
      {zoomMenu.anchor && <Menu anchor={zoomMenu.anchor} items={zoomItems} onClose={zoomMenu.close} />}
      {toolsMenu.anchor && <Menu anchor={toolsMenu.anchor} items={toolsItems} onClose={toolsMenu.close} align="right" />}
      {moreMenu.anchor && <Menu anchor={moreMenu.anchor} items={moreItems} onClose={moreMenu.close} align="right" />}
    </div>
  )
}
