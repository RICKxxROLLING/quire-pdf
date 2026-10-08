import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownCircle, Command, FolderOpen, Home as HomeIcon, Monitor, Moon, Plus, RefreshCw, Search, Sun, Trash2, X } from 'lucide-react'
import { checkForUpdates, closeTab, installUpdate, openPaths, openUpdatePage, openWithDialog, setTheme, useStore } from '@/store'
import { CATEGORIES, TOOLS, type Category, type ToolDef } from '@/lib/catalog'
import { formatBytes, modKey } from '@/lib/util'
import type { RecentEntry } from '../../../preload'
import { Sidebar } from './Sidebar'
import { Toolbar } from './Toolbar'
import { Viewer } from './Viewer'
import { Organizer } from './Organizer'
import { PropertyBar } from './PropertyBar'
import { SignatureBanner } from './Signatures'

export function TitleBar() {
  const tabs = useStore((s) => s.tabs)
  const active = useStore((s) => s.active)
  const platform = useStore((s) => s.platform)
  const themePref = useStore((s) => s.themePref)
  const ThemeIcon = themePref === 'dark' ? Moon : themePref === 'light' ? Sun : Monitor
  const nextTheme = themePref === 'system' ? 'light' : themePref === 'light' ? 'dark' : 'system'
  return (
    <div className={`titlebar ${platform === 'darwin' ? 'mac' : 'win'}`}>
      {platform !== 'darwin' && (
        <div className="brand">
          <img src="./icon.png" alt="" />
        </div>
      )}
      <div className="tabs">
        <div className={`tab home-tab ${active === 'home' ? 'active' : ''}`} onClick={() => useStore.setState({ active: 'home' })} title="Home">
          <HomeIcon size={15} />
        </div>
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${active === t.id ? 'active' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                closeTab(t.id)
              }
            }}
            onClick={() => useStore.setState({ active: t.id, selected: null, editing: null })}
            title={t.path ?? t.name}
          >
            <span className="name">{t.name}</span>
            {t.dirty && <span className="dirty" title="Unsaved changes" />}
            <button
              className="x"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.id)
              }}
              title="Close"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button className="icon-btn sm" title={`Open (${modKey}O)`} onClick={openWithDialog}>
          <Plus size={16} />
        </button>
      </div>
      <UpdateButton />
      <button className="icon-btn sm" title="Command palette" onClick={() => window.dispatchEvent(new Event('quire:palette'))}>
        <Command size={15} />
      </button>
      <button className="icon-btn sm" title={`Theme: ${themePref}`} onClick={() => setTheme(nextTheme)}>
        <ThemeIcon size={15} />
      </button>
    </div>
  )
}

/** Shows only while there's something to act on: a download in progress, or a new version to get. */
function UpdateButton() {
  const u = useStore((s) => s.update)
  if (u.status === 'downloading')
    return (
      <span className="update-pill" title={`Downloading Quire ${u.version}`}>
        <ArrowDownCircle size={14} /> {u.percent}%
      </span>
    )
  if (u.status === 'ready')
    return (
      <button className="update-pill on" title={`Restart to install Quire ${u.version}`} onClick={installUpdate}>
        <RefreshCw size={13} /> Restart to update
      </button>
    )
  if (u.status === 'available' && !u.canInstall)
    return (
      <button className="update-pill on" title={`Download Quire ${u.version}`} onClick={openUpdatePage}>
        <ArrowDownCircle size={14} /> Quire {u.version} available
      </button>
    )
  return null
}

export function Workspace() {
  const doc = useStore((s) => s.tabs.find((t) => t.id === s.active))
  if (!doc) return null
  return (
    <div className="workspace">
      <Toolbar doc={doc} />
      <div className="main">
        {doc.view === 'read' ? (
          <>
            <Sidebar doc={doc} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', minWidth: 0 }}>
              <SignatureBanner doc={doc} />
              <div style={{ flex: 1, display: 'flex', position: 'relative', minHeight: 0 }}>
                <Viewer doc={doc} />
                <PropertyBar doc={doc} />
              </div>
            </div>
          </>
        ) : (
          <Organizer doc={doc} />
        )}
      </div>
    </div>
  )
}

