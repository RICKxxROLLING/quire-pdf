import { useRef } from 'react'
import { PaintBucket, Trash2 } from 'lucide-react'
import type { Annot, Doc, Tool } from '@/types'
import { checkpoint, deleteAnnot, replaceAnnot, setStyle, useStore } from '@/store'

const INK_COLORS = ['#1c1c24', '#e5484d', '#f76707', '#f5b301', '#2f9e44', '#1c7ed6', '#7048e8', '#d6336c']
const HL_COLORS = ['#ffd43b', '#8ce99a', '#74c0fc', '#faa2c1', '#ffa94d', '#b197fc']

type Ctl = 'color' | 'stroke' | 'opacity' | 'size' | 'fill'

const TOOL_CTLS: Partial<Record<Tool, Ctl[]>> = {
  highlight: ['color'],
  underline: ['color', 'opacity'],
  strike: ['color', 'opacity'],
  ink: ['color', 'stroke', 'opacity'],
  text: ['color', 'size'],
  rect: ['color', 'stroke', 'opacity', 'fill'],
  ellipse: ['color', 'stroke', 'opacity', 'fill'],
  line: ['color', 'stroke', 'opacity'],
  arrow: ['color', 'stroke', 'opacity']
}

function annotCtls(a: Annot): Ctl[] {
  switch (a.kind) {
    case 'markup':
      return ['color', 'opacity']
    case 'ink':
    case 'line':
    case 'arrow':
      return ['color', 'stroke', 'opacity']
    case 'rect':
    case 'ellipse':
      return ['color', 'stroke', 'opacity', 'fill']
    case 'text':
      return ['color', 'size', 'opacity']
    case 'note':
      return ['color']
    case 'image':
      return ['opacity']
    default:
      return []
  }
}

export function PropertyBar({ doc }: { doc: Doc }) {
  const tool = useStore((s) => s.tool)
  const style = useStore((s) => s.style)
  const selectedId = useStore((s) => s.selected)
  const lastKey = useRef('')
  const sel = doc.annots.find((a) => a.id === selectedId)

  const ctls = sel ? annotCtls(sel) : (TOOL_CTLS[tool] ?? [])
  if (!sel && !ctls.length) return null
  if (sel && !ctls.length && sel.kind !== 'redact') return null

  const isHl = sel ? sel.kind === 'markup' && sel.style === 'highlight' : tool === 'highlight'
  const isNote = sel?.kind === 'note'
  const palette = isHl || isNote ? HL_COLORS : INK_COLORS

  const color = sel ? sel.color : isHl ? style.highlight : style.color
  const opacity = sel ? sel.opacity : style.opacity
  const stroke = sel && 'strokeWidth' in sel ? sel.strokeWidth : style.strokeWidth
  const size = sel?.kind === 'text' ? sel.size : style.fontSize
  const fill = sel && (sel.kind === 'rect' || sel.kind === 'ellipse') ? !!sel.fill : false

  /** Apply to the selected annotation (one undo step per control) and remember as the tool default. */
  const apply = (ctl: Ctl, patch: Record<string, unknown>, stylePatch: Record<string, unknown>) => {
    if (sel) {
      const key = sel.id + ctl
      if (lastKey.current !== key) {
        checkpoint(doc.id)
        lastKey.current = key
      }
      const cur = useStore.getState().tabs.find((t) => t.id === doc.id)?.annots.find((a) => a.id === sel.id)
      if (cur) replaceAnnot(doc.id, { ...cur, ...patch } as Annot)
    }
    setStyle(stylePatch)
  }

  const setColor = (c: string) => {
    const fillPatch = sel && (sel.kind === 'rect' || sel.kind === 'ellipse') && sel.fill ? { fill: c } : {}
    apply('color', { color: c, ...fillPatch }, isHl ? { highlight: c } : isNote ? {} : { color: c })
  }

  return (
    <div className="propbar" onPointerDown={(e) => e.stopPropagation()}>
      {ctls.includes('color') && (
        <div className="swatches">
          {palette.map((c) => (
            <button key={c} className={`swatch ${color.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} title={c} />
          ))}
          <label className="swatch custom" title="Custom color">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
      )}
      {ctls.includes('fill') && (
        <button
          className={`icon-btn sm ${fill ? 'on' : ''}`}
          title="Fill shape"
          onClick={() => sel && apply('fill', { fill: fill ? undefined : sel.color }, {})}
          disabled={!sel}
        >
          <PaintBucket size={15} />
        </button>
      )}
      {ctls.includes('stroke') && (
        <>
          <div className="sep" />
          <label className="slider">
            Width
            <input type="range" min={0.5} max={16} step={0.5} value={stroke} onChange={(e) => apply('stroke', { strokeWidth: +e.target.value }, { strokeWidth: +e.target.value })} />
            <span className="v">{stroke}pt</span>
          </label>
        </>
      )}
      {ctls.includes('size') && (
        <>
          <div className="sep" />
          <label className="slider">
            Size
            <input type="range" min={6} max={72} step={1} value={size} onChange={(e) => apply('size', { size: +e.target.value }, { fontSize: +e.target.value })} />
            <span className="v">{size}pt</span>
          </label>
        </>
      )}
      {ctls.includes('opacity') && (
        <>
          <div className="sep" />
          <label className="slider">
            Opacity
            <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => apply('opacity', { opacity: +e.target.value }, isHl ? {} : { opacity: +e.target.value })} />
            <span className="v">{Math.round(opacity * 100)}%</span>
          </label>
        </>
      )}
      {sel?.kind === 'redact' && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Content under this box is permanently removed on save</span>}
      {sel && (
        <>
          <div className="sep" />
          <button className="icon-btn sm" title="Delete (Del)" onClick={() => deleteAnnot(doc.id, sel.id)}>
            <Trash2 size={15} />
          </button>
        </>
      )}
    </div>
  )
}
