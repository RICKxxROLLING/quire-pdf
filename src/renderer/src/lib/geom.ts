import type { Annot, Rect } from '@/types'

export const NOTE_SIZE = 22
export const TEXT_ASCENT = 0.8
export const TEXT_LINE = 1.2

/**
 * Anchored annotations (text, note, image) live in a local frame whose origin is (x, y) in user
 * space, x pointing right and y pointing *down* the page, rotated by `rot` degrees counter-clockwise.
 */
export function localToUser(a: { x: number; y: number; rot: number }, lx: number, ly: number): [number, number] {
  const t = (a.rot * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [a.x + lx * c + ly * s, a.y + lx * s - ly * c]
}

export function userToLocal(a: { x: number; y: number; rot: number }, ux: number, uy: number): [number, number] {
  const t = (a.rot * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  const dx = ux - a.x
  const dy = uy - a.y
  return [dx * c + dy * s, dx * s - dy * c]
}

export function textBoxSize(text: string, size: number): { w: number; h: number } {
  const lines = text.split('\n')
  // Helvetica averages ~0.52em per glyph; good enough for hit-testing and selection boxes.
  const longest = Math.max(1, ...lines.map((l) => l.length))
  return { w: Math.max(size, longest * size * 0.55), h: size * (TEXT_ASCENT + 0.25 + (lines.length - 1) * TEXT_LINE) }
}

/** Local-frame size for anchored annotations. */
export function anchoredSize(a: Annot): { w: number; h: number } {
  if (a.kind === 'text') return textBoxSize(a.text, a.size)
  if (a.kind === 'note') return { w: NOTE_SIZE, h: NOTE_SIZE }
  if (a.kind === 'image') return { w: a.w, h: a.h }
  return { w: 0, h: 0 }
}

/** Axis-aligned bounding box in user space. */
export function annotBounds(a: Annot): Rect {
  const fromPts = (pts: number[][]): Rect => {
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  switch (a.kind) {
    case 'markup':
      return fromPts(a.rects.flatMap((r) => [[r.x, r.y], [r.x + r.w, r.y + r.h]]))
    case 'rect':
    case 'ellipse':
    case 'redact':
      return { x: a.x, y: a.y, w: a.w, h: a.h }
    case 'line':
    case 'arrow':
      return fromPts([[a.x1, a.y1], [a.x2, a.y2]])
    case 'ink':
      return fromPts(a.points)
    case 'text':
    case 'note':
    case 'image': {
      const { w, h } = anchoredSize(a)
      return fromPts([localToUser(a, 0, 0), localToUser(a, w, 0), localToUser(a, 0, h), localToUser(a, w, h)])
    }
  }
}

export function translateAnnot<T extends Annot>(a: T, dx: number, dy: number): T {
  switch (a.kind) {
    case 'markup':
      return { ...a, rects: a.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })) }
    case 'line':
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy }
    case 'ink':
      return { ...a, points: a.points.map((p) => [p[0] + dx, p[1] + dy]) }
    default:
      return { ...a, x: (a as { x: number }).x + dx, y: (a as { y: number }).y + dy }
  }
}

export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Distance from point to segment, for hit-testing lines and ink. */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len = dx * dx + dy * dy
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

export function hitTest(a: Annot, x: number, y: number, tol: number): boolean {
  switch (a.kind) {
    case 'line':
    case 'arrow':
      return distToSegment(x, y, a.x1, a.y1, a.x2, a.y2) <= tol + a.strokeWidth / 2
    case 'ink':
      for (let i = 1; i < a.points.length; i++) {
        const [x1, y1] = a.points[i - 1]
        const [x2, y2] = a.points[i]
        if (distToSegment(x, y, x1, y1, x2, y2) <= tol + a.strokeWidth / 2) return true
      }
      return a.points.length === 1 && Math.hypot(x - a.points[0][0], y - a.points[0][1]) <= tol
    case 'markup':
      return a.rects.some((r) => x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol)
    case 'text':
    case 'note':
    case 'image': {
      const { w, h } = anchoredSize(a)
      const [lx, ly] = userToLocal(a, x, y)
      return lx >= -tol && lx <= w + tol && ly >= -tol && ly <= h + tol
    }
    case 'rect':
    case 'ellipse':
      if (a.fill) return x >= a.x - tol && x <= a.x + a.w + tol && y >= a.y - tol && y <= a.y + a.h + tol
      {
        const inOuter = x >= a.x - tol && x <= a.x + a.w + tol && y >= a.y - tol && y <= a.y + a.h + tol
        const inner = tol + a.strokeWidth
        const inInner = x > a.x + inner && x < a.x + a.w - inner && y > a.y + inner && y < a.y + a.h - inner
        return inOuter && !inInner
      }
    case 'redact':
      return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h
  }
}

/** Visual frame of a page: maps visual (rotated, y-up from bottom-left) coordinates into user space. */
export function visualFrame(box: { x: number; y: number; width: number; height: number }, rotation: number) {
  const rot = ((rotation % 360) + 360) % 360
  const W = box.width
  const H = box.height
  const vw = rot % 180 ? H : W
  const vh = rot % 180 ? W : H
  const toUser = (vx: number, vy: number): [number, number] => {
    let x: number
    let y: number
    switch (rot) {
      case 90:
        x = W - vy
        y = vx
        break
      case 180:
        x = W - vx
        y = H - vy
        break
      case 270:
        x = vy
        y = H - vx
        break
      default:
        x = vx
        y = vy
    }
    return [x + box.x, y + box.y]
  }
  return { vw, vh, rot, toUser }
}
