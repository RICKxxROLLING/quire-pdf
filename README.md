# Quire

An all-in-one PDF studio for Windows and macOS. Read, annotate, sign, organize, convert, compress and protect PDFs. Everything runs on your machine, and no file is ever uploaded.

## Features

**Reading**
- Tabs for multiple documents, continuous scroll, crisp HiDPI rendering
- Zoom (fit width, fit page, presets, Ctrl/⌘ + scroll around the cursor), hand tool (or hold Space)
- Page thumbnails, bookmarks/outline, full-text search with match-case / whole-word, selectable text
- Light, dark and system themes; command palette (Ctrl/⌘ K)

**Annotate & sign**
- Highlight, underline, strikethrough (snap to text, or select text and use the popover)
- Freehand pen, text boxes, sticky notes (saved as real PDF comments, re-editable on reopen)
- Rectangles, ellipses, lines, arrows; color, stroke, opacity and fill controls
- Insert images; signatures you can draw, type or upload (with white-background removal), saved for reuse
- Move, resize, nudge, erase, and undo/redo everything

**Organize**
- Drag-and-drop page grid: reorder, rotate, delete, duplicate, extract, reverse
- Insert blank pages, other PDFs, or images
- Merge files, split by ranges / every N pages / every page, crop margins

**Convert, secure & optimize**
- Images → PDF (A4 / Letter / fit, auto orientation), PDF → PNG/JPG at up to 600 dpi, extract text
- OCR in 13 languages, which adds an invisible text layer so scans become searchable
- True redaction: affected pages are re-rendered with content burned out, not just covered
- Certificate-based digital signatures: create a self-signed ID or import a .p12/.pfx, visible or invisible, optional RFC 3161 timestamp, countersigning without breaking earlier signatures, and a panel that verifies the signatures in documents you open
- Password protection (AES-256) with permissions, password removal, metadata editor
- Watermarks (centered or tiled), page numbers, headers & footers with tokens
- Fill and flatten AcroForms, flatten annotations
- Compression that re-encodes images while keeping text and vectors sharp
- Print with annotations included

## Development

Requires Node 20+.

```bash
npm install
npm run dev        # hot-reloading dev build
npm run typecheck
```

## Building installers

```bash
npm run dist:win   # Windows: NSIS installer (x64 + arm64) and portable .exe → release/
npm run dist:mac   # macOS: universal .dmg and .zip → release/ (must run on a Mac)
```

macOS apps can only be packaged on macOS. If you don't have a Mac handy, push a `v*` tag (or run the
**Build installers** workflow manually) and GitHub Actions in `.github/workflows/build.yml` builds both
platforms and attaches the installers as artifacts. Tag pushes also publish a GitHub Release with the
installers attached:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Or run **Build installers** manually from the Actions tab and enter a tag (e.g. `v1.0.0`) to publish a release
without pushing one.

Builds are unsigned by default. Windows SmartScreen and macOS Gatekeeper will warn the first time the app runs. On a Mac, right-click → Open. To sign and notarize, set `CSC_LINK` / `CSC_KEY_PASSWORD` (and `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for notarization) as environment variables or CI secrets.

**Windows build note:** if electron-builder fails with *"Cannot create symbolic link: A required privilege
is not held by the client"*, either enable Windows Developer Mode, or pre-extract its signing toolkit once:

```bash
7za x -y %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<number>.7z -o%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0
```

(The two macOS symlink errors it prints are harmless.)

## Architecture

| Layer | Tech |
| --- | --- |
| Shell | Electron 33. The UI is served from a sandboxed `app://` origin with context isolation and a strict CSP |
| UI | React 18 + Zustand, hand-written CSS design system (`src/renderer/src/styles.css`) |
| Rendering, text, search | pdf.js 4 |
| Editing | `@cantoo/pdf-lib` (a pdf-lib fork with AES encryption/decryption) |
| OCR | tesseract.js 5. The engine ships with the app; language data downloads once on first use, then is cached |

Key files:

- `src/main/index.ts`: window, menus, file dialogs, recent files, file associations
- `src/renderer/src/store.ts`: documents, tabs, undo/redo history, save/export
- `src/renderer/src/lib/ops.ts`: every PDF transformation (bytes in, bytes out)
- `src/renderer/src/components/Viewer.tsx` / `AnnotLayer.tsx`: virtualized page view and annotation editing
- `src/renderer/src/tools/Dialogs.tsx`: the tool dialogs

While you work, annotations are editable overlays and fully undoable. When you save, highlights, drawings,
text, shapes and signatures are flattened into the page content, so they look identical in every PDF viewer.
Sticky notes are saved as real PDF comments and become editable again when you reopen the file in Quire.

Debugging: launch with `QUIRE_DEBUG=1` to expose the store and operations on `window.__q` in DevTools.
`node scripts/make-fixtures.mjs` generates sample PDFs (text, form, image-heavy, encrypted) in `fixtures/`.
