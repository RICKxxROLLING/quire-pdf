import { memo, useEffect, useRef } from 'react'
import type { PDFDocumentProxy } from '@/lib/pdfjs'
import { cachedThumb, renderThumb } from '@/lib/thumbs'

/** Lazily rendered page thumbnail. `width`/`height` are CSS pixels of the visual (rotated) page. */
export const Thumb = memo(function Thumb(props: { pdf: PDFDocumentProxy; index: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    let alive = true
    const draw = (bmp: ImageBitmap) => {
      if (!alive) return
      canvas.width = bmp.width
      canvas.height = bmp.height
      canvas.getContext('2d')!.drawImage(bmp, 0, 0)
    }
    const hit = cachedThumb(props.pdf, props.index, props.width)
    if (hit) {
      draw(hit)
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return
        io.disconnect()
        renderThumb(props.pdf, props.index, props.width).then(draw, () => {})
      },
      { rootMargin: '300px' }
    )
    io.observe(canvas)
    return () => {
      alive = false
      io.disconnect()
    }
  }, [props.pdf, props.index, props.width])
  return <canvas ref={ref} style={{ width: props.width, height: props.height, display: 'block', background: '#fff' }} />
})
