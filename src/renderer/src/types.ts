import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { SignatureInfo } from '../../preload'

/** Rect in unrotated PDF user space: (x, y) is the bottom-left corner. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface AnnotBase {
  id: string
  /** Stable page id (survives reorder/rotate). */
  page: string
  color: string
  opacity: number
  author?: string
  created: number
}

export type MarkupStyle = 'highlight' | 'underline' | 'strike'

export type Annot =
  | (AnnotBase & { kind: 'markup'; style: MarkupStyle; rects: Rect[] })
  | (AnnotBase & { kind: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; strokeWidth: number; fill?: string })
  | (AnnotBase & { kind: 'redact'; x: number; y: number; w: number; h: number })
  | (AnnotBase & { kind: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; strokeWidth: number })
  | (AnnotBase & { kind: 'ink'; points: number[][]; strokeWidth: number })
  /**
   * Anchored items: (x, y) is the visual top-left corner in user space and `rot` is the page
   * rotation at creation time, so the content stays upright on rotated pages.
   */
  | (AnnotBase & { kind: 'text'; x: number; y: number; rot: number; text: string; size: number })
  | (AnnotBase & { kind: 'note'; x: number; y: number; rot: number; text: string })
  | (AnnotBase & { kind: 'image'; x: number; y: number; rot: number; w: number; h: number; src: string })

export type AnnotKind = Annot['kind']

export type Tool =
  | 'select'
  | 'pan'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'ink'
  | 'text'
  | 'note'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'image'
  | 'redact'
  | 'eraser'
  /** Drag out the box for a visible digital signature. */
  | 'sigbox'

export interface PageSize {
  /** Visual (rotated) size at scale 1, in points. */
  width: number
  height: number
  rotation: number
}

export interface Snapshot {
  bytes: Uint8Array
  pageIds: string[]
  annots: Annot[]
}

export type FitMode = 'width' | 'page' | 'none'

export interface Doc {
  id: string
  name: string
  path?: string
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  pageIds: string[]
  pageSizes: PageSize[]
  annots: Annot[]
  /** User password the file was opened with; re-applied on save. */
  password?: string
  dirty: boolean
  history: Snapshot[]
  future: Snapshot[]
  /** Bumped whenever bytes change, to invalidate renders. */
  version: number
  scale: number
  fit: FitMode
  currentPage: number
  view: 'read' | 'organize'
  /** The file exactly as opened; kept for signed documents so new signatures can be appended incrementally. */
  original?: Uint8Array
  /** Verification results for digital signatures, once checked. */
  signatures?: SignatureInfo[]
}

export type DialogKind =
  | 'merge'
  | 'split'
  | 'compress'
  | 'imagesToPdf'
  | 'pdfToImages'
  | 'extractText'
  | 'watermark'
  | 'headerFooter'
  | 'protect'
  | 'unlock'
  | 'metadata'
  | 'ocr'
  | 'crop'
  | 'flatten'
  | 'signature'
  | 'digitalSign'
  | 'shortcuts'
  | 'about'

export interface ToolStyle {
  color: string
  highlight: string
  strokeWidth: number
  opacity: number
  fontSize: number
}
