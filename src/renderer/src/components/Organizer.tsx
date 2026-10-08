import { useEffect, useRef, useState } from 'react'
import { ArrowDownUp, Copy, FileDown, FilePlus, FileStack, ImagePlus, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import type { Doc } from '@/types'
import { applyBytes, exportBytes, navigate, saveNewFile, setDocView, toast, withBusy } from '@/store'
import { extractPages, imagesToPdf, insertBlankPage, insertPdf, reorderPages, rotatePages } from '@/lib/ops'
import { baseName, mimeFromName, uid } from '@/lib/util'
import { Thumb } from './Thumb'

export function Organizer({ doc }: { doc: Doc }) {
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [size, setSize] = useState(150)
  const [dragging, setDragging] = useState<number[] | null>(null)
  const [drop, setDrop] = useState<{ index: number; side: 'before' | 'after' } | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const n = doc.pageSizes.length

  useEffect(() => {
    setSel((s) => new Set([...s].filter((i) => i < n)))
  }, [n])

  const selected = [...sel].sort((a, b) => a - b)
  const targets = selected.length ? selected : []

  const click = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)]
      setSel(new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k)))
    } else if (e.metaKey || e.ctrlKey) {
      const s = new Set(sel)
      s.has(i) ? s.delete(i) : s.add(i)
      setSel(s)
      setAnchor(i)
    } else {
      setSel(new Set([i]))
      setAnchor(i)
    }
  }

  const rotate = (idx: number[], delta: number) =>
    idx.length && applyBytes(doc.id, 'Rotating…', (d) => rotatePages(d.bytes, idx, delta))

  const remove = async (idx: number[]) => {
    if (!idx.length) return
    if (idx.length >= n) return toast("A PDF needs at least one page — you can't delete them all.", 'error')
    const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !idx.includes(i))
    const ok = await applyBytes(doc.id, 'Deleting pages…', async (d) => ({ bytes: await reorderPages(d.bytes, keep), pageIds: keep.map((i) => d.pageIds[i]) }))
    if (ok) {
      setSel(new Set())
      toast(`Deleted ${idx.length} page${idx.length > 1 ? 's' : ''}`, 'info')
    }
  }

  const duplicate = (idx: number[]) => {
    if (!idx.length) return
    const order: number[] = []
    for (let i = 0; i < n; i++) {
      order.push(i)
      if (idx.includes(i)) order.push(i)
    }
    const seen = new Set<number>()
    applyBytes(doc.id, 'Duplicating…', async (d) => ({
      bytes: await reorderPages(d.bytes, order),
      pageIds: order.map((i) => (seen.has(i) ? uid() : (seen.add(i), d.pageIds[i])))
    }))
  }

  const reorder = (order: number[]) =>
    applyBytes(doc.id, 'Reordering…', async (d) => ({ bytes: await reorderPages(d.bytes, order), pageIds: order.map((i) => d.pageIds[i]) }))

  const insertAt = () => (selected.length ? selected[selected.length - 1] + 1 : n)

  const insertBlank = () => {
    const at = insertAt()
    applyBytes(doc.id, 'Inserting page…', async (d) => {
      const ids = [...d.pageIds]
      ids.splice(at, 0, uid())
      return { bytes: await insertBlankPage(d.bytes, at), pageIds: ids }
    })
  }

  const insertFiles = async (kind: 'pdf' | 'image') => {
    const files = await window.quire.openDialog({ kind, multi: true })
    if (!files.length) return
    const at = insertAt()
    await applyBytes(doc.id, 'Inserting…', async (d, progress) => {
      let bytes = d.bytes
      const ids = [...d.pageIds]
      let pos = at
      const sources =
        kind === 'image' ? [await imagesToPdf(files.map((f) => ({ bytes: f.data, mime: mimeFromName(f.name) })), { pageSize: 'a4', orientation: 'auto', margin: 24 }, progress)] : files.map((f) => f.data)
      for (const src of sources) {
        const r = await insertPdf(bytes, src, pos)
        bytes = r.bytes
        ids.splice(pos, 0, ...Array.from({ length: r.count }, () => uid()))
        pos += r.count
      }
      return { bytes, pageIds: ids }
    }, 'Pages inserted')
  }

  const extract = async (idx: number[]) => {
    if (!idx.length) return
    const out = await withBusy('Extracting pages…', async () => extractPages(await exportBytes(doc.id, { keepPassword: false }), idx))
    if (out) await saveNewFile(`${baseName(doc.name)} (pages ${compactRange(idx)}).pdf`, out)
  }

  const reverse = () => {
    const idx = targets.length > 1 ? targets : Array.from({ length: n }, (_, i) => i)
    const order = Array.from({ length: n }, (_, i) => i)
    const rev = [...idx].reverse()
    idx.forEach((pos, k) => (order[pos] = rev[k]))
    reorder(order)
  }

  // ---- drag & drop ----
  const onDragStart = (i: number, e: React.DragEvent) => {
    const group = sel.has(i) ? selected : [i]
    if (!sel.has(i)) setSel(new Set([i]))
    setDragging(group)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/x-quire-pages', group.join(','))
  }
  const onDragOver = (i: number, e: React.DragEvent) => {
    if (!dragging) return
    e.preventDefault()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const side = e.clientX < r.left + r.width / 2 ? 'before' : 'after'
    if (drop?.index !== i || drop.side !== side) setDrop({ index: i, side })
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    if (!dragging || !drop) return end()
    const target = drop.side === 'before' ? drop.index : drop.index + 1
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !dragging.includes(i))
    const insertPos = rest.filter((i) => i < target).length
    const order = [...rest.slice(0, insertPos), ...dragging, ...rest.slice(insertPos)]
    end()
    if (order.some((v, i) => v !== i)) {
      reorder(order).then((ok) => ok && setSel(new Set(dragging.map((_, k) => insertPos + k))))
    }
  }
  const end = () => {
    setDragging(null)
    setDrop(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.length) {
      e.preventDefault()
      remove(selected)
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      e.stopPropagation()
      setSel(new Set(Array.from({ length: n }, (_, i) => i)))
    } else if (e.key === 'Escape') setSel(new Set())
  }

  const box = size
  return (
    <div className="organizer" tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
      <div className="org-bar">
        <span className="count">{selected.length ? `${selected.length} of ${n} selected` : `${n} pages`}</span>
        <button className="btn sm" disabled={!selected.length} onClick={() => rotate(selected, -90)} title="Rotate left">
          <RotateCcw size={14} />
        </button>
        <button className="btn sm" disabled={!selected.length} onClick={() => rotate(selected, 90)} title="Rotate right">
          <RotateCw size={14} />
        </button>
        <button className="btn sm" disabled={!selected.length} onClick={() => duplicate(selected)}>
          <Copy size={14} /> Duplicate
        </button>
        <button className="btn sm" disabled={!selected.length} onClick={() => extract(selected)}>
          <FileDown size={14} /> Extract
        </button>
        <button className="btn sm" disabled={!selected.length} onClick={() => remove(selected)} style={selected.length ? { color: 'var(--danger)' } : undefined}>
          <Trash2 size={14} /> Delete
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
        <button className="btn sm" onClick={insertBlank}>
          <FilePlus size={14} /> Blank page
        </button>
        <button className="btn sm" onClick={() => insertFiles('pdf')}>
          <FileStack size={14} /> Insert PDF
        </button>
        <button className="btn sm" onClick={() => insertFiles('image')}>
          <ImagePlus size={14} /> Insert images
        </button>
        <button className="btn sm" onClick={reverse} title="Reverse the order of the selected pages (or all pages)">
          <ArrowDownUp size={14} /> Reverse
        </button>
        <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
        <label className="slider" title="Thumbnail size">
          <input type="range" min={90} max={300} value={size} onChange={(e) => setSize(+e.target.value)} />
        </label>
      </div>
      <div
        ref={gridRef}
        className="org-grid"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${box + 20}px, 1fr))` }}
        onClick={(e) => e.target === e.currentTarget && setSel(new Set())}
        onDragOver={(e) => dragging && e.preventDefault()}
        onDrop={onDrop}
      >
        {doc.pageSizes.map((s, i) => {
          const w = s.width >= s.height ? box : (box * s.width) / s.height
          const h = (w * s.height) / s.width
          return (
            <div
              key={doc.pageIds[i]}
              className={`org-card ${sel.has(i) ? 'sel' : ''} ${dragging?.includes(i) ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => onDragStart(i, e)}
              onDragOver={(e) => onDragOver(i, e)}
              onDragEnd={end}
              onClick={(e) => click(i, e)}
              onDoubleClick={() => {
                setDocView(doc.id, { view: 'read' })
                setTimeout(() => navigate(doc.id, i), 50)
              }}
            >
              <div className="frame" style={{ width: box, height: box, background: 'transparent', boxShadow: 'none' }}>
                <div style={{ boxShadow: 'var(--page-shadow)', borderRadius: 3, overflow: 'hidden' }}>
                  <Thumb pdf={doc.pdf} index={i} width={w} height={h} />
                </div>
              </div>
              <span className="num">{i + 1}</span>
              <div className="hover-actions" onClick={(e) => e.stopPropagation()}>
                <button title="Rotate left" onClick={() => rotate([i], -90)}>
                  <RotateCcw size={13} />
                </button>
                <button title="Rotate right" onClick={() => rotate([i], 90)}>
                  <RotateCw size={13} />
                </button>
                <button title="Delete" onClick={() => remove([i])}>
                  <Trash2 size={13} />
                </button>
              </div>
              {drop?.index === i && <div className={`drop-marker ${drop.side}`} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function compactRange(idx: number[]): string {
  const parts: string[] = []
  let start = idx[0]
  let prev = idx[0]
  for (const i of [...idx.slice(1), NaN]) {
    if (i === prev + 1) {
      prev = i
      continue
    }
    parts.push(start === prev ? `${start + 1}` : `${start + 1}-${prev + 1}`)
    start = prev = i
  }
  return parts.join(',')
}
