import {
  BadgeCheck,
  Combine,
  Crop,
  EyeOff,
  FileArchive,
  FileImage,
  FileText,
  FormInput,
  Hash,
  Highlighter,
  ImagePlus,
  Info,
  Layers,
  LayoutGrid,
  Lock,
  LockOpen,
  Printer,
  ScanText,
  Scissors,
  Signature,
  Stamp,
  type LucideIcon
} from 'lucide-react'
import type { DialogKind } from '@/types'
import { openDialog, requireDoc, setDocView, setPanel, setTool, toast, useStore } from '@/store'
import { printDoc } from './print'

export type Category = 'Organize' | 'Edit' | 'Convert' | 'Secure' | 'Optimize'

export interface ToolDef {
  id: string
  title: string
  desc: string
  icon: LucideIcon
  color: string
  category: Category
  keywords?: string
  run: () => void | Promise<void>
}

const withDoc = (fn: (id: string) => void) => async () => {
  const d = await requireDoc()
  if (d) fn(d.id)
}
const dialog = (kind: DialogKind, needsDoc = true) =>
  needsDoc ? withDoc((id) => openDialog(kind, id)) : () => openDialog(kind)

export const TOOLS: ToolDef[] = [
  {
    id: 'organize',
    title: 'Organize pages',
    desc: 'Reorder, rotate, delete, duplicate and insert pages.',
    icon: LayoutGrid,
    color: '#6d5dfc',
    category: 'Organize',
    keywords: 'reorder rotate delete move arrange insert blank',
    run: withDoc((id) => setDocView(id, { view: 'organize' }))
  },
  { id: 'merge', title: 'Merge PDFs', desc: 'Combine several files into one document.', icon: Combine, color: '#3b82f6', category: 'Organize', keywords: 'combine join', run: dialog('merge', false) },
  { id: 'split', title: 'Split PDF', desc: 'Break a file apart by ranges or every N pages.', icon: Scissors, color: '#0ea5e9', category: 'Organize', keywords: 'extract separate', run: dialog('split') },
  { id: 'crop', title: 'Crop pages', desc: 'Trim margins off one or all pages.', icon: Crop, color: '#14b8a6', category: 'Organize', keywords: 'trim margins', run: dialog('crop') },
  {
    id: 'annotate',
    title: 'Annotate',
    desc: 'Highlight, draw, add text, shapes and sticky notes.',
    icon: Highlighter,
    color: '#f59e0b',
    category: 'Edit',
    keywords: 'highlight comment draw markup note',
    run: withDoc((id) => {
      setDocView(id, { view: 'read' })
      setTool('highlight')
    })
  },
  {
    id: 'sign',
    title: 'Sign',
    desc: 'Draw, type or upload a signature and place it.',
    icon: Signature,
    color: '#8b5cf6',
    category: 'Edit',
    keywords: 'signature initials',
    run: dialog('signature')
  },
  {
    id: 'forms',
    title: 'Fill forms',
    desc: 'Fill in interactive form fields, then flatten.',
    icon: FormInput,
    color: '#22c55e',
    category: 'Edit',
    keywords: 'acroform field',
    run: withDoc((id) => {
      setDocView(id, { view: 'read' })
      setPanel('forms')
    })
  },
  { id: 'watermark', title: 'Watermark', desc: 'Stamp text across pages, centered or tiled.', icon: Stamp, color: '#ec4899', category: 'Edit', keywords: 'stamp draft confidential', run: dialog('watermark') },
  { id: 'headerFooter', title: 'Page numbers', desc: 'Add page numbers, headers and footers.', icon: Hash, color: '#f97316', category: 'Edit', keywords: 'header footer bates numbering', run: dialog('headerFooter') },
  {
    id: 'redact',
    title: 'Redact',
    desc: 'Permanently black out sensitive content.',
    icon: EyeOff,
    color: '#1f2937',
    category: 'Secure',
    keywords: 'black out censor remove',
    run: withDoc((id) => {
      setDocView(id, { view: 'read' })
      setTool('redact')
      toast('Drag over anything you want to redact. It is permanently removed when you save.')
    })
  },
  {
    id: 'digitalSign',
    title: 'Digitally sign',
    desc: 'Certificate-based signature that proves who signed and detects changes.',
    icon: BadgeCheck,
    color: '#0ea5e9',
    category: 'Secure',
    keywords: 'digital signature certificate p12 pfx verify esign pades',
    run: dialog('digitalSign')
  },
  { id: 'protect', title: 'Protect', desc: 'Encrypt with a password and set permissions.', icon: Lock, color: '#e5484d', category: 'Secure', keywords: 'encrypt password security', run: dialog('protect') },
  { id: 'unlock', title: 'Remove password', desc: 'Save an unprotected copy of a locked PDF.', icon: LockOpen, color: '#f43f5e', category: 'Secure', keywords: 'decrypt unlock', run: dialog('unlock') },
  { id: 'metadata', title: 'Properties', desc: 'Edit title, author, subject and keywords.', icon: Info, color: '#64748b', category: 'Secure', keywords: 'metadata info author title', run: dialog('metadata') },
  { id: 'compress', title: 'Compress', desc: 'Shrink file size by optimizing images.', icon: FileArchive, color: '#10b981', category: 'Optimize', keywords: 'reduce size optimize smaller', run: dialog('compress') },
  { id: 'ocr', title: 'OCR', desc: 'Recognize text in scans and make it searchable.', icon: ScanText, color: '#06b6d4', category: 'Optimize', keywords: 'recognize scan searchable text', run: dialog('ocr') },
  { id: 'flatten', title: 'Flatten', desc: 'Bake form fields into the page content.', icon: Layers, color: '#a855f7', category: 'Optimize', keywords: 'flatten forms', run: dialog('flatten') },
  { id: 'imagesToPdf', title: 'Images to PDF', desc: 'Turn JPG, PNG and other images into a PDF.', icon: ImagePlus, color: '#3b82f6', category: 'Convert', keywords: 'jpg png convert photo scan', run: dialog('imagesToPdf', false) },
  { id: 'pdfToImages', title: 'PDF to images', desc: 'Export pages as PNG or JPG files.', icon: FileImage, color: '#6366f1', category: 'Convert', keywords: 'export png jpg convert', run: dialog('pdfToImages') },
  { id: 'extractText', title: 'Extract text', desc: 'Pull all text out as a .txt file.', icon: FileText, color: '#0891b2', category: 'Convert', keywords: 'txt copy text', run: dialog('extractText') },
  {
    id: 'print',
    title: 'Print',
    desc: 'Print with your annotations included.',
    icon: Printer,
    color: '#475569',
    category: 'Convert',
    keywords: 'printer paper',
    run: withDoc((id) => printDoc(id))
  }
]

export const CATEGORIES: Category[] = ['Organize', 'Edit', 'Convert', 'Secure', 'Optimize']

export const toolById = (id: string) => TOOLS.find((t) => t.id === id)

export const hasDoc = () => useStore.getState().active !== 'home'
