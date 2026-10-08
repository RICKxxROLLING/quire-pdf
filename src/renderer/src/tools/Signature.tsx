import { useEffect, useRef, useState } from 'react'
import { Eraser, Signature as SigIcon, Upload, X } from 'lucide-react'
import { closeDialog, lsSet, toast, useStore } from '@/store'
import { Check, Modal } from '@/components/ui'
import { bytesToDataUrl, mimeFromName } from '@/lib/util'

const KEY = 'quire.signatures'
const FONTS = [
  { name: 'Script', css: "'Segoe Script', 'Snell Roundhand', 'Brush Script MT', cursive" },
  { name: 'Handwriting', css: "'Lucida Handwriting', 'Bradley Hand', 'Apple Chancery', cursive" },
  { name: 'Brush', css: "'Brush Script MT', 'Brush Script Std', 'Savoye LET', cursive" },
  { name: 'Ink Free', css: "'Ink Free', 'Chalkboard SE', 'Comic Sans MS', cursive" }
]
const INKS = ['#111827', '#1d4ed8', '#b91c1c']

function loadSaved(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}

/** Crop a canvas to its non-transparent content with some padding. */
function trimCanvas(src: HTMLCanvasElement, pad = 12): HTMLCanvasElement | null {
  const ctx = src.getContext('2d')!
  const { width: w, height: h } = src
  const data = ctx.getImageData(0, 0, w, h).data
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return null
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1 + pad * 2
  out.height = y1 - y0 + 1 + pad * 2
  out.getContext('2d')!.drawImage(src, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1)
  return out
}