export function Home() {
  const [recent, setRecent] = useState<RecentEntry[]>([])
  const [cat, setCat] = useState<Category | 'All'>('All')
  const tabs = useStore((s) => s.tabs.length)
  const version = useStore((s) => s.version)
  const checking = useStore((s) => s.update.status === 'checking')
  useEffect(() => {
    window.quire.getRecent().then(setRecent)
  }, [tabs])
  const tools = cat === 'All' ? TOOLS : TOOLS.filter((t) => t.category === cat)
  return (
    <div className="home">
      <div className="home-inner">
        <div className="hero">
          <div style={{ flex: 1 }}>
            <h1>Everything PDF, in one place.</h1>
            <p>Read, annotate, sign, organize, convert, compress and protect your documents — fast, private, and entirely on your device.</p>
            <div className="actions">
              <button className="btn primary lg" onClick={openWithDialog}>
                <FolderOpen size={17} /> Open PDF
              </button>
              <button className="btn lg" onClick={() => window.dispatchEvent(new Event('quire:palette'))}>
                <Search size={16} /> Find a tool
              </button>
              <span className="hint">
                <span className="kbd">{modKey}</span> <span className="kbd">K</span>
              </span>
            </div>
          </div>
          <div className="dropzone" onClick={openWithDialog}>
            <div className="big">
              <Plus size={26} />
            </div>
            <div>
              <b>Drop files here</b>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>PDFs open in tabs · images become a PDF</div>
            </div>
          </div>
        </div>

        <div className="section-title">
          <h2>Tools</h2>
          <span className="sub">{TOOLS.length} tools, no uploads</span>
        </div>
        <div className="category-tabs">
          {(['All', ...CATEGORIES] as const).map((c) => (
            <button key={c} className={`chip ${cat === c ? 'on' : ''}`} style={{ height: 28, padding: '0 12px', fontSize: 12.5 }} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="tool-grid">
          {tools.map((t) => (
            <ToolCard key={t.id} t={t} />
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <div className="section-title">
              <h2>Recent</h2>
              <button
                className="btn ghost sm"
                onClick={async () => {
                  await window.quire.clearRecent()
                  setRecent([])
                }}
              >
                <Trash2 size={13} /> Clear
              </button>
            </div>
            <div className="recent-list">
              {recent.map((r) => (
                <div key={r.path} className="recent-row" onClick={() => openPaths([r.path])}>
                  <div className="file-ic">PDF</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="nm">{r.name}</div>
                    <div className="pth">{r.path}</div>
                  </div>
                  <div className="meta">{formatBytes(r.size)}</div>
                  <div className="meta" style={{ width: 150, textAlign: 'right' }}>
                    {new Date(r.modified).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="home-footer">
          Quire {version}
          <span className="dot">·</span>
          <button className="btn ghost sm" onClick={checkForUpdates} disabled={checking}>
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ToolCard({ t }: { t: ToolDef }) {
  return (
    <button className="tool-card" onClick={t.run}>
      <div className="ic" style={{ background: t.color + '1c', color: t.color === '#1f2937' ? 'var(--text)' : t.color }}>
        <t.icon size={20} />
      </div>
      <div>
        <div className="t">{t.title}</div>
        <div className="d">{t.desc}</div>
      </div>
    </button>
  )
}

/** ⌘K / Ctrl+K command palette over every tool. */
export function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return TOOLS
    return TOOLS.map((t) => {
      const hay = `${t.title} ${t.desc} ${t.keywords ?? ''} ${t.category}`.toLowerCase()
      const score = t.title.toLowerCase().startsWith(s) ? 3 : t.title.toLowerCase().includes(s) ? 2 : s.split(/\s+/).every((w) => hay.includes(w)) ? 1 : 0
      return { t, score }
    })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((r) => r.t)
  }, [q])
  useEffect(() => setIdx(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])
  const run = (t?: ToolDef) => {
    if (!t) return
    onClose()
    t.run()
  }
  return (
    <div className="scrim" style={{ background: 'transparent', backdropFilter: 'none' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <Search size={18} className="search-ic" />
        <input
          autoFocus
          placeholder="Search tools… (merge, compress, sign, OCR)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIdx((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIdx((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') run(results[idx])
            else if (e.key === 'Escape') onClose()
          }}
        />
        <div className="list" ref={listRef}>
          {results.map((t, i) => (
            <button key={t.id} data-i={i} className={`menu-item ${i === idx ? 'on' : ''}`} onMouseEnter={() => setIdx(i)} onClick={() => run(t)}>
              <span className="ic" style={{ background: t.color + '1c', color: t.color === '#1f2937' ? 'var(--text)' : t.color }}>
                <t.icon size={15} />
              </span>
              <span style={{ fontWeight: 560 }}>{t.title}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.desc}</span>
            </button>
          ))}
          {!results.length && <div className="panel-empty">No tools match “{q}”.</div>}
        </div>
      </div>
    </div>
  )
}
