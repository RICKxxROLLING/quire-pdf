// Generates test PDFs into ./fixtures
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib'
import { writeFileSync, mkdirSync } from 'fs'
import { deflateSync } from 'zlib'

mkdirSync('fixtures', { recursive: true })
const lorem = 'The quick brown fox jumps over the lazy dog. Quire makes working with PDF documents fast and pleasant. '

async function textDoc() {
  const doc = await PDFDocument.create()
  doc.setTitle('Quarterly Report'); doc.setAuthor('Test Author')
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  for (let p = 1; p <= 6; p++) {
    const page = doc.addPage([612, 792])
    if (p === 4) page.setRotation(degrees(90))
    page.drawText(`Chapter ${p}: Findings`, { x: 60, y: 720, size: 24, font: bold, color: rgb(0.2, 0.2, 0.35) })
    for (let l = 0; l < 26; l++) page.drawText((lorem + lorem).slice((l * 7) % 60, ((l * 7) % 60) + 88), { x: 60, y: 680 - l * 22, size: 11, font })
    page.drawRectangle({ x: 60, y: 60, width: 492, height: 30, color: rgb(0.43, 0.36, 0.99), opacity: 0.15 })
    page.drawText(`Confidential figure: ${1000 + p * 137}`, { x: 70, y: 70, size: 12, font })
  }
  writeFileSync('fixtures/report.pdf', await doc.save())
}

async function formDoc() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const form = doc.getForm()
  page.drawText('Application Form', { x: 60, y: 720, size: 22, font })
  page.drawText('Full name', { x: 60, y: 670, size: 11, font })
  form.createTextField('applicant.fullName').addToPage(page, { x: 60, y: 640, width: 300, height: 24 })
  page.drawText('Email', { x: 60, y: 610, size: 11, font })
  form.createTextField('applicant.email').addToPage(page, { x: 60, y: 580, width: 300, height: 24 })
  const cb = form.createCheckBox('agreeTerms'); cb.addToPage(page, { x: 60, y: 540, width: 16, height: 16 })
  page.drawText('I agree to the terms', { x: 84, y: 543, size: 11, font })
  const dd = form.createDropdown('country'); dd.addOptions(['Canada', 'France', 'Japan', 'United States']); dd.addToPage(page, { x: 60, y: 490, width: 200, height: 24 })
  writeFileSync('fixtures/form.pdf', await doc.save())
}

async function imageDoc() {
  // A big noisy RGB image stored with Flate so compression has something to do.
  const W = 1600, H = 1100
  const raw = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    raw[i] = (x * 255) / W; raw[i + 1] = (y * 255) / H; raw[i + 2] = ((x ^ y) & 255) * 0.6 + Math.random() * 60
  }
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const stream = doc.context.flateStream(raw, { Type: 'XObject', Subtype: 'Image', Width: W, Height: H, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 })
  const ref = doc.context.register(stream)
  const name = page.node.newXObject('Im', ref)
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import('@cantoo/pdf-lib')
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(500, 0, 0, 344, 56, 400), drawObject(name), popGraphicsState())
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Photo page with a large embedded image', { x: 56, y: 760, size: 14, font })
  writeFileSync('fixtures/photo.pdf', await doc.save())
}

async function lockedDoc() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage([612, 792]).drawText('Top secret contents', { x: 60, y: 700, size: 20, font })
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' })
  writeFileSync('fixtures/locked.pdf', await doc.save({ useObjectStreams: false }))
}

await textDoc(); await formDoc(); await imageDoc(); await lockedDoc()
console.log('fixtures written')