export function SignatureDialog() {
  const [tab, setTab] = useState<'draw' | 'type' | 'upload'>('draw')
  const [saved, setSaved] = useState<string[]>(loadSaved)
  const [remember, setRemember] = useState(true)
  const [ink, setInk] = useState(INKS[0])
  const [typed, setTyped] = useState('')
  const [font, setFont] = useState(FONTS[0].css)
  const [upload, setUpload] = useState<string | null>(null)
  const [knockout, setKnockout] = useState(true)
  const [hasInk, setHasInk] = useState(false)
  const pad = useRef<HTMLCanvasElement>(null)
  const stroke = useRef<{ pts: { x: number; y: number; t: number }[]; w: number } | null>(null)

  useEffect(() => {
    if (tab !== 'draw') return
    const c = pad.current!
    const r = c.getBoundingClientRect()
    c.width = r.width * 2
    c.height = r.height * 2
    setHasInk(false)
  }, [tab])

  const pos = (e: React.PointerEvent) => {
    const r = pad.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) * 2, y: (e.clientY - r.top) * 2, t: e.timeStamp }
  }
  const down = (e: React.PointerEvent) => {
    pad.current!.setPointerCapture(e.pointerId)
    stroke.current = { pts: [pos(e)], w: 5 }
  }
  const move = (e: React.PointerEvent) => {
    const s = stroke.current
    if (!s) return
    const p = pos(e)
    const last = s.pts[s.pts.length - 1]
    const dist = Math.hypot(p.x - last.x, p.y - last.y)
    if (dist < 2) return
    // Faster strokes draw thinner lines, like a real pen.
    const speed = dist / Math.max(1, p.t - last.t)
    const target = Math.max(2.2, Math.min(7, 7.5 - speed * 2.2))
    const w = s.w + (target - s.w) * 0.35
    const ctx = pad.current!.getContext('2d')!
    ctx.strokeStyle = ink
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = w
    ctx.beginPath()
    const prev = s.pts[s.pts.length - 2] ?? last
    ctx.moveTo((prev.x + last.x) / 2, (prev.y + last.y) / 2)
    ctx.quadraticCurveTo(last.x, last.y, (last.x + p.x) / 2, (last.y + p.y) / 2)
    ctx.stroke()
    s.pts.push(p)
    s.w = w
    setHasInk(true)
  }
  const up = () => {
    const s = stroke.current
    if (s && s.pts.length === 1) {
      const ctx = pad.current!.getContext('2d')!
      ctx.fillStyle = ink
      ctx.beginPath()
      ctx.arc(s.pts[0].x, s.pts[0].y, 3, 0, Math.PI * 2)
      ctx.fill()
      setHasInk(true)
    }
    stroke.current = null
  }
  const clear = () => {
    const c = pad.current!
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height)
    setHasInk(false)
  }

  const renderTyped = (): HTMLCanvasElement | null => {
    if (!typed.trim()) return null
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    ctx.font = `96px ${font}`
    c.width = Math.ceil(ctx.measureText(typed).width) + 60
    c.height = 180
    ctx.font = `96px ${font}`
    ctx.fillStyle = ink
    ctx.textBaseline = 'middle'
    ctx.fillText(typed, 30, 90)
    return trimCanvas(c)
  }

  const processUpload = async (src: string): Promise<string> => {
    if (!knockout) return src
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height)
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]
      if (lum > 215) d.data[i + 3] = 0
      else if (lum > 170) d.data[i + 3] = Math.round(((215 - lum) / 45) * 255)
    }
    ctx.putImageData(d, 0, 0)
    return (trimCanvas(c, 4) ?? c).toDataURL('image/png')
  }

  const use = async (src: string, store: boolean) => {
    const img = new Image()
    img.src = src
    await img.decode()
    if (store && remember) {
      const next = [src, ...saved.filter((s) => s !== src)].slice(0, 8)
      setSaved(next)
      lsSet(KEY, next)
    }
    const w = 170
    useStore.setState({ tool: 'image', selected: null, pendingImage: { src, w, h: (w * img.naturalHeight) / img.naturalWidth } })
    closeDialog()
    toast('Click on the page to place your signature — drag to size it')
  }

  const create = async () => {
    if (tab === 'draw') {
      const c = trimCanvas(pad.current!)
      if (c) use(c.toDataURL('image/png'), true)
    } else if (tab === 'type') {
      const c = renderTyped()
      if (c) use(c.toDataURL('image/png'), true)
    } else if (upload) use(await processUpload(upload), true)
  }

  const canCreate = tab === 'draw' ? hasInk : tab === 'type' ? !!typed.trim() : !!upload

  return (
    <Modal
      title="Sign"
      subtitle="Create a signature, then click on the page to place it."
      icon={SigIcon}
      color="#8b5cf6"
      wide
      onClose={closeDialog}
      footerLeft={
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <Check checked={remember} onChange={setRemember}>
            Remember this signature
          </Check>
          <button className="btn ghost sm" onClick={() => useStore.setState((s) => ({ dialog: { kind: 'digitalSign', docId: s.dialog?.docId } }))}>
            Need a certificate signature? Digitally sign →
          </button>
        </div>
      }
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canCreate} onClick={create}>
            Place signature
          </button>
        </>
      }
    >
      {saved.length > 0 && (
        <>
          <span className="label">Saved signatures</span>
          <div className="sig-list">
            {saved.map((s) => (
              <div key={s} className="sig-item" onClick={() => use(s, false)} title="Use this signature">
                <img src={s} />
                <button
                  className="icon-btn sm del"
                  onClick={(e) => {
                    e.stopPropagation()
                    const next = saved.filter((x) => x !== s)
                    setSaved(next)
                    lsSet(KEY, next)
                  }}
                  title="Remove"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="segmented">
          <button className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}>
            Draw
          </button>
          <button className={tab === 'type' ? 'on' : ''} onClick={() => setTab('type')}>
            Type
          </button>
          <button className={tab === 'upload' ? 'on' : ''} onClick={() => setTab('upload')}>
            Upload
          </button>
        </div>
        {tab !== 'upload' && (
          <div className="swatches" style={{ marginLeft: 'auto' }}>
            {INKS.map((c) => (
              <button key={c} className={`swatch ${ink === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setInk(c)} />
            ))}
          </div>
        )}
      </div>
      {tab === 'draw' && (
        <div className="sig-pad">
          <div className="baseline" />
          <canvas ref={pad} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          <button className="btn sm" style={{ position: 'absolute', right: 10, top: 10 }} onClick={clear} disabled={!hasInk}>
            <Eraser size={13} /> Clear
          </button>
          {!hasInk && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#9ca3af', pointerEvents: 'none' }}>Sign here with your mouse, trackpad or pen</div>
          )}
        </div>
      )}
      {tab === 'type' && (
        <>
          <input className="input" autoFocus placeholder="Type your name" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ height: 40, fontSize: 15 }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {FONTS.map((f) => (
              <button
                key={f.name}
                className={`option-card ${font === f.css ? 'on' : ''}`}
                style={{ height: 70, justifyContent: 'center', background: '#fff' }}
                onClick={() => setFont(f.css)}
              >
                <span style={{ fontFamily: f.css, fontSize: 28, color: ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{typed || 'Your Name'}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'upload' && (
        <>
          <div
            className="sig-pad"
            style={{ height: 200, display: 'grid', placeItems: 'center', cursor: 'default' }}
            onClick={async () => {
              const f = (await window.quire.openDialog({ kind: 'image' }))[0]
              if (f) setUpload(await bytesToDataUrl(f.data, mimeFromName(f.name)))
            }}
          >
            {upload ? (
              <img src={upload} style={{ maxWidth: '90%', maxHeight: 180 }} />
            ) : (
              <div style={{ color: '#9ca3af', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <Upload size={22} />
                Choose a photo or scan of your signature
              </div>
            )}
          </div>
          <Check checked={knockout} onChange={setKnockout}>
            Remove white background
          </Check>
        </>
      )}
    </Modal>
  )
}
