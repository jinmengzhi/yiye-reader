import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { backupFileName, createBackup, downloadBackup, readBackup, type BackupPayload } from './backup'
import { App as CapacitorApp } from '@capacitor/app'
import { unzipSync } from 'fflate'
import {
  BlobReader,
  ERR_ENCRYPTED,
  ERR_ENCRYPTED_CENTRAL_DIRECTORY,
  ERR_INVALID_PASSWORD,
  ERR_UNSUPPORTED_ENCRYPTION,
  ZipReader,
  type FileEntry,
} from '@zip.js/zip.js'
import {
  checkpointBookProgress,
  deleteBook,
  deleteCustomFont,
  findBookByFingerprint,
  getBooks,
  getChapterRecognitionCaches,
  getCustomFonts,
  getSettings,
  replaceLibrary,
  saveBook,
  saveBookProgress,
  saveChapterRecognitionCache,
  saveCustomFont,
  saveSettings,
} from './db'
import {
  prepareImport,
} from './encoding'
import type { Book, BookGroup, ChapterAddition, ChapterRecognition, ChapterRecognitionCacheRecord, CommonFolder, CustomFont, CustomFontFamily, ImportCandidate, ReaderSettings, ReaderTheme, ShelfFilter, ShelfSort } from './types'
import { DEFAULT_SETTINGS, normalizeSettings } from './types'
import { applyNativeStatusBar, isNativeAndroid, shareNativeBackup, shareNativeTextFiles } from './native'
import {
  CHAPTER_RECOGNITION_VERSION,
  buildReaderBlocks,
  detectChapterHeadings,
  readerDocumentWithManualChapter,
  type Chapter,
  type ReaderBlock,
  type ReaderDocument,
} from './chapterRecognition'
import {
  deleteNativeFile,
  getNativeFileInfo,
  isNativeFolderPickerAvailable,
  listNativeFolder,
  pickNativeFiles,
  pickNativeFolder,
  readNativeFolderFile,
  renameNativeFile,
  type FolderFile,
} from './folderPicker'

type View = 'shelf' | 'reader'
type Sheet = 'settings' | 'toc' | 'progress' | 'fonts' | 'backup' | 'group' | 'create-group' | 'rename-group' | 'book-actions' | 'rename-book' | 'library-actions' | 'move-selection' | null
type MainTab = 'shelf' | 'settings'
interface FolderBrowserState {
  folder: CommonFolder
  files: FolderFile[]
  archiveGroupName?: string
  archiveCreateGroup?: boolean
  archiveReader?: ZipReader<Blob>
  archiveEntries?: Map<string, FileEntry>
  archivePassword?: string
  archivePasswordRequired?: boolean
  archivePasswordError?: string
}
interface ReaderTextSelection { title: string; offset: number; endOffset: number; left: number; top: number }
interface BatchChapterSuggestion { bookId: string; title: string; additions: ChapterAddition[] }
interface ShelfGroup extends BookGroup { books: Book[]; lastActiveAt: number }
type ShelfItem = { kind: 'book'; book: Book } | { kind: 'group'; group: ShelfGroup }
interface DragPreview { book: Book; x: number; y: number; offsetX: number; offsetY: number; width: number }
interface PreparedFontImport { data: ArrayBuffer; displayName: string; fileName: string; mimeType: string }
interface ReaderGesture { x: number; y: number; pointerId: number }
interface PendingReaderRestore { bookId: string; textOffset: number; token: number }
interface ReaderRenderWindow { bookId: string; startOffset: number; endOffset: number; blocks: ReaderBlock[] }

const COVER_COLOR_COUNT = 6
const SHELF_SORT_OPTIONS: Array<{ value: ShelfSort; label: string }> = [
  { value: 'recent', label: '最近阅读' },
  { value: 'imported', label: '导入时间' },
  { value: 'title', label: '书名' },
  { value: 'progress', label: '阅读进度' },
  { value: 'size', label: '文件大小' },
]
const SHELF_FILTER_OPTIONS: Array<{ value: ShelfFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'reading', label: '阅读中' },
  { value: 'finished', label: '已读' },
]
const readerPaginationCache = new Map<string, number>()
// Parsing a large TXT (line splitting + chapter detection) is surprisingly
// expensive. Keep the parsed document around while the app is alive so that
// leaving and reopening a book does not repeat that work.
const readerDocumentCache = new Map<string, ReaderDocument>()
const readerChapterRecognitionCache = new Map<string, ChapterRecognitionCacheRecord>()
const readerLoadedFonts = new Set<string>()
const readerPrewarmHosts = new Map<string, HTMLElement>()
const READER_PAGINATION_CACHE_KEY = 'one-page-reader-pagination-cache'
const READER_LAYOUT_VERSION = 2
// Paragraphs are grouped before rendering, so books of this size can be
// prepared during import without creating one DOM node per source line.
const MAX_PREWARM_CONTENT_LENGTH = 12_000_000
const TOC_ROW_HEIGHT = 46
const TOC_OVERSCAN_ROWS = 10
const MAX_ZIP_FILE_SIZE = 100 * 1024 * 1024
const MAX_ZIP_TEXT_FILES = 500
const MAX_ZIP_TEXT_FILE_SIZE = 30 * 1024 * 1024
const MAX_ZIP_TEXT_TOTAL_SIZE = 180 * 1024 * 1024
let readerPaginationCacheLoaded = false

function manualChapterMatchCandidates(content: string, addition: ChapterAddition, occupiedOffsets: Set<number>): ChapterAddition[] {
  const rawLines = content.split('\n')
  const lines: Array<{ offset: number; raw: string; text: string; indent: number; beforeBlank: boolean; afterBlank: boolean }> = []
  let offset = 0
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    let indent = 0
    for (const character of raw) {
      if (character === ' ') indent += 1
      else if (character === '\t') indent += 4
      else if (character === '\u3000') indent += 2
      else if (/\s/u.test(character) && character !== '\r' && character !== '\n') indent += 1
      else break
    }
    lines.push({
      offset,
      raw,
      text: raw.trim().replace(/\s+/g, ' '),
      indent,
      beforeBlank: index === 0 || !rawLines[index - 1].trim(),
      afterBlank: index === rawLines.length - 1 || !rawLines[index + 1].trim(),
    })
    offset += raw.length + 1
  }
  const source = lines.find((line) => addition.offset >= line.offset && addition.offset <= line.offset + line.raw.length)
  if (!source?.text) return []
  if (source.text !== addition.title) return []
  return lines
    .filter((line) => line.offset !== source.offset
      && !occupiedOffsets.has(line.offset)
      && line.text === source.text
      && line.indent === source.indent
      && line.beforeBlank === source.beforeBlank
      && line.afterBlank === source.afterBlank)
    .map((line) => ({ offset: line.offset, endOffset: line.offset + line.raw.length, title: line.text }))
}

function rememberReaderPrewarmHost(key: string, host: HTMLElement): void {
  const previous = readerPrewarmHosts.get(key)
  if (previous && previous !== host) previous.remove()
  readerPrewarmHosts.delete(key)
  readerPrewarmHosts.set(key, host)
  while (readerPrewarmHosts.size > 2) {
    const oldestKey = readerPrewarmHosts.keys().next().value
    if (!oldestKey) break
    readerPrewarmHosts.get(oldestKey)?.remove()
    readerPrewarmHosts.delete(oldestKey)
  }
}

function cachedReaderPages(key: string): number | undefined {
  if (!readerPaginationCacheLoaded) {
    readerPaginationCacheLoaded = true
    try {
      const stored = JSON.parse(localStorage.getItem(READER_PAGINATION_CACHE_KEY) || '[]') as Array<[string, number]>
      for (const [storedKey, pages] of stored) {
        if (typeof storedKey === 'string' && Number.isFinite(pages) && pages > 0) readerPaginationCache.set(storedKey, pages)
      }
    } catch {
      // A fresh measurement will replace an invalid cache.
    }
  }
  return readerPaginationCache.get(key)
}

function rememberReaderPages(key: string, pages: number): void {
  readerPaginationCache.delete(key)
  readerPaginationCache.set(key, pages)
  while (readerPaginationCache.size > 40) {
    const oldestKey = readerPaginationCache.keys().next().value
    if (!oldestKey) break
    readerPaginationCache.delete(oldestKey)
  }
  try {
    localStorage.setItem(READER_PAGINATION_CACHE_KEY, JSON.stringify([...readerPaginationCache]))
  } catch {
    // In-memory caching still avoids repeated work in the current session.
  }
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function customFontValue(id: string): CustomFontFamily {
  return `custom:${id}`
}

function customFontId(value: string): string | null {
  return value.startsWith('custom:') ? value.slice('custom:'.length) : null
}

function customFontCssFamily(id: string): string {
  return `ReaderCustom_${id.replace(/[^a-zA-Z0-9_-]/g, '')}`
}

function readerFontCss(fontFamily: string, followSystemFont: boolean): string {
  if (followSystemFont) return 'system-ui, -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif'
  const importedId = customFontId(fontFamily)
  if (importedId) return `"${customFontCssFamily(importedId)}", "Reader Song", serif`
  if (fontFamily === 'heiti') return '"Microsoft YaHei", "Noto Sans SC", SimHei, sans-serif'
  if (fontFamily === 'kaiti') return '"Reader Kai", serif'
  if (fontFamily === 'yuanti') return '"Reader Round", sans-serif'
  return '"Reader Song", serif'
}

async function ensureReaderFontLoaded(fontFamily: string, followSystemFont: boolean): Promise<void> {
  if (followSystemFont || !('fonts' in document)) return
  const family = readerFontCss(fontFamily, false)
  if (readerLoadedFonts.has(family)) return
  try {
    await document.fonts.load(`16px ${family}`, '天地玄黄 宇宙洪荒 阅读字体')
    await document.fonts.ready
    readerLoadedFonts.add(family)
  } catch {
    // The fallback remains usable; a later render can retry the bundled font.
  }
}

function readerPaginationCacheKey(book: Book, settings: ReaderSettings, width: number, height: number): string {
  const additions = (book.chapterAdditions ?? [])
    .map((addition) => `${addition.offset}:${addition.endOffset ?? ''}:${addition.subtitleOffset ?? ''}:${addition.subtitleEndOffset ?? ''}:${addition.title}`)
    .sort()
    .join('|')
  return [
    READER_LAYOUT_VERSION,
    book.id,
    book.content.length,
    Math.round(width),
    Math.round(height),
    settings.fontSize,
    settings.lineHeight,
    settings.paragraphSpacing,
    settings.paragraphIndent,
    settings.pageMargin,
    settings.fontFamily,
    settings.followSystemFont ? 1 : 0,
    (book.chapterExclusions ?? []).join(','),
    additions,
  ].join(':')
}

function readerContentLayoutKey(settings: ReaderSettings): string {
  return [READER_LAYOUT_VERSION, settings.paragraphSpacing, settings.paragraphIndent].join(':')
}

async function prewarmReaderPagination(book: Book, settings: ReaderSettings): Promise<void> {
  if (book.content.length > MAX_PREWARM_CONTENT_LENGTH) return
  const width = Math.max(1, document.documentElement.clientWidth || window.innerWidth)
  const height = Math.max(1, document.documentElement.clientHeight || window.innerHeight)
  const key = readerPaginationCacheKey(book, settings, width, height)
  if (cachedReaderPages(key) && readerPrewarmHosts.has(key)) return
  await ensureReaderFontLoaded(settings.fontFamily, settings.followSystemFont)
  if (cachedReaderPages(key) && readerPrewarmHosts.has(key)) return

  const host = document.createElement('main')
  host.className = 'reader-view mode-scroll reader-pagination-prewarm'
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    position: 'fixed', left: '-100000px', top: '0', right: 'auto', bottom: 'auto',
    width: `${width}px`, height: `${height}px`, visibility: 'hidden', pointerEvents: 'none',
  })
  host.style.setProperty('--reader-bg', settings.backgroundColor)
  host.style.setProperty('--reader-ink', settings.textColor)
  host.style.setProperty('--reader-font', readerFontCss(settings.fontFamily, settings.followSystemFont))

  const scroll = document.createElement('div')
  scroll.className = 'reader-scroll mode-horizontal reader-pagination-measure'
  Object.assign(scroll.style, { width: `${width}px`, height: `${height}px`, fontSize: `${settings.fontSize}px` })
  scroll.style.lineHeight = `${settings.fontSize * settings.lineHeight}px`
  scroll.style.setProperty('--reader-page-margin', `${settings.pageMargin}px`)
  scroll.style.setProperty('--paragraph-gap', `${settings.paragraphSpacing === 0.3 ? 0 : settings.paragraphSpacing === 0.7 ? 1 : 2}lh`)
  scroll.style.setProperty('--paragraph-indent', `${settings.paragraphIndent}em`)
  const requestedLineHeight = settings.fontSize * settings.lineHeight
  const topPadding = Math.min(12, settings.pageMargin)
  const availableHeight = Math.max(requestedLineHeight, height - 22 - topPadding)
  const lineCount = Math.max(1, Math.round(availableHeight / requestedLineHeight))
  const fittedLineHeight = availableHeight / lineCount
  scroll.style.lineHeight = `${fittedLineHeight}px`
  scroll.style.setProperty('--reader-line-height', `${fittedLineHeight}px`)
  scroll.style.setProperty('--reader-page-top-padding', `${topPadding}px`)
  scroll.style.setProperty('--reader-page-bottom-padding', '22px')

  const paper = document.createElement('article')
  paper.className = 'reader-paper'
  const readerDocument = getCachedReaderDocument(book)
  const targetOffset = book.textOffset || Math.round(book.content.length * book.progress)
  const renderWindow = readerBlockWindow(readerDocument, book, targetOffset)
  paper.dataset.readerBookId = book.id
  paper.dataset.readerDocumentKey = readerDocumentCacheKey(book)
  paper.dataset.readerLayoutKey = readerContentLayoutKey(settings)
  paper.dataset.readerWindowStart = String(renderWindow.startOffset)
  paper.dataset.readerWindowEnd = String(renderWindow.endOffset)
  if (renderWindow.startOffset === 0) {
    const title = document.createElement('h1')
    title.textContent = book.title
    paper.appendChild(title)
    const rule = document.createElement('div')
    rule.className = 'reader-rule'
    rule.appendChild(document.createElement('span'))
    paper.appendChild(rule)
  }
  const content = document.createElement('div')
  content.className = 'reader-content'
  content.innerHTML = readerBlocksHtml(renderWindow.blocks, false, settings.paragraphSpacing, settings.paragraphIndent)
  paper.appendChild(content)
  if (renderWindow.endOffset >= book.content.length) {
    const footer = document.createElement('footer')
    footer.textContent = '— 全文完 —'
    paper.appendChild(footer)
  }
  scroll.appendChild(paper)
  host.appendChild(scroll)
  document.body.appendChild(host)
  try {
    const localPages = Math.max(1, Math.ceil(scroll.scrollWidth / width))
    const windowLength = Math.max(1, renderWindow.endOffset - renderWindow.startOffset)
    const total = Math.max(1, Math.ceil(localPages * book.content.length / windowLength))
    rememberReaderPages(key, total)
    rememberReaderPrewarmHost(key, host)
  } finally {
    if (!readerPrewarmHosts.has(key)) host.remove()
  }
}

function getBookCoverIndex(book: Book): number {
  let hash = 0
  for (let index = 0; index < book.id.length; index += 1) {
    hash = ((hash * 31) + book.id.charCodeAt(index)) | 0
  }
  return (hash >>> 0) % COVER_COLOR_COUNT
}

function Icon({ name, size = 22 }: { name: 'book' | 'plus' | 'more' | 'grid-more' | 'back' | 'type' | 'moon' | 'archive' | 'upload' | 'download' | 'trash' | 'check' | 'close' | 'search' | 'settings' | 'folder' | 'folder-plus' | 'list' | 'expand' | 'shrink' | 'share'; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15.5a.5.5 0 0 1-.76.43C17.9 19.13 16.45 19 15 19c-2.2 0-4 .8-5 2-1-1.2-2.8-2-5-2H4V5.5Z"/><path d="M10 21V6.5C10 4.57 8.43 3 6.5 3"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></>,
    'grid-more': <><circle cx="7" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="17" cy="7" r="1.6" fill="currentColor" stroke="none"/><circle cx="7" cy="17" r="1.6" fill="currentColor" stroke="none"/><circle cx="17" cy="17" r="1.6" fill="currentColor" stroke="none"/></>,
    back: <><path d="m15 18-6-6 6-6"/></>,
    type: <><path d="M4 7V4h16v3M9 20h6M12 4v16"/></>,
    moon: <><path d="M20.4 15.2A8 8 0 0 1 8.8 3.6 9 9 0 1 0 20.4 15.2Z"/></>,
    archive: <><path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6"/></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v6h14v-6"/></>,
    download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5M5 20h14"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/></>,
    settings: <><path d="M4 7h16M4 12h16M4 17h16"/><circle cx="9" cy="7" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="17" r="2" fill="currentColor" stroke="none"/></>,
    folder: <><path d="M3 6.5h6l2 2h10v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z"/><path d="M3 10h18"/></>,
    'folder-plus': <><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6M9 13h6"/></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3"/></>,
    expand: <><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/><path d="m3 8 6-6M21 8l-6-6M21 16l-6 6M3 16l6 6"/></>,
    shrink: <><path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6"/><path d="m3 3 6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/></>,
    share: <><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function compareShelfBooks(left: Book, right: Book, sort: ShelfSort): number {
  if (sort === 'title') return left.title.localeCompare(right.title, 'zh-CN') || (right.lastReadAt - left.lastReadAt)
  if (sort === 'imported') return (right.importedAt - left.importedAt) || (right.lastReadAt - left.lastReadAt)
  if (sort === 'progress') return (right.progress - left.progress) || (right.lastReadAt - left.lastReadAt)
  if (sort === 'size') return (right.size - left.size) || (right.lastReadAt - left.lastReadAt)
  return (right.lastReadAt - left.lastReadAt) || (right.importedAt - left.importedAt)
}

function matchesShelfFilter(book: Book, filter: ShelfFilter): boolean {
  if (filter === 'unread') return book.progress <= 0
  if (filter === 'finished') return book.progress >= 1
  if (filter === 'reading') return book.progress > 0 && book.progress < 1
  return true
}

function shelfItemSortValue(item: ShelfItem, sort: ShelfSort): number | string {
  if (item.kind === 'book') {
    if (sort === 'title') return item.book.title
    if (sort === 'imported') return item.book.importedAt
    if (sort === 'progress') return item.book.progress
    if (sort === 'size') return item.book.size
    return item.book.lastReadAt
  }
  if (sort === 'title') return item.group.name
  if (sort === 'imported') return item.group.createdAt
  if (sort === 'progress') return item.group.books.length ? item.group.books.reduce((sum, book) => sum + book.progress, 0) / item.group.books.length : 0
  if (sort === 'size') return item.group.books.reduce((sum, book) => sum + book.size, 0)
  return item.group.lastActiveAt
}

function compareShelfItems(left: ShelfItem, right: ShelfItem, sort: ShelfSort): number {
  const leftValue = shelfItemSortValue(left, sort)
  const rightValue = shelfItemSortValue(right, sort)
  const leftRecent = left.kind === 'group' ? left.group.lastActiveAt : left.book.lastReadAt
  const rightRecent = right.kind === 'group' ? right.group.lastActiveAt : right.book.lastReadAt
  if (typeof leftValue === 'string' && typeof rightValue === 'string') return leftValue.localeCompare(rightValue, 'zh-CN') || (rightRecent - leftRecent)
  return (Number(rightValue) - Number(leftValue)) || (rightRecent - leftRecent)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function progressPercentValue(progress: number): string {
  const normalized = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  return (normalized * 100).toFixed(1)
}

function formatProgressPercent(progress: number): string {
  return `${progressPercentValue(progress)}%`
}

function folderFileId(file: FolderFile): string {
  return file.uri || file.relativePath || file.name
}

function isZipFile(file: Pick<File, 'name'>): boolean {
  return file.name.toLocaleLowerCase().endsWith('.zip')
}

function archiveDefaultGroupName(fileName: string): string {
  return fileName.replace(/\.zip$/i, '').trim() || '压缩包书籍'
}

function archiveGroupName(groupName: string, groups: BookGroup[]): string {
  const base = groupName.trim() || '压缩包书籍'
  const existing = new Set(groups.map((group) => group.name))
  for (let sequence = 1; sequence < 1000; sequence += 1) {
    const suffix = sequence === 1 ? '' : ` ${sequence}`
    const name = `${base.slice(0, Math.max(1, 18 - suffix.length))}${suffix}`
    if (!existing.has(name)) return name
  }
  return `${base.slice(0, 14)} ${Date.now().toString().slice(-3)}`
}

function archiveEntryPath(filename: string): string | null {
  const relativePath = filename.replace(/\\/g, '/')
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:\//.test(relativePath)) return null
  const parts = relativePath.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return relativePath
}

async function zipContainsImportableTxt(file: File): Promise<boolean> {
  if (!file.size || file.size > MAX_ZIP_FILE_SIZE) return false
  const reader = new ZipReader(new BlobReader(file))
  try {
    const entries = await reader.getEntries()
    return entries.some((entry) => {
      if (entry.directory || entry.uncompressedSize <= 0) return false
      const relativePath = archiveEntryPath(entry.filename)
      const fileName = relativePath?.split('/').pop() || ''
      const hiddenOrMetadata = relativePath?.startsWith('__MACOSX/')
        || relativePath?.split('/').some((part) => part.startsWith('.'))
      return Boolean(relativePath && fileName.toLocaleLowerCase().endsWith('.txt') && !hiddenOrMetadata)
    })
  } catch {
    return false
  } finally {
    try {
      await reader.close()
    } catch {
      // A failed directory read still needs no further cleanup from the caller.
    }
  }
}

function archiveReadErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '')
  if (message === ERR_INVALID_PASSWORD) return '压缩包密码错误，请重试。'
  if (message === ERR_UNSUPPORTED_ENCRYPTION) return '该 ZIP 的加密方式暂不支持。'
  if (message === ERR_ENCRYPTED_CENTRAL_DIRECTORY) return '该 ZIP 的目录也被加密，暂不支持。'
  if (message === ERR_ENCRYPTED) return '请输入压缩包密码。'
  return fallback
}

function formatRecent(timestamp: number): string {
  if (!timestamp) return '尚未阅读'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚阅读'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日阅读`
}

function formatFolderFileDate(timestamp?: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

function folderDateGroupLabel(timestamp?: number): string {
  if (!timestamp) return '其他时间'
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  return sameDay ? '今天' : `${date.getMonth() + 1}月${date.getDate()}日`
}

async function prepareFontImport(file: File): Promise<PreparedFontImport> {
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'hwt') {
    if (file.size > 80 * 1024 * 1024) throw new Error('HWT 字体包不能超过 80 MB。')
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()))
    } catch {
      throw new Error('无法解析这个 HWT 字体包。')
    }
    const candidates = Object.entries(entries)
      .filter(([name, data]) => /\.(?:ttf|otf)$/i.test(name) && data.byteLength > 0)
      .sort((left, right) => right[1].byteLength - left[1].byteLength)
    const selected = candidates[0]
    if (!selected) throw new Error('这个 HWT 包中没有找到 TTF 或 OTF 字体。')
    if (selected[1].byteLength > 30 * 1024 * 1024) throw new Error('HWT 包中的字体文件不能超过 30 MB。')
    const internalName = selected[0].split('/').pop() || selected[0]
    const data = selected[1].buffer.slice(selected[1].byteOffset, selected[1].byteOffset + selected[1].byteLength) as ArrayBuffer
    return {
      data,
      displayName: file.name.replace(/\.hwt$/i, '').trim() || internalName.replace(/\.(?:ttf|otf)$/i, ''),
      fileName: internalName,
      mimeType: /\.otf$/i.test(internalName) ? 'font/otf' : 'font/ttf',
    }
  }
  if (extension !== 'ttf' && extension !== 'otf') throw new Error('请选择 TTF、OTF 或 HWT 字体文件。')
  if (file.size > 30 * 1024 * 1024) throw new Error('字体文件不能超过 30 MB。')
  return {
    data: await file.arrayBuffer(),
    displayName: file.name.replace(/\.(?:ttf|otf)$/i, '').trim() || '自定义字体',
    fileName: file.name,
    mimeType: file.type || (extension === 'otf' ? 'font/otf' : 'font/ttf'),
  }
}

function makeBook(candidate: ImportCandidate, sourceUri?: string): Book {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: candidate.file.name.replace(/\.txt$/i, '') || '未命名书籍',
    originalName: candidate.file.name,
    sourceUri,
    content: candidate.content,
    encoding: candidate.encoding,
    fingerprint: candidate.fingerprint,
    size: candidate.file.size,
    importedAt: now,
    lastReadAt: now,
    progress: 0,
    textOffset: 0,
  }
}

function readerDocumentCacheKey(book: Pick<Book, 'id' | 'content' | 'chapterRecognition' | 'chapterExclusions' | 'chapterAdditions'>): string {
  const additions = (Array.isArray(book.chapterAdditions) ? book.chapterAdditions : [])
    .map((addition) => `${addition.offset}:${addition.endOffset ?? ''}:${addition.subtitleOffset ?? ''}:${addition.subtitleEndOffset ?? ''}:${addition.title}`)
    .sort()
    .join('|')
  return [book.id, book.content.length, book.chapterRecognition ?? 'auto', [...(book.chapterExclusions ?? [])].sort((a, b) => a - b).join(','), additions].join(':')
}

function rememberReaderDocument(book: Pick<Book, 'id' | 'content' | 'chapterRecognition' | 'chapterExclusions' | 'chapterAdditions'>, document: ReaderDocument): void {
  const key = readerDocumentCacheKey(book)
  readerDocumentCache.delete(key)
  readerDocumentCache.set(key, document)
  while (readerDocumentCache.size > 12) {
    const oldest = readerDocumentCache.keys().next().value
    if (!oldest) break
    readerDocumentCache.delete(oldest)
  }
}

function getCachedReaderDocument(book: Book): ReaderDocument {
  const key = readerDocumentCacheKey(book)
  const cached = readerDocumentCache.get(key)
  if (cached) return cached
  const recognition = book.chapterRecognition ?? 'auto'
  const persistent = readerChapterRecognitionCache.get(book.id)
  const validPersistentCache = persistent
    && persistent.fingerprint === book.fingerprint
    && persistent.contentLength === book.content.length
    && persistent.recognition === recognition
    && persistent.version === CHAPTER_RECOGNITION_VERSION
  const detected = validPersistentCache ? persistent.chapters : detectChapterHeadings(book.content, recognition)
  if (!validPersistentCache) {
    const record: ChapterRecognitionCacheRecord = {
      id: book.id,
      fingerprint: book.fingerprint,
      contentLength: book.content.length,
      recognition,
      version: CHAPTER_RECOGNITION_VERSION,
      chapters: detected,
    }
    readerChapterRecognitionCache.set(book.id, record)
    void saveChapterRecognitionCache(record).catch(() => undefined)
  }
  const parsed = buildReaderBlocks(book.content, recognition, book.chapterExclusions ?? [], Array.isArray(book.chapterAdditions) ? book.chapterAdditions : [], detected)
  rememberReaderDocument(book, parsed)
  return parsed
}

function escapeReaderHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character))
}

function readerTextBoundaryAt(root: HTMLElement, characterOffset: number): { node: Text; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, characterOffset)
  let last: Text | null = null
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    last = node
    if (remaining <= node.data.length) return { node, offset: remaining }
    remaining -= node.data.length
  }
  return last ? { node: last, offset: last.data.length } : null
}

function readerTextRange(root: HTMLElement, start: number, end: number): Range | null {
  const startBoundary = readerTextBoundaryAt(root, start)
  const endBoundary = readerTextBoundaryAt(root, end)
  if (!startBoundary || !endBoundary) return null
  const range = document.createRange()
  range.setStart(startBoundary.node, startBoundary.offset)
  range.setEnd(endBoundary.node, endBoundary.offset)
  return range
}

function readerVisualLineRange(root: HTMLElement, characterOffset: number, minimum: number, maximum: number): { range: Range; start: number; end: number } | null {
  if (maximum <= minimum) return null
  let probe = Math.max(minimum, Math.min(maximum - 1, characterOffset))
  let probeRange = readerTextRange(root, probe, probe + 1)
  let probeRect = probeRange?.getBoundingClientRect()
  if (!probeRange || !probeRect || (!probeRect.width && !probeRect.height)) {
    probe = Math.max(minimum, Math.min(maximum - 1, characterOffset - 1))
    probeRange = readerTextRange(root, probe, probe + 1)
    probeRect = probeRange?.getBoundingClientRect()
  }
  if (!probeRange || !probeRect || (!probeRect.width && !probeRect.height)) return null
  const sameVisualLine = (index: number) => {
    const characterRange = readerTextRange(root, index, index + 1)
    const rect = characterRange?.getBoundingClientRect()
    return Boolean(rect && (rect.width || rect.height) && Math.abs(rect.top - probeRect.top) < Math.max(2, probeRect.height * 0.45))
  }
  let start = probe
  let end = probe + 1
  while (start > minimum && sameVisualLine(start - 1)) start -= 1
  while (end < maximum && sameVisualLine(end)) end += 1
  const range = readerTextRange(root, start, end)
  return range ? { range, start, end } : null
}

function readerHeadingBlockHtml(block: ReaderBlock): string {
    const text = escapeReaderHtml(block.text)
    const offset = String(block.offset)
    const chapterOffset = block.chapterOffset === undefined ? '' : ` data-reader-chapter-offset="${block.chapterOffset}"`
    if (block.type === 'chapter') {
      return `<h2 id="${escapeReaderHtml(block.id)}" class="reader-chapter" data-reader-offset="${offset}"${chapterOffset}>${text}</h2>`
    }
    if (block.type === 'chapter-subtitle') {
      return `<h3 class="reader-chapter-subtitle" data-reader-offset="${offset}"${chapterOffset}>${text}</h3>`
    }
    return `<p class="reader-paragraph" data-reader-offset="${offset}">${text}</p>`
}

const READER_PARAGRAPH_GROUP_SIZE = 8_000
const READER_WINDOW_BEFORE = 100_000
const READER_WINDOW_AFTER = 300_000

function readerBlockWindow(document: ReaderDocument, book: Book, targetOffset: number, direction: -1 | 0 | 1 = 0): ReaderRenderWindow {
  const target = Math.max(0, Math.min(book.content.length, targetOffset))
  const before = direction > 0 ? 40_000 : direction < 0 ? 300_000 : READER_WINDOW_BEFORE
  const after = direction > 0 ? 360_000 : direction < 0 ? 100_000 : READER_WINDOW_AFTER
  const desiredStart = Math.max(0, target - before)
  const desiredEnd = Math.min(book.content.length, target + after)
  const blocks = document.blocks
  let low = 0
  let high = blocks.length - 1
  let startIndex = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (blocks[middle].offset <= desiredStart) {
      startIndex = middle
      low = middle + 1
    } else high = middle - 1
  }
  let endIndex = startIndex
  while (endIndex < blocks.length && blocks[endIndex].offset < desiredEnd) endIndex += 1
  const selected = blocks.slice(startIndex, Math.max(startIndex + 1, endIndex))
  const startOffset = selected[0]?.offset ?? 0
  const last = selected.at(-1)
  const endOffset = last ? Math.min(book.content.length, last.offset + last.text.length + 1) : book.content.length
  return { bookId: book.id, startOffset, endOffset, blocks: selected }
}

function readerBlockWindowFromOffsets(document: ReaderDocument, book: Book, startOffset: number, endOffset: number): ReaderRenderWindow {
  return {
    bookId: book.id,
    startOffset,
    endOffset,
    blocks: document.blocks.filter((block) => block.offset >= startOffset && block.offset < endOffset),
  }
}

function readerParagraphGroupHtml(blocks: ReaderBlock[], paragraphSpacing: number, paragraphIndent: number): string {
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  const separator = '\n'.repeat(paragraphSpacing === 0.3 ? 1 : paragraphSpacing === 0.7 ? 2 : 3)
  const indent = '\u3000'.repeat(Math.max(0, Math.round(paragraphIndent)))
  const text = blocks.map((block) => `${indent}${block.text}`).join(separator)
  const endOffset = last.offset + last.text.length + 1
  return `<p class="reader-paragraph reader-paragraph-group" data-reader-offset="${first.offset}" data-reader-end-offset="${endOffset}">${escapeReaderHtml(text)}</p>`
}

function readerFlatBlocksHtml(blocks: ReaderBlock[], paragraphSpacing: number, paragraphIndent: number): string {
  const html: string[] = []
  let paragraphs: ReaderBlock[] = []
  let paragraphLength = 0
  const flushParagraphs = () => {
    if (!paragraphs.length) return
    html.push(readerParagraphGroupHtml(paragraphs, paragraphSpacing, paragraphIndent))
    paragraphs = []
    paragraphLength = 0
  }
  for (const block of blocks) {
    if (block.type !== 'paragraph') {
      flushParagraphs()
      html.push(readerHeadingBlockHtml(block))
      continue
    }
    if (paragraphs.length && paragraphLength + block.text.length > READER_PARAGRAPH_GROUP_SIZE) flushParagraphs()
    paragraphs.push(block)
    paragraphLength += block.text.length + 1
  }
  flushParagraphs()
  return html.join('')
}

function readerBlocksHtml(blocks: ReaderBlock[], lazyChunks = false, paragraphSpacing = 0.7, paragraphIndent = 2): string {
  if (!lazyChunks) return readerFlatBlocksHtml(blocks, paragraphSpacing, paragraphIndent)
  return chunkReaderBlocks(blocks).map((chunk) => {
    const characterCount = chunk.reduce((total, block) => total + block.text.length, 0)
    const intrinsicHeight = Math.max(720, Math.round(characterCount * 0.72))
    return `<section class="reader-chunk" style="--reader-chunk-height:${intrinsicHeight}px">${readerFlatBlocksHtml(chunk, paragraphSpacing, paragraphIndent)}</section>`
  }).join('')
}

function chunkReaderBlocks(blocks: ReaderBlock[], chunkSize = 48_000): ReaderBlock[][] {
  const chunks: ReaderBlock[][] = [[]]
  let length = 0
  for (const block of blocks) {
    if (length + block.text.length > chunkSize && chunks[chunks.length - 1].length) {
      chunks.push([])
      length = 0
    }
    chunks[chunks.length - 1].push(block)
    length += block.text.length
  }
  return chunks
}

const FONT_OPTIONS = [
  { value: 'serif', label: '宋体' },
  { value: 'heiti', label: '黑体' },
  { value: 'kaiti', label: '楷体' },
  { value: 'yuanti', label: '圆体' },
] as const

const READER_BACKGROUNDS = [
  { value: '#f5f0e7', label: '纸页' },
  { value: '#e7eee3', label: '护眼' },
  { value: '#f2ebe4', label: '暖白' },
  { value: '#171a1b', label: '夜间' },
]

const READER_TEXT_COLORS = [
  { value: '#2e2b26', label: '墨黑' },
  { value: '#475547', label: '深绿' },
  { value: '#5d4740', label: '棕灰' },
  { value: '#d4d0c7', label: '浅灰' },
]

interface HsvColor { h: number; s: number; v: number }

function hexToHsv(hex: string): HsvColor {
  const normalized = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '000000'
  const red = Number.parseInt(normalized.slice(0, 2), 16) / 255
  const green = Number.parseInt(normalized.slice(2, 4), 16) / 255
  const blue = Number.parseInt(normalized.slice(4, 6), 16) / 255
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const delta = maximum - minimum
  let hue = 0
  if (delta) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (maximum === green) hue = 60 * (((blue - red) / delta) + 2)
    else hue = 60 * (((red - green) / delta) + 4)
  }
  if (hue < 0) hue += 360
  return { h: hue, s: maximum ? delta / maximum : 0, v: maximum }
}

function hsvToHex({ h, s, v }: HsvColor): string {
  const chroma = v * s
  const section = h / 60
  const intermediate = chroma * (1 - Math.abs((section % 2) - 1))
  const offset = v - chroma
  let red = 0
  let green = 0
  let blue = 0
  if (section < 1) [red, green, blue] = [chroma, intermediate, 0]
  else if (section < 2) [red, green, blue] = [intermediate, chroma, 0]
  else if (section < 3) [red, green, blue] = [0, chroma, intermediate]
  else if (section < 4) [red, green, blue] = [0, intermediate, chroma]
  else if (section < 5) [red, green, blue] = [intermediate, 0, chroma]
  else [red, green, blue] = [chroma, 0, intermediate]
  return `#${[red, green, blue].map((value) => Math.round((value + offset) * 255).toString(16).padStart(2, '0')).join('')}`
}

function ReaderPreferences({
  settings,
  fontLabel,
  onUpdate,
  onTheme,
  onOpenFonts,
}: {
  settings: ReaderSettings
  fontLabel: string
  onUpdate: (patch: Partial<ReaderSettings>) => Promise<void>
  onTheme: (theme: ReaderTheme) => Promise<void>
  onOpenFonts: () => void
}) {
  const [paletteTarget, setPaletteTarget] = useState<'background' | 'text' | null>(null)
  const [paletteHsv, setPaletteHsv] = useState<HsvColor>(() => hexToHsv(settings.backgroundColor))

  function setBackground(value: string) {
    const preset = value === '#171a1b' ? 'night' : value === '#e7eee3' ? 'green' : 'paper'
    if (value === '#f5f0e7' || value === '#e7eee3' || value === '#171a1b') {
      void onTheme(preset)
    } else {
      void onUpdate({ backgroundColor: value, theme: preset })
    }
  }

  function setPaletteColor(value: string) {
    setPaletteHsv(hexToHsv(value))
    if (paletteTarget === 'background') setBackground(value)
    if (paletteTarget === 'text') void onUpdate({ textColor: value })
  }

  function togglePalette(target: 'background' | 'text') {
    if (paletteTarget === target) {
      setPaletteTarget(null)
      return
    }
    setPaletteHsv(hexToHsv(target === 'background' ? settings.backgroundColor : settings.textColor))
    setPaletteTarget(target)
  }

  function updateSpectrum(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const saturation = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
    const value = 1 - Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
    setPaletteHsv((current) => ({ ...current, s: saturation, v: value }))
  }

  function updateHue(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
    setPaletteHsv((current) => ({ ...current, h: ratio * 359.999 }))
  }

  function saveCurrentColor() {
    const value = hsvToHex(paletteHsv).toLowerCase()
    if (settings.commonColors.includes(value)) return
    void onUpdate({ commonColors: [...settings.commonColors, value].slice(-12) })
  }

  function removeCommonColor(value: string) {
    void onUpdate({ commonColors: settings.commonColors.filter((color) => color !== value) })
  }

  const activePaletteColor = hsvToHex(paletteHsv)

  return (
    <div className="reader-preferences">
      <section className="reader-settings-group">
        <div className="setting-row"><span>字号</span><div className="stepper"><button disabled={settings.fontSize <= 14} onClick={() => void onUpdate({ fontSize: settings.fontSize - 1 })}>A−</button><strong>{settings.fontSize}</strong><button disabled={settings.fontSize >= 32} onClick={() => void onUpdate({ fontSize: settings.fontSize + 1 })}>A+</button></div></div>
        <div className="setting-row compact-setting-row"><span>行间距</span><div className="segmented">{[1.5, 1.8, 1.9, 2.2].map((value) => <button className={settings.lineHeight === value ? 'active' : ''} key={value} onClick={() => void onUpdate({ lineHeight: value })}>{value}</button>)}</div></div>
        <div className="setting-row compact-setting-row"><span>段间距</span><div className="segmented">{([0.3, 0.7, 1.1] as const).map((value) => <button className={settings.paragraphSpacing === value ? 'active' : ''} key={value} onClick={() => void onUpdate({ paragraphSpacing: value })}>{value === 0.3 ? '窄' : value === 0.7 ? '适中' : '宽'}</button>)}</div></div>
        <div className="setting-row compact-setting-row"><span>段首缩进</span><div className="segmented">{([0, 2, 4] as const).map((value) => <button className={settings.paragraphIndent === value ? 'active' : ''} key={value} onClick={() => void onUpdate({ paragraphIndent: value })}>{value === 0 ? '无' : `${value} 字`}</button>)}</div></div>
        <div className="setting-row compact-setting-row"><span>页边距</span><div className="segmented">{([16, 24, 36] as const).map((value) => <button className={settings.pageMargin === value ? 'active' : ''} key={value} onClick={() => void onUpdate({ pageMargin: value })}>{value === 16 ? '窄' : value === 24 ? '适中' : '宽'}</button>)}</div></div>
        <div className="setting-row compact-setting-row"><span>翻页方式</span><div className="segmented"><button className={settings.pageTurnMode === 'scroll' ? 'active' : ''} onClick={() => void onUpdate({ pageTurnMode: 'scroll' })}>上下滚动</button><button className={settings.pageTurnMode === 'horizontal' ? 'active' : ''} onClick={() => void onUpdate({ pageTurnMode: 'horizontal' })}>左右翻页</button></div></div>
      </section>
      <section className="reader-settings-group">
        <div className="setting-row font-select-row"><span>字体</span><button className="font-picker-button" disabled={settings.followSystemFont} onClick={onOpenFonts}>{fontLabel}<Icon name="back" size={15} /></button></div>
        <label className="toggle-row"><span><strong>跟随系统字体</strong><small>使用手机当前的系统字体</small></span><input type="checkbox" checked={settings.followSystemFont} onChange={(event) => void onUpdate({ followSystemFont: event.target.checked })} /><i aria-hidden="true" /></label>
        <div className="color-setting"><span>阅读背景</span><div className="color-options">{READER_BACKGROUNDS.map(({ value, label }) => <button key={value} title={label} aria-label={`${label}背景`} className={settings.backgroundColor.toLowerCase() === value ? 'active' : ''} style={{ background: value }} onClick={() => { if (paletteTarget === 'background') setPaletteHsv(hexToHsv(value)); setBackground(value) }} />)}<button className={`color-palette-toggle ${paletteTarget === 'background' ? 'active' : ''}`} title="打开背景色板" aria-label="打开背景色板" aria-expanded={paletteTarget === 'background'} style={{ '--current-color': settings.backgroundColor } as React.CSSProperties} onClick={() => togglePalette('background')}><Icon name="grid-more" size={16} /></button></div></div>
        <div className="color-setting"><span>文字颜色</span><div className="color-options">{READER_TEXT_COLORS.map(({ value, label }) => <button key={value} title={label} aria-label={`${label}文字`} className={settings.textColor.toLowerCase() === value ? 'active' : ''} style={{ background: value }} onClick={() => { if (paletteTarget === 'text') setPaletteHsv(hexToHsv(value)); void onUpdate({ textColor: value }) }} />)}<button className={`color-palette-toggle ${paletteTarget === 'text' ? 'active' : ''}`} title="打开文字色板" aria-label="打开文字色板" aria-expanded={paletteTarget === 'text'} style={{ '--current-color': settings.textColor } as React.CSSProperties} onClick={() => togglePalette('text')}><Icon name="grid-more" size={16} /></button></div></div>
        {paletteTarget && createPortal(<div
          className="color-palette-float-backdrop"
          style={{
            '--reader-bg': settings.backgroundColor,
            '--reader-ink': settings.textColor,
            '--reader-muted': settings.theme === 'night' ? '#9da19d' : '#74746d',
          } as React.CSSProperties}
          onPointerDown={(event) => { if (event.target === event.currentTarget) setPaletteTarget(null) }}
        ><section className="color-palette-panel" role="dialog" aria-modal="true" aria-label={paletteTarget === 'background' ? '背景色板' : '文字色板'}>
          <div className="color-palette-heading"><span>{paletteTarget === 'background' ? '背景色板' : '文字色板'}</span><button disabled={settings.commonColors.includes(activePaletteColor.toLowerCase())} onClick={saveCurrentColor}><Icon name="plus" size={14} />加入常用颜色</button></div>
          <div
            className="continuous-color-board"
            role="slider"
            aria-label="在色板中选择颜色"
            aria-valuetext={activePaletteColor}
            style={{ '--picker-hue': `${paletteHsv.h}`, '--picker-x': `${paletteHsv.s * 100}%`, '--picker-y': `${(1 - paletteHsv.v) * 100}%` } as React.CSSProperties}
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateSpectrum(event) }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateSpectrum(event) }}
            onPointerUp={(event) => { updateSpectrum(event); event.currentTarget.releasePointerCapture(event.pointerId) }}
            onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
          ><i aria-hidden="true" /></div>
          <div
            className="continuous-hue-bar"
            role="slider"
            aria-label="选择色相"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(paletteHsv.h)}
            style={{ '--hue-position': `${(paletteHsv.h / 360) * 100}%` } as React.CSSProperties}
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateHue(event) }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateHue(event) }}
            onPointerUp={(event) => { updateHue(event); event.currentTarget.releasePointerCapture(event.pointerId) }}
            onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
          ><i aria-hidden="true" /></div>
          <div
            className="color-preview-card"
            style={{
              background: paletteTarget === 'background' ? activePaletteColor : settings.backgroundColor,
              color: paletteTarget === 'text' ? activePaletteColor : settings.textColor,
            }}
          ><span>颜色预览</span><code>{activePaletteColor.toUpperCase()}</code></div>
          {settings.commonColors.length > 0 && <><p className="common-color-label">常用颜色</p><div className="common-color-list">{settings.commonColors.map((value) => <span className="common-color-item" key={value}><button className={activePaletteColor.toLowerCase() === value ? 'active' : ''} title={value} aria-label={`使用常用颜色 ${value}`} style={{ background: value }} onClick={() => setPaletteColor(value)} /><button className="common-color-remove" title="移除常用颜色" aria-label={`移除常用颜色 ${value}`} onClick={() => removeCommonColor(value)}><Icon name="close" size={11} /></button></span>)}</div></>}
        </section></div>, document.body)}
      </section>
      <section className="reader-settings-group reader-settings-last-group">
        <div className="setting-row compact-setting-row"><span>进度显示</span><div className="segmented"><button className={settings.progressDisplay === 'percent' ? 'active' : ''} onClick={() => void onUpdate({ progressDisplay: 'percent' })}>百分比</button><button className={settings.progressDisplay === 'page' ? 'active' : ''} onClick={() => void onUpdate({ progressDisplay: 'page' })}>页数</button></div></div>
      </section>
    </div>
  )
}

export default function App() {
  const [books, setBooks] = useState<Book[]>([])
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([])
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [view, setView] = useState<View>('shelf')
  const [mainTab, setMainTab] = useState<MainTab>('shelf')
  const [activeBookId, setActiveBookId] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const searchFieldRef = useRef<HTMLDivElement>(null)
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowserState | null>(null)
  const [folderSearchQuery, setFolderSearchQuery] = useState('')
  const [scanningFolderId, setScanningFolderId] = useState<string | null>(null)
  const [selectedFolderFiles, setSelectedFolderFiles] = useState<string[]>([])
  const [restorePayload, setRestorePayload] = useState<BackupPayload | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Book | null>(null)
  const [batchDeleteCandidates, setBatchDeleteCandidates] = useState<Book[]>([])
  const [batchChapterSuggestion, setBatchChapterSuggestion] = useState<BatchChapterSuggestion | null>(null)
  const [bookActionCandidate, setBookActionCandidate] = useState<Book | null>(null)
  const [selectedBookIds, setSelectedBookIds] = useState<string[]>([])
  const [bookName, setBookName] = useState('')
  const [bookNameError, setBookNameError] = useState('')
  const [renameBookReturnToGroup, setRenameBookReturnToGroup] = useState(false)
  const [fontPickerReturnSheet, setFontPickerReturnSheet] = useState<'settings' | null>(null)
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null)
  const [groupBatchAddTargetId, setGroupBatchAddTargetId] = useState<string | null>(null)
  const [draggedBookId, setDraggedBookId] = useState<string | null>(null)
  const [dropGroupId, setDropGroupId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null)
  const [groupName, setGroupName] = useState('')
  const [groupNameError, setGroupNameError] = useState('')
  const [readerChromeVisible, setReaderChromeVisible] = useState(true)
  const [readerClock, setReaderClock] = useState(() => formatClock(new Date()))
  const [readerPages, setReaderPages] = useState(1)
  const [readerCurrentPage, setReaderCurrentPage] = useState(1)
  const [readerPositionReady, setReaderPositionReady] = useState(false)
  const [tocDeleteCandidate, setTocDeleteCandidate] = useState<Chapter | null>(null)
  const [tocRecognizing, setTocRecognizing] = useState(false)
  const [tocMutation, setTocMutation] = useState<'delete' | 'add' | null>(null)
  const [tocScrollTop, setTocScrollTop] = useState(0)
  const [tocViewportHeight, setTocViewportHeight] = useState(480)
  const [tocScrollbarDragging, setTocScrollbarDragging] = useState(false)
  const [tocScrollbarVisible, setTocScrollbarVisible] = useState(false)
  const [readerTextSelection, setReaderTextSelection] = useState<ReaderTextSelection | null>(null)
  const [progressInput, setProgressInput] = useState('')
  const [busy, setBusy] = useState(true)
  const [activityMessage, setActivityMessage] = useState<string | null>(null)
  const [libraryReady, setLibraryReady] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const txtInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const customFontInputRef = useRef<HTMLInputElement>(null)
  const progressInputRef = useRef<HTMLInputElement>(null)
  const readerSelectionToolbarRef = useRef<HTMLDivElement>(null)
  const readerSelectionInitializedRef = useRef(false)
  const readerRef = useRef<HTMLDivElement>(null)
  const scanningFolderRef = useRef<string | null>(null)
  const zipTextScanCacheRef = useRef(new Map<string, boolean>())
  const pendingExternalFileUriRef = useRef<string | null>(null)
  const importingExternalFileUrisRef = useRef(new Set<string>())
  const tocListRef = useRef<HTMLDivElement>(null)
  const tocScrollbarTrackRef = useRef<HTMLDivElement>(null)
  const readerPageHeightRef = useRef(0)
  const readerPageWidthRef = useRef(0)
  const readerPaginationKeyRef = useRef('')
  const readerPaginationPagesRef = useRef(1)
  const saveTimer = useRef<number | null>(null)
  const progressSaveChain = useRef<Promise<void>>(Promise.resolve())
  const readerGestureRef = useRef<ReaderGesture | null>(null)
  const suppressReaderClick = useRef(false)
  const readerPageTargetRef = useRef<number | null>(null)
  const readerRestoreRef = useRef(false)
  const readerResumeWithoutRestoreRef = useRef(false)
  const pendingReaderRestoreRef = useRef<PendingReaderRestore | null>(null)
  const readerRestoreTokenRef = useRef(0)
  const readerRestoreFrameRef = useRef<number | null>(null)
  const readerPageSettleTimerRef = useRef<number | null>(null)
  const readerProgressUiTimerRef = useRef<number | null>(null)
  const readerSnapshotTimerRef = useRef<number | null>(null)
  const readerScrollFrameRef = useRef<number | null>(null)
  const readerLocationIndexRef = useRef<{ key: string; element: HTMLDivElement; blocks: HTMLElement[] } | null>(null)
  const readerRenderWindowRef = useRef<ReaderRenderWindow | null>(null)
  const tocScrollFrameRef = useRef<number | null>(null)
  const tocLatestScrollTopRef = useRef(0)
  const tocScrollbarDragRef = useRef<{ pointerId: number; grabOffset: number } | null>(null)
  const tocScrollbarHideTimerRef = useRef<number | null>(null)
  const activeBookRef = useRef<Book | null>(null)
  const flushReaderProgressRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const nativeBarsRequestRef = useRef(0)
  const nativeBarsChainRef = useRef<Promise<void>>(Promise.resolve())
  const readerUiStateRef = useRef({
    view,
    mainTab,
    readerChromeVisible,
    folderBrowser,
    restorePayload,
    batchDeleteCandidates,
    batchChapterSuggestion,
    deleteCandidate,
    sheet,
    renameBookReturnToGroup,
    groupBatchAddTargetId,
    fontPickerReturnSheet,
  })
  const longPressTimer = useRef<number | null>(null)
  const longPressed = useRef(false)
  const suppressBookClick = useRef(false)
  const pressOrigin = useRef<{ x: number; y: number } | null>(null)
  const draggedBookRef = useRef<string | null>(null)
  const customFontFaces = useRef(new Map<string, FontFace>())
  const tocLongPressTimer = useRef<number | null>(null)
  const tocLongPressed = useRef(false)

  const activeBook = useMemo(
    () => books.find((book) => book.id === activeBookId) ?? null,
    [books, activeBookId],
  )
  useEffect(() => { activeBookRef.current = activeBook }, [activeBook])
  readerUiStateRef.current = {
    view,
    mainTab,
    readerChromeVisible,
    folderBrowser,
    restorePayload,
    batchDeleteCandidates,
    batchChapterSuggestion,
    deleteCandidate,
    sheet,
    renameBookReturnToGroup,
    groupBatchAddTargetId,
    fontPickerReturnSheet,
  }

  useEffect(() => {
    if (!isNativeAndroid()) return
    document.documentElement.classList.add('native-android')
    return () => document.documentElement.classList.remove('native-android')
  }, [])

  useEffect(() => {
    if (!searchOpen) return
    const closeSearchOnOutsidePointer = (event: PointerEvent) => {
      const field = searchFieldRef.current
      if (field && !field.contains(event.target as Node) && !searchQuery.trim()) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeSearchOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', closeSearchOnOutsidePointer, true)
  }, [searchOpen, searchQuery])

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let frame = 0
    const updateKeyboardInset = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
        document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`)
        document.documentElement.style.setProperty('--visual-viewport-height', `${Math.round(viewport.height)}px`)
        document.documentElement.style.setProperty('--visual-viewport-top', `${Math.round(viewport.offsetTop)}px`)
        if (inset > 80 && document.activeElement instanceof HTMLElement) {
          document.activeElement.scrollIntoView({ block: 'center', behavior: 'auto' })
        }
      })
    }
    viewport.addEventListener('resize', updateKeyboardInset)
    viewport.addEventListener('scroll', updateKeyboardInset)
    window.addEventListener('resize', updateKeyboardInset)
    updateKeyboardInset()
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', updateKeyboardInset)
      viewport.removeEventListener('scroll', updateKeyboardInset)
      window.removeEventListener('resize', updateKeyboardInset)
      document.documentElement.style.setProperty('--keyboard-inset', '0px')
      document.documentElement.style.removeProperty('--visual-viewport-height')
      document.documentElement.style.removeProperty('--visual-viewport-top')
    }
  }, [])
  const readerDocument = useMemo(
    () => activeBook
      ? getCachedReaderDocument(activeBook)
      : buildReaderBlocks('（这是一个空文件）'),
    [activeBook?.id, activeBook?.content, activeBook?.chapterRecognition, activeBook?.chapterExclusions, activeBook?.chapterAdditions],
  )
  const activeChapterIndex = useMemo(() => {
    const offset = activeBook?.textOffset ?? 0
    const chapters = readerDocument.chapters
    let low = 0
    let high = chapters.length - 1
    let found = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (chapters[middle].offset <= offset) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    return found
  }, [activeBook?.textOffset, readerDocument.chapters])
  const activeChapter = activeChapterIndex >= 0 ? readerDocument.chapters[activeChapterIndex] : null
  const tocTotalRows = readerDocument.chapters.length + 1
  const tocStartRow = Math.max(0, Math.floor(tocScrollTop / TOC_ROW_HEIGHT) - TOC_OVERSCAN_ROWS)
  const tocEndRow = Math.min(tocTotalRows, Math.ceil((tocScrollTop + tocViewportHeight) / TOC_ROW_HEIGHT) + TOC_OVERSCAN_ROWS)
  const tocContentHeight = tocTotalRows * TOC_ROW_HEIGHT + 28
  const tocMaxScroll = Math.max(0, tocContentHeight - tocViewportHeight)
  const tocScrollbarTrackHeight = Math.max(1, tocViewportHeight - 8)
  const tocScrollbarThumbHeight = Math.min(tocScrollbarTrackHeight, 32)
  const tocScrollbarTravel = Math.max(0, tocScrollbarTrackHeight - tocScrollbarThumbHeight)
  const tocScrollbarThumbTop = tocMaxScroll ? Math.min(tocScrollbarTravel, tocScrollTop / tocMaxScroll * tocScrollbarTravel) : 0
  useEffect(() => {
    if (sheet !== 'toc') return
    const list = tocListRef.current
    if (!list) return
    const updateViewportHeight = () => setTocViewportHeight(Math.max(1, list.clientHeight))
    const observer = new ResizeObserver(updateViewportHeight)
    observer.observe(list)
    const frame = requestAnimationFrame(() => {
      const viewportHeight = Math.max(1, list.clientHeight)
      const targetRow = Math.max(0, activeChapterIndex + 1)
      const targetTop = Math.max(0, targetRow * TOC_ROW_HEIGHT - (viewportHeight - TOC_ROW_HEIGHT) / 2)
      setTocViewportHeight(viewportHeight)
      setTocScrollTop(targetTop)
      tocLatestScrollTopRef.current = targetTop
      list.scrollTo({ top: targetTop, behavior: 'auto' })
    })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      tocScrollbarDragRef.current = null
      if (tocScrollbarHideTimerRef.current !== null) window.clearTimeout(tocScrollbarHideTimerRef.current)
      tocScrollbarHideTimerRef.current = null
      setTocScrollbarDragging(false)
      setTocScrollbarVisible(false)
    }
  }, [sheet])
  useEffect(() => {
    if (sheet !== 'toc') setTocDeleteCandidate(null)
  }, [sheet])
  useEffect(() => {
    if (view !== 'reader' || !activeBook) {
      readerSelectionInitializedRef.current = false
      setReaderTextSelection(null)
      return
    }
    const captureSelection = () => {
      const selection = window.getSelection()
      const root = readerRef.current
      if (!selection || selection.rangeCount === 0 || !root || selection.isCollapsed) {
        readerSelectionInitializedRef.current = false
        setReaderTextSelection(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) {
        readerSelectionInitializedRef.current = false
        setReaderTextSelection(null)
        return
      }
      const blockForBoundary = (container: Node) => (container.nodeType === Node.ELEMENT_NODE
        ? container as HTMLElement
        : container.parentElement)?.closest<HTMLElement>('[data-reader-offset]') ?? null
      const startBlock = blockForBoundary(range.startContainer)
      const endBlock = blockForBoundary(range.endContainer)
      const selectedSource = selection.toString().trim()
      let offset = Number(startBlock?.dataset.readerOffset)
      let endOffset = offset
      let activeRange: Range | null = null
      const separatorLength = settings.paragraphSpacing === 0.3 ? 1 : settings.paragraphSpacing === 0.7 ? 2 : 3
      const indentLength = Math.max(0, Math.round(settings.paragraphIndent))
      const renderedBoundaryIndex = (block: HTMLElement, container: Node, boundaryOffset: number) => {
        const prefix = document.createRange()
        prefix.selectNodeContents(block)
        prefix.setEnd(container, boundaryOffset)
        return prefix.toString().length
      }
      const sourceBoundaryOffset = (block: HTMLElement, renderedIndex: number, side: 'start' | 'end') => {
        const blockStart = Number(block.dataset.readerOffset)
        if (!block.classList.contains('reader-paragraph-group')) {
          const renderedText = block.textContent ?? ''
          const sourceLineEnd = activeBook.content.indexOf('\n', blockStart)
          const sourceLine = activeBook.content.slice(blockStart, sourceLineEnd < 0 ? activeBook.content.length : sourceLineEnd)
          const textStart = Math.max(0, sourceLine.indexOf(renderedText))
          return blockStart + textStart + Math.max(0, Math.min(renderedText.length, renderedIndex))
        }
        const blockEnd = Number(block.dataset.readerEndOffset) || activeBook.content.length
        const groupedBlocks = readerRenderWindowRef.current?.blocks.filter((item) =>
          item.type === 'paragraph' && item.offset >= blockStart && item.offset < blockEnd) ?? []
        let renderedOffset = 0
        for (let index = 0; index < groupedBlocks.length; index += 1) {
          const item = groupedBlocks[index]
          const lineStart = renderedOffset + indentLength
          const lineEnd = lineStart + item.text.length
          if (renderedIndex <= lineEnd) return item.offset + Math.max(0, Math.min(item.text.length, renderedIndex - lineStart))
          const separatorEnd = lineEnd + separatorLength
          if (renderedIndex < separatorEnd) {
            return side === 'start' ? (groupedBlocks[index + 1]?.offset ?? item.offset + item.text.length) : item.offset + item.text.length
          }
          renderedOffset = separatorEnd
        }
        const last = groupedBlocks.at(-1)
        return last ? last.offset + last.text.length : blockStart
      }
      if (!readerSelectionInitializedRef.current && startBlock?.classList.contains('reader-paragraph-group') && selectedSource) {
        const blockStart = offset
        const blockEnd = Number(startBlock.dataset.readerEndOffset) || activeBook.content.length
        const prefixRange = document.createRange()
        prefixRange.selectNodeContents(startBlock)
        prefixRange.setEnd(range.startContainer, range.startOffset)
        const selectionStart = prefixRange.toString().length
        const groupedBlocks = readerRenderWindowRef.current?.blocks.filter((item) =>
          item.type === 'paragraph' && item.offset >= blockStart && item.offset < blockEnd) ?? []
        let renderedOffset = 0
        for (const item of groupedBlocks) {
          const lineStart = renderedOffset + indentLength
          const lineEnd = lineStart + item.text.length
          if (selectionStart <= lineEnd) {
            const leadingSpace = item.text.length - item.text.trimStart().length
            const trailingSpace = item.text.length - item.text.trimEnd().length
            const contentStart = lineStart + leadingSpace
            const contentEnd = Math.max(contentStart, lineEnd - trailingSpace)
            const visualLine = readerVisualLineRange(startBlock, selectionStart, contentStart, contentEnd)
            if (visualLine) {
              offset = item.offset + visualLine.start - lineStart
              endOffset = item.offset + visualLine.end - lineStart
              activeRange = visualLine.range
            }
            break
          }
          renderedOffset = lineEnd + separatorLength
        }
      } else if (!readerSelectionInitializedRef.current && startBlock && selectedSource) {
        const blockText = startBlock.textContent ?? ''
        const leadingSpace = blockText.length - blockText.trimStart().length
        const trailingSpace = blockText.length - blockText.trimEnd().length
        const prefixRange = document.createRange()
        prefixRange.selectNodeContents(startBlock)
        prefixRange.setEnd(range.startContainer, range.startOffset)
        const visualLine = readerVisualLineRange(startBlock, prefixRange.toString().length, leadingSpace, Math.max(leadingSpace, blockText.length - trailingSpace))
        if (visualLine) {
          offset += visualLine.start
          endOffset = Number(startBlock.dataset.readerOffset) + visualLine.end
          activeRange = visualLine.range
        }
      } else if (startBlock && endBlock && selectedSource) {
        offset = sourceBoundaryOffset(startBlock, renderedBoundaryIndex(startBlock, range.startContainer, range.startOffset), 'start')
        endOffset = sourceBoundaryOffset(endBlock, renderedBoundaryIndex(endBlock, range.endContainer, range.endOffset), 'end')
        activeRange = range
      }
      if (!startBlock || !endBlock || !selectedSource || !Number.isFinite(offset) || !Number.isFinite(endOffset) || endOffset <= offset || !activeRange || activeRange.collapsed) {
        setReaderTextSelection(null)
        return
      }
      if (!readerSelectionInitializedRef.current) {
        readerSelectionInitializedRef.current = true
        selection.removeAllRanges()
        selection.addRange(activeRange)
      }
      const sourceText = activeBook.content.slice(offset, endOffset)
      const leadingWhitespace = sourceText.match(/^\s+/u)?.[0].length ?? 0
      const trailingWhitespace = sourceText.match(/\s+$/u)?.[0].length ?? 0
      offset += leadingWhitespace
      endOffset -= trailingWhitespace
      const rect = activeRange.getBoundingClientRect()
      if (!rect.width && !rect.height) {
        setReaderTextSelection(null)
        return
      }
      const title = activeBook.content.slice(offset, endOffset).replace(/\s+/g, ' ')
      const left = Math.max(70, Math.min(window.innerWidth - 70, rect.left + rect.width / 2))
      const top = Math.min(window.innerHeight - 52, rect.bottom + 12)
      setReaderTextSelection({ title, offset, endOffset, left, top })
    }
    document.addEventListener('selectionchange', captureSelection)
    return () => {
      readerSelectionInitializedRef.current = false
      document.removeEventListener('selectionchange', captureSelection)
    }
  }, [view, activeBook?.id, settings.paragraphSpacing, settings.paragraphIndent])
  useEffect(() => {
    if (!readerTextSelection) return
    const dismissSelectionToolbar = (event: PointerEvent) => {
      if (readerSelectionToolbarRef.current?.contains(event.target as Node)) return
      if (readerRef.current?.contains(event.target as Node)) {
        window.setTimeout(() => {
          if (window.getSelection()?.isCollapsed) {
            readerSelectionInitializedRef.current = false
            setReaderTextSelection(null)
          }
        }, 0)
        return
      }
      window.getSelection()?.removeAllRanges()
      readerSelectionInitializedRef.current = false
      setReaderTextSelection(null)
    }
    document.addEventListener('pointerdown', dismissSelectionToolbar, true)
    return () => document.removeEventListener('pointerdown', dismissSelectionToolbar, true)
  }, [readerTextSelection])
  const filteredBooks = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    return books
      .filter((book) => (!query || book.title.toLocaleLowerCase().includes(query)) && matchesShelfFilter(book, settings.shelfFilter))
      .sort((left, right) => compareShelfBooks(left, right, settings.shelfSort))
  }, [books, searchQuery, settings.shelfFilter, settings.shelfSort])
  const shelfGroups = useMemo<ShelfGroup[]>(() => settings.bookGroups
    .map((group) => {
      const groupBooks = books.filter((book) => book.groupId === group.id)
      return { ...group, books: groupBooks.sort((left, right) => compareShelfBooks(left, right, settings.shelfSort)), lastActiveAt: groupBooks.reduce((latest, book) => Math.max(latest, book.lastReadAt), group.createdAt) }
    })
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt), [books, settings.bookGroups, settings.shelfSort])
  const shelfItems = useMemo<ShelfItem[]>(() => {
    const filteredBookIds = new Set(filteredBooks.map((book) => book.id))
    const ungrouped = filteredBooks.filter((book) => !book.groupId)
    const hasBookFilter = Boolean(searchQuery.trim()) || settings.shelfFilter !== 'all'
    const groups = shelfGroups
      .map((group) => ({ ...group, books: hasBookFilter ? group.books.filter((book) => filteredBookIds.has(book.id)) : group.books }))
      .filter((group) => !hasBookFilter || group.books.length > 0)
    return [...ungrouped.map((book) => ({ kind: 'book' as const, book })), ...groups.map((group) => ({ kind: 'group' as const, group }))]
      .sort((left, right) => compareShelfItems(left, right, settings.shelfSort))
  }, [filteredBooks, searchQuery, settings.shelfFilter, settings.shelfSort, shelfGroups])
  const activeGroup = useMemo(() => {
    const group = shelfGroups.find((item) => item.id === activeGroupId)
    if (!group) return null
    const query = searchQuery.trim().toLocaleLowerCase()
    return query
      ? { ...group, books: group.books.filter((book) => book.title.toLocaleLowerCase().includes(query)) }
      : group
  }, [activeGroupId, searchQuery, shelfGroups])
  const selectedBooks = useMemo(() => {
    const selected = new Set(selectedBookIds)
    return books.filter((book) => selected.has(book.id))
  }, [books, selectedBookIds])
  const selectedGroupBooks = useMemo(
    () => selectedBooks.filter((book) => book.groupId === activeGroupId),
    [activeGroupId, selectedBooks],
  )
  const groupBatchAddTarget = useMemo(
    () => settings.bookGroups.find((group) => group.id === groupBatchAddTargetId) ?? null,
    [groupBatchAddTargetId, settings.bookGroups],
  )
  const selectableFolderFileIds = folderBrowser
    ? folderBrowser.files.filter((file) => !isFolderFileImported(file)).map(folderFileId)
    : []
  const normalizedFolderSearchQuery = folderSearchQuery.trim().toLocaleLowerCase()
  const visibleFolderFiles = folderBrowser
    ? folderBrowser.files.filter((file) => {
      if (!normalizedFolderSearchQuery) return true
      return `${file.name} ${file.relativePath || ''}`.toLocaleLowerCase().includes(normalizedFolderSearchQuery)
    })
    : []
  const visibleFolderFileGroups = useMemo(() => {
    if (folderBrowser?.archiveReader) return visibleFolderFiles.length ? [{ label: '', files: visibleFolderFiles }] : []
    const groups: Array<{ label: string; files: FolderFile[] }> = []
    for (const file of visibleFolderFiles) {
      const label = folderDateGroupLabel(file.modifiedAt)
      const existing = groups.find((group) => group.label === label)
      if (existing) existing.files.push(file)
      else groups.push({ label, files: [file] })
    }
    return groups
  }, [folderBrowser?.archiveReader, visibleFolderFiles])
  const allFolderFilesSelected = selectableFolderFileIds.length > 0
    && selectableFolderFileIds.every((id) => selectedFolderFiles.includes(id))
  const activeFontLabel = FONT_OPTIONS.find((option) => option.value === settings.fontFamily)?.label
    ?? customFonts.find((font) => customFontValue(font.id) === settings.fontFamily)?.name
    ?? '宋体'
  useEffect(() => {
    Promise.all([getBooks(), getSettings(), getCustomFonts(), getChapterRecognitionCaches()])
      .then(async ([storedBooks, storedSettings, storedFonts, storedChapterCaches]) => {
        readerChapterRecognitionCache.clear()
        for (const cache of storedChapterCaches) readerChapterRecognitionCache.set(cache.id, cache)
        const loadedFonts = await activateCustomFonts(storedFonts)
        const loadedFontIds = new Set(loadedFonts.map((font) => font.id))
        await Promise.all(storedFonts.filter((font) => !loadedFontIds.has(font.id)).map((font) => deleteCustomFont(font.id)))
        let nextSettings = storedSettings
        const selectedFontId = customFontId(storedSettings.fontFamily)
        if (selectedFontId && !loadedFonts.some((font) => font.id === selectedFontId)) {
          nextSettings = { ...storedSettings, fontFamily: 'serif' }
          await saveSettings(nextSettings)
        }
        setBooks(storedBooks)
        setSettings(nextSettings)
        const lastBook = storedBooks.find((book) => book.id === nextSettings.lastBookId)
        if (lastBook) {
          const schedule = 'requestIdleCallback' in window
            ? (window as Window & { requestIdleCallback: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback
            : (callback: () => void) => window.setTimeout(callback, 120)
          schedule(() => { void prewarmReaderPagination(lastBook, nextSettings) }, { timeout: 1500 })
        }
      })
      .catch(() => showToast('本地数据读取失败，请刷新后重试。'))
      .finally(() => {
        setLibraryReady(true)
        setBusy(false)
      })
  }, [])

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
  }, [])

  useEffect(() => {
    if (!isNativeAndroid()) return
    let disposed = false
    let removeListener: (() => Promise<void>) | undefined
    const receiveExternalFile = (url: string) => {
      if (!url.startsWith('content://') && !url.startsWith('file://')) return
      if (!libraryReady) {
        pendingExternalFileUriRef.current = url
        return
      }
      void importExternalFile(url)
    }
    if (libraryReady && pendingExternalFileUriRef.current) {
      const pending = pendingExternalFileUriRef.current
      pendingExternalFileUriRef.current = null
      receiveExternalFile(pending)
    }
    void CapacitorApp.getLaunchUrl().then((launch) => {
      if (!disposed && launch?.url) receiveExternalFile(launch.url)
    })
    void CapacitorApp.addListener('appUrlOpen', ({ url }) => receiveExternalFile(url)).then((handle) => {
      if (disposed) void handle.remove()
      else removeListener = handle.remove
    })
    return () => {
      disposed = true
      void removeListener?.()
    }
  }, [libraryReady])

  useEffect(() => {
    if (view !== 'reader') return
    const updateClock = () => setReaderClock(formatClock(new Date()))
    updateClock()
    const timer = window.setInterval(updateClock, 30_000)
    return () => window.clearInterval(timer)
  }, [view])

  useEffect(() => {
    if (view !== 'reader' || !activeBook || !readerRef.current) return
    const element = readerRef.current
    const documentKey = readerDocumentCacheKey(activeBook)
    const existing = element.querySelector<HTMLElement>('.reader-paper')
    const existingStart = Number(existing?.dataset.readerWindowStart)
    const existingEnd = Number(existing?.dataset.readerWindowEnd)
    const targetOffset = activeBook.textOffset || Math.round(activeBook.content.length * activeBook.progress)
    if (existing?.dataset.readerBookId === activeBook.id
      && existing.dataset.readerDocumentKey === documentKey
      && existing.dataset.readerLayoutKey === readerContentLayoutKey(settings)
      && targetOffset >= existingStart
      && targetOffset < existingEnd) {
      readerRenderWindowRef.current = readerBlockWindowFromOffsets(getCachedReaderDocument(activeBook), activeBook, existingStart, existingEnd)
      return
    }
    const hostKey = readerPaginationCacheKey(activeBook, settings, element.clientWidth, element.clientHeight)
    const host = readerPrewarmHosts.get(hostKey)
    const prewarmedPaper = host?.querySelector<HTMLElement>('.reader-paper')
    if (host && prewarmedPaper) {
      host.remove()
      readerPrewarmHosts.delete(hostKey)
      prewarmedPaper.dataset.readerBookId = activeBook.id
      prewarmedPaper.dataset.readerDocumentKey = documentKey
      readerLocationIndexRef.current = null
      element.replaceChildren(prewarmedPaper)
      const prewarmedStart = Number(prewarmedPaper.dataset.readerWindowStart)
      const prewarmedEnd = Number(prewarmedPaper.dataset.readerWindowEnd)
      readerRenderWindowRef.current = readerBlockWindowFromOffsets(getCachedReaderDocument(activeBook), activeBook, prewarmedStart, prewarmedEnd)
      return
    }
    renderReaderWindow(element, activeBook, targetOffset)
  }, [view, activeBook?.id, activeBook?.content, activeBook?.chapterRecognition, activeBook?.chapterExclusions, activeBook?.chapterAdditions, settings.fontSize, settings.lineHeight, settings.paragraphSpacing, settings.paragraphIndent, settings.pageMargin, settings.pageTurnMode, settings.progressDisplay])

  useEffect(() => {
    if (view !== 'reader' || !activeBook || !readerRef.current) return
    const element = readerRef.current
    if (readerResumeWithoutRestoreRef.current) {
      readerResumeWithoutRestoreRef.current = false
      readerRestoreRef.current = false
      pendingReaderRestoreRef.current = null
      setReaderPositionReady(true)
      return
    }
    let cancelled = false
    let frame = 0
    let nestedFrame = 0
    void ensureReaderFontLoaded(settings.fontFamily, settings.followSystemFont).then(() => {
      if (cancelled) return
      frame = requestAnimationFrame(() => {
        nestedFrame = requestAnimationFrame(() => {
          let latest = activeBookRef.current?.id === activeBook.id ? activeBookRef.current : activeBook
          const pending = pendingReaderRestoreRef.current
          if (latest && pending?.bookId === latest.id) latest = bookAtTextOffset(latest, pending.textOffset)
          if (latest) {
            restoreReaderPosition(element, latest, pending?.token)
            setReaderPositionReady(true)
          }
        })
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      cancelAnimationFrame(nestedFrame)
    }
  }, [
    view,
    activeBookId,
    settings.fontSize,
    settings.lineHeight,
    settings.paragraphSpacing,
    settings.paragraphIndent,
    settings.pageMargin,
    settings.fontFamily,
    settings.followSystemFont,
    settings.pageTurnMode,
  ])

  useEffect(() => {
    if (view !== 'reader' || !readerRef.current) return
    const element = readerRef.current
    let layoutReady = false
    const updatePages = () => { if (layoutReady) updateReaderPagination(element) }
    let cancelled = false
    let frame = 0
    void ensureReaderFontLoaded(settings.fontFamily, settings.followSystemFont).then(() => {
      if (cancelled) return
      frame = requestAnimationFrame(() => {
        layoutReady = true
        updateReaderPagination(element)
      })
    })
    const observer = new ResizeObserver(updatePages)
    observer.observe(element)
    window.addEventListener('resize', updatePages)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updatePages)
    }
  }, [view, activeBookId, settings.fontSize, settings.lineHeight, settings.paragraphSpacing, settings.paragraphIndent, settings.pageMargin, settings.fontFamily, settings.followSystemFont, settings.pageTurnMode, settings.progressDisplay])

  useEffect(() => {
    const saveOnBackground = () => {
      if (document.visibilityState === 'hidden') void flushReaderProgressRef.current()
    }
    const saveOnPageHide = () => { void flushReaderProgressRef.current() }
    let removeAppStateListener: (() => Promise<void>) | undefined
    let disposed = false
    document.addEventListener('visibilitychange', saveOnBackground)
    window.addEventListener('pagehide', saveOnPageHide)
    if (isNativeAndroid()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive) void flushReaderProgressRef.current()
      }).then((handle) => {
        if (disposed) void handle.remove()
        else removeAppStateListener = handle.remove
      })
    }
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', saveOnBackground)
      window.removeEventListener('pagehide', saveOnPageHide)
      void removeAppStateListener?.()
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2600)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    const readingFullscreen = view === 'reader' && !readerChromeVisible
    const request = ++nativeBarsRequestRef.current
    const night = view === 'reader' && settings.theme === 'night'
    nativeBarsChainRef.current = nativeBarsChainRef.current
      .catch(() => undefined)
      .then(async () => {
        if (request !== nativeBarsRequestRef.current) return
        await applyNativeStatusBar(night, readingFullscreen, view === 'reader')
      })
  }, [view, settings.theme, readerChromeVisible])

  useEffect(() => {
    if (!isNativeAndroid()) return
    let removeListener: (() => Promise<void>) | undefined
    let disposed = false
    void CapacitorApp.addListener('backButton', () => {
      const current = readerUiStateRef.current
      if (current.view === 'reader' && !current.readerChromeVisible) {
        setReaderChromeVisible(true)
      } else if (current.folderBrowser) {
        void closeFolderBrowser(current.folderBrowser)
      } else if (current.restorePayload) {
        setRestorePayload(null)
      } else if (current.batchDeleteCandidates.length) {
        setBatchDeleteCandidates([])
      } else if (current.batchChapterSuggestion) {
        setBatchChapterSuggestion(null)
      } else if (current.deleteCandidate) {
        setDeleteCandidate(null)
      } else if (current.groupBatchAddTargetId) {
        cancelGroupBatchAdd()
      } else if (current.sheet) {
        if (current.sheet === 'fonts') setSheet(current.fontPickerReturnSheet)
        else if (current.sheet === 'rename-book' && current.renameBookReturnToGroup) {
          setBookActionCandidate(null)
          setRenameBookReturnToGroup(false)
          setSheet('group')
        } else setSheet(null)
      } else if (current.view === 'reader') {
        void flushReaderProgressRef.current()
        setSheet(null)
        setView('shelf')
        setActiveBookId(null)
        setReaderChromeVisible(true)
      } else if (current.mainTab === 'settings') {
        setMainTab('shelf')
        setSearchOpen(false)
        setSearchQuery('')
        setSelectedBookIds([])
      } else {
        void CapacitorApp.minimizeApp()
      }
    }).then((handle) => {
      if (disposed) void handle.remove()
      else removeListener = handle.remove
    })
    return () => {
      disposed = true
      void removeListener?.()
    }
  }, [])

  function showToast(message: string) {
    setToast(message)
  }

  async function closeFolderBrowser(browser: FolderBrowserState | null = folderBrowser): Promise<void> {
    if (browser?.archiveReader) {
      try {
        await browser.archiveReader.close()
      } catch {
        // Closing an already closed reader is harmless.
      }
    }
    if (readerUiStateRef.current.folderBrowser === browser) {
      setFolderBrowser(null)
      setSelectedFolderFiles([])
      setFolderSearchQuery('')
    }
  }

  function closeFontPicker() {
    setSheet(fontPickerReturnSheet)
  }

  async function registerCustomFont(font: CustomFont): Promise<void> {
    const existing = customFontFaces.current.get(font.id)
    if (existing) document.fonts.delete(existing)
    const face = new FontFace(customFontCssFamily(font.id), font.data)
    await face.load()
    document.fonts.add(face)
    customFontFaces.current.set(font.id, face)
  }

  async function activateCustomFonts(fonts: CustomFont[]): Promise<CustomFont[]> {
    const loaded: CustomFont[] = []
    for (const font of fonts) {
      try {
        await registerCustomFont(font)
        loaded.push(font)
      } catch {
        const face = customFontFaces.current.get(font.id)
        if (face) document.fonts.delete(face)
        customFontFaces.current.delete(font.id)
      }
    }
    const activeIds = new Set(loaded.map((font) => font.id))
    for (const [id, face] of customFontFaces.current) {
      if (!activeIds.has(id)) {
        document.fonts.delete(face)
        customFontFaces.current.delete(id)
      }
    }
    setCustomFonts(loaded)
    return loaded
  }

  async function handleCustomFontFile(file: File | undefined) {
    if (!file) return
    setActivityMessage('正在导入字体')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      const prepared = await prepareFontImport(file)
      const name = prepared.displayName
      if (customFonts.some((font) => font.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已导入同名字体。')
      const font: CustomFont = {
        id: crypto.randomUUID(),
        name: name.slice(0, 40),
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        data: prepared.data,
        importedAt: Date.now(),
      }
      await registerCustomFont(font)
      await saveCustomFont(font)
      setCustomFonts((current) => [...current, font])
      showToast(`已导入字体“${font.name}”。`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '字体导入失败。')
    } finally {
      setActivityMessage(null)
      if (customFontInputRef.current) customFontInputRef.current.value = ''
    }
  }

  async function removeCustomFont(font: CustomFont) {
    await deleteCustomFont(font.id)
    const face = customFontFaces.current.get(font.id)
    if (face) document.fonts.delete(face)
    customFontFaces.current.delete(font.id)
    setCustomFonts((current) => current.filter((item) => item.id !== font.id))
    if (settings.fontFamily === customFontValue(font.id)) await updateSettings({ fontFamily: 'serif' })
    showToast(`已删除字体“${font.name}”。`)
  }

  function toggleBookSelection(bookId: string) {
    setSelectedBookIds((current) => current.includes(bookId)
      ? current.filter((id) => id !== bookId)
      : [...current, bookId])
  }

  async function shareBooks(candidates: Book[]) {
    if (!candidates.length) return
    if (!isNativeAndroid()) {
      showToast('分享文件请在安卓应用中使用。')
      return
    }
    setActivityMessage(candidates.length === 1 ? '正在准备分享书籍' : `正在准备分享 ${candidates.length} 本书`)
    try {
      await shareNativeTextFiles(candidates.map((book) => ({ title: book.title, content: book.content, sourceUri: book.sourceUri, originalName: book.originalName })))
      setSelectedBookIds([])
    } catch (error) {
      showToast(error instanceof Error ? error.message : '分享文件失败，请重试。')
    } finally {
      setActivityMessage(null)
    }
  }

  function clearBookSelectionFromBlank(event: React.MouseEvent<HTMLElement>) {
    if (!selectedBookIds.length) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('button, a, input, select, textarea, label, [contenteditable="true"], .book-card, .group-card, .group-book-card, .bottom-nav, .library-popover')) return
    setSelectedBookIds([])
  }

  function startRenameSelectedBook() {
    if (selectedBooks.length !== 1) return
    const [book] = selectedBooks
    setBookActionCandidate(book)
    setBookName(book.title)
    setBookNameError('')
    setRenameBookReturnToGroup(sheet === 'group')
    setSheet('rename-book')
  }

  function openGroupBatchAdd() {
    if (!activeGroupId) return
    setGroupBatchAddTargetId(activeGroupId)
    setSelectedBookIds([])
    setActiveGroupId(null)
    setSearchOpen(false)
    setSearchQuery('')
    setMainTab('shelf')
    setSheet(null)
  }

  async function addSelectedBooksToActiveGroup() {
    if (!groupBatchAddTargetId || !selectedBooks.length) return
    const selected = new Set(selectedBookIds)
    const changed = books.filter((book) => selected.has(book.id) && book.groupId !== groupBatchAddTargetId)
    if (!changed.length) return
    const nextBooks = books.map((book) => selected.has(book.id) ? { ...book, groupId: groupBatchAddTargetId } : book)
    setBooks(nextBooks)
    setActivityMessage(`正在添加 ${changed.length} 本书到分组`)
    try {
      await Promise.all(changed.map((book) => saveBook({ ...book, groupId: groupBatchAddTargetId })))
      setSelectedBookIds([])
      setGroupBatchAddTargetId(null)
      setSheet(null)
      showToast(`已添加 ${changed.length} 本书到分组。`)
    } finally {
      setActivityMessage(null)
    }
  }

  function cancelGroupBatchAdd() {
    setSelectedBookIds([])
    setGroupBatchAddTargetId(null)
    setActiveGroupId(null)
    setSheet(null)
  }

  async function moveSelectedBooksToGroup(groupId: string | undefined) {
    if (!selectedBooks.length) return
    const selected = new Set(selectedBookIds)
    const changed = books.filter((book) => selected.has(book.id) && book.groupId !== groupId)
    if (!changed.length) return
    const nextBooks = books.map((book) => selected.has(book.id) ? { ...book, groupId } : book)
    setBooks(nextBooks)
    setActivityMessage(`正在移动 ${changed.length} 本书`)
    try {
      await Promise.all(changed.map((book) => saveBook({ ...book, groupId })))
      setSelectedBookIds([])
      setSheet(null)
      showToast(groupId ? `已将 ${changed.length} 本书移入分组。` : `已将 ${changed.length} 本书移回书架。`)
    } finally {
      setActivityMessage(null)
    }
  }

  async function removeSelectedBooksFromActiveGroup() {
    if (!activeGroupId || !selectedGroupBooks.length) return
    const selected = new Set(selectedGroupBooks.map((book) => book.id))
    const nextBooks = books.map((book) => selected.has(book.id) ? { ...book, groupId: undefined } : book)
    setBooks(nextBooks)
    setActivityMessage(`正在移出 ${selectedGroupBooks.length} 本书`)
    try {
      await Promise.all(selectedGroupBooks.map((book) => saveBook({ ...book, groupId: undefined })))
      setSelectedBookIds([])
      showToast(`已将 ${selectedGroupBooks.length} 本书移出分组。`)
    } finally {
      setActivityMessage(null)
    }
  }

  function requestDeleteSelectedBooks() {
    if (!selectedBooks.length) return
    setSheet(null)
    if (selectedBooks.length === 1) setDeleteCandidate(selectedBooks[0])
    else setBatchDeleteCandidates(selectedBooks)
  }

  async function confirmBatchDeleteBooks() {
    if (!batchDeleteCandidates.length) return
    const ids = new Set(batchDeleteCandidates.map((book) => book.id))
    const count = batchDeleteCandidates.length
    setActivityMessage(`正在删除 ${count} 本书`)
    try {
      await Promise.all(batchDeleteCandidates.map((book) => deleteBook(book.id)))
      for (const id of ids) readerChapterRecognitionCache.delete(id)
      setBooks((current) => current.filter((book) => !ids.has(book.id)))
      setSelectedBookIds((current) => current.filter((id) => !ids.has(id)))
      setBatchDeleteCandidates([])
      showToast(`已从书架删除 ${count} 本书。`)
    } finally {
      setActivityMessage(null)
    }
  }

  async function updateSettings(patch: Partial<ReaderSettings>) {
    const layoutChanges = (Object.keys(patch) as Array<keyof ReaderSettings>).some((key) =>
      key === 'fontSize'
      || key === 'lineHeight'
      || key === 'paragraphSpacing'
      || key === 'paragraphIndent'
      || key === 'pageMargin'
      || key === 'fontFamily'
      || key === 'followSystemFont'
      || key === 'pageTurnMode')
    const pending = pendingReaderRestoreRef.current
    const currentBook = activeBookRef.current
    const readerSnapshot = view === 'reader'
      ? readerRestoreRef.current && pending && currentBook?.id === pending.bookId
        ? bookAtTextOffset(currentBook, pending.textOffset)
        : getReaderSnapshot()
      : null
    if (readerSnapshot) {
      activeBookRef.current = readerSnapshot
      setBooks((current) => current.map((book) => book.id === readerSnapshot.id ? readerSnapshot : book))
      void queueReaderProgressSave(readerSnapshot)
      if (layoutChanges) {
        readerPaginationKeyRef.current = ''
        const token = ++readerRestoreTokenRef.current
        pendingReaderRestoreRef.current = { bookId: readerSnapshot.id, textOffset: readerSnapshot.textOffset, token }
        readerRestoreRef.current = true
      }
    }
    const next = { ...settings, ...patch }
    if (patch.pageTurnMode && patch.pageTurnMode !== settings.pageTurnMode) {
      readerPageTargetRef.current = null
    }
    setSettings(next)
    await saveSettings(next)
  }

  async function applyReaderTheme(theme: ReaderTheme) {
    const presets: Record<ReaderTheme, Pick<ReaderSettings, 'backgroundColor' | 'textColor'>> = {
      paper: { backgroundColor: '#f5f0e7', textColor: '#2e2b26' },
      green: { backgroundColor: '#e7eee3', textColor: '#29332b' },
      night: { backgroundColor: '#171a1b', textColor: '#d4d0c7' },
    }
    await updateSettings({ theme, ...presets[theme] })
  }

  function clearBookLongPress() {
    if (longPressTimer.current) window.clearTimeout(longPressTimer.current)
    longPressTimer.current = null
  }

  function startBookLongPress(bookId: string, event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    clearBookLongPress()
    longPressed.current = false
    pressOrigin.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointer = { x: event.clientX, y: event.clientY }
    longPressTimer.current = window.setTimeout(() => {
      const book = books.find((item) => item.id === bookId)
      if (!book) return
      longPressed.current = true
      suppressBookClick.current = true
      draggedBookRef.current = bookId
      setDraggedBookId(bookId)
      setDragPreview({
        book,
        x: pointer.x,
        y: pointer.y,
        offsetX: pointer.x - bounds.left,
        offsetY: pointer.y - bounds.top,
        width: bounds.width,
      })
    }, 420)
  }

  function moveBookLongPress(event: React.PointerEvent<HTMLElement>) {
    if (!longPressed.current) {
      const origin = pressOrigin.current
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 12) clearBookLongPress()
      return
    }
    event.preventDefault()
    setDragPreview((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current)
    setDropGroupId(findGroupAtPoint(event.clientX, event.clientY))
  }

  function findGroupAtPoint(x: number, y: number): string | null {
    const group = Array.from(document.querySelectorAll<HTMLElement>('[data-group-id]')).find((element) => {
      const bounds = element.getBoundingClientRect()
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom
    })
    return group?.dataset.groupId ?? null
  }

  async function moveBookToGroup(bookId: string, groupId: string | undefined) {
    const book = books.find((item) => item.id === bookId)
    if (!book || book.groupId === groupId) return
    const next = { ...book, groupId }
    setBooks((current) => current.map((item) => item.id === bookId ? next : item))
    await saveBook(next)
    showToast(groupId ? '已移入分组。' : '已移回书架。')
  }

  async function finishBookLongPress(event: React.PointerEvent<HTMLElement>) {
    clearBookLongPress()
    if (!longPressed.current) return
    event.preventDefault()
    const bookId = draggedBookRef.current
    const groupId = findGroupAtPoint(event.clientX, event.clientY) ?? dropGroupId
    cancelBookDrag()
    suppressBookClick.current = true
    window.setTimeout(() => { suppressBookClick.current = false }, 0)
    if (!bookId || !groupId) return
    try {
      await moveBookToGroup(bookId, groupId)
    } catch {
      showToast('移动书籍失败，请重试。')
    }
  }

  function cancelBookDrag() {
    clearBookLongPress()
    longPressed.current = false
    pressOrigin.current = null
    draggedBookRef.current = null
    suppressBookClick.current = false
    setDraggedBookId(null)
    setDropGroupId(null)
    setDragPreview(null)
  }

  async function createGroup() {
    const name = groupName.trim()
    if (!name) {
      setGroupNameError('请输入分组名称。')
      return
    }
    if (settings.bookGroups.some((group) => group.name === name)) {
      setGroupNameError('已有同名分组。')
      return
    }
    const group: BookGroup = { id: crypto.randomUUID(), name: name.slice(0, 18), createdAt: Date.now() }
    await updateSettings({ bookGroups: [...settings.bookGroups, group] })
    setActiveGroupId(group.id)
    setGroupName('')
    setGroupNameError('')
    setSheet('group')
  }

  async function renameActiveGroup() {
    if (!activeGroupId) return
    const name = groupName.trim()
    if (!name) {
      setGroupNameError('请输入分组名称。')
      return
    }
    if (settings.bookGroups.some((group) => group.id !== activeGroupId && group.name === name)) {
      setGroupNameError('已有同名分组。')
      return
    }
    await updateSettings({ bookGroups: settings.bookGroups.map((group) => group.id === activeGroupId ? { ...group, name: name.slice(0, 18) } : group) })
    setGroupName('')
    setGroupNameError('')
    setSheet('group')
  }

  function openBookActions(book: Book) {
    setBookActionCandidate(book)
    setSheet('book-actions')
  }

  async function renameBook() {
    if (!bookActionCandidate) return
    const name = bookName.trim()
    if (!name) {
      setBookNameError('请输入书名。')
      return
    }
    const originalName = `${name}.txt`
    let renamedUri = bookActionCandidate.sourceUri
    let renamedSource = false
    if (isNativeAndroid() && bookActionCandidate.sourceUri) {
      try {
        const result = await renameNativeFile(bookActionCandidate.sourceUri, originalName)
        renamedUri = result.uri
        renamedSource = true
      } catch {
        showToast('书架名称已更新，源 TXT 文件未改名。')
      }
    }
    const next = { ...bookActionCandidate, title: name.slice(0, 80), originalName: renamedSource ? originalName : bookActionCandidate.originalName, sourceUri: renamedUri }
    setBooks((current) => current.map((book) => book.id === next.id ? next : book))
    await saveBook(next)
    setBookActionCandidate(null)
    setSelectedBookIds([])
    setBookName('')
    setBookNameError('')
    setSheet(renameBookReturnToGroup && activeGroupId ? 'group' : null)
    setRenameBookReturnToGroup(false)
    if (renamedSource) showToast('书名和源 TXT 文件名已更新。')
    else if (!bookActionCandidate.sourceUri || !isNativeAndroid()) showToast('书架书名已更新。')
  }

  async function dissolveActiveGroup() {
    if (!activeGroupId) return
    const groupBooks = books.filter((book) => book.groupId === activeGroupId)
    const nextBooks = books.map((book) => book.groupId === activeGroupId ? { ...book, groupId: undefined } : book)
    setBooks(nextBooks)
    setActivityMessage('正在解散分组')
    try {
      await Promise.all(groupBooks.map((book) => saveBook({ ...book, groupId: undefined })))
      await updateSettings({ bookGroups: settings.bookGroups.filter((group) => group.id !== activeGroupId) })
      setActiveGroupId(null)
      setSheet(null)
      showToast('分组已解散，书籍保留在书架。')
    } finally {
      setActivityMessage(null)
    }
  }

  async function importExternalFile(uri: string) {
    if (importingExternalFileUrisRef.current.has(uri)) return
    importingExternalFileUrisRef.current.add(uri)
    try {
      const file = await getNativeFileInfo(uri)
      await flushReaderProgressRef.current()
      setView('shelf')
      setMainTab('shelf')
      setSheet(null)
      await closeFolderBrowser()
      setActiveBookId(null)
      setReaderChromeVisible(true)
      if (isZipFile(file)) {
        setActivityMessage('正在读取 ZIP 压缩包')
        await openZipForSelection(await readNativeFolderFile(file))
      }
      else await importFolderFiles([file])
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法打开这个文件。')
    } finally {
      setActivityMessage(null)
      importingExternalFileUrisRef.current.delete(uri)
    }
  }

  async function openZipForSelection(file: File) {
    if (file.size > MAX_ZIP_FILE_SIZE) {
      showToast('ZIP 压缩包不能超过 100 MB。')
      return
    }
    setActivityMessage('正在读取 ZIP 压缩包')
    setBusy(true)
    let archiveReader: ZipReader<Blob> | null = null
    try {
      archiveReader = new ZipReader(new BlobReader(file))
      const entries = await archiveReader.getEntries()
      let fileCount = 0
      let totalSize = 0
      let limitExceeded = false
      const archiveEntries = new Map<string, FileEntry>()
      const archiveFiles: FolderFile[] = []
      for (const entry of entries) {
        if (entry.directory) continue
        const relativePath = archiveEntryPath(entry.filename)
        const fileName = relativePath?.split('/').pop() || ''
        const hiddenOrMetadata = relativePath?.startsWith('__MACOSX/')
          || relativePath?.split('/').some((part) => part.startsWith('.'))
        if (!relativePath || !fileName.toLocaleLowerCase().endsWith('.txt') || hiddenOrMetadata || entry.uncompressedSize <= 0) continue
        if (archiveEntries.has(relativePath)) throw new Error('ZIP 压缩包中存在重名 TXT 文件，无法安全导入。')
        fileCount += 1
        totalSize += entry.uncompressedSize
        if (fileCount > MAX_ZIP_TEXT_FILES || entry.uncompressedSize > MAX_ZIP_TEXT_FILE_SIZE || totalSize > MAX_ZIP_TEXT_TOTAL_SIZE) {
          limitExceeded = true
          break
        }
        archiveEntries.set(relativePath, entry)
        archiveFiles.push({
          name: fileName,
          size: entry.uncompressedSize,
          uri: '',
          modifiedAt: entry.lastModDate?.getTime(),
          relativePath,
        })
      }
      if (limitExceeded) throw new Error('压缩包中的 TXT 过多或过大，请先在文件管理器中解压后再导入。')
      if (!archiveFiles.length) throw new Error('这个 ZIP 压缩包中没有可导入的 TXT 文件。')
      archiveFiles.sort((left, right) => (right.modifiedAt || 0) - (left.modifiedAt || 0)
        || (left.relativePath || left.name).localeCompare(right.relativePath || right.name, 'zh-CN'))
      setFolderBrowser({
        folder: {
          id: `archive:${crypto.randomUUID()}`,
          name: file.name,
          uri: '',
          displayPath: 'ZIP 压缩包',
        },
        files: archiveFiles,
        archiveGroupName: archiveDefaultGroupName(file.name),
        archiveCreateGroup: true,
        archiveReader,
        archiveEntries,
        archivePassword: '',
        archivePasswordRequired: archiveFiles.some((archiveFile) => archiveEntries.get(archiveFile.relativePath || '')?.encrypted),
      })
      archiveReader = null
      setSelectedFolderFiles([])
      setFolderSearchQuery('')
    } catch (error) {
      if (archiveReader) {
        try {
          await archiveReader.close()
        } catch {
          // Ignore cleanup errors while reporting the archive error.
        }
      }
      showToast(archiveReadErrorMessage(error, error instanceof Error ? error.message : '无法读取这个 ZIP 压缩包。'))
    } finally {
      setBusy(false)
      setActivityMessage(null)
    }
  }

  async function handleTxtFiles(files: FileList | null) {
    if (!files?.length) return
    const selectedFiles = Array.from(files)
    const zipFiles = selectedFiles.filter(isZipFile)
    if (zipFiles.length) {
      if (selectedFiles.length !== 1) showToast('请选择一个 ZIP 压缩包，或一次选择多个 TXT 文件。')
      else await openZipForSelection(zipFiles[0])
      if (txtInputRef.current) txtInputRef.current.value = ''
      return
    }
    const txtFiles = Array.from(files).filter((file) => file.name.toLowerCase().endsWith('.txt'))
    if (!txtFiles.length) {
      showToast('请选择 TXT 文件。')
    } else {
      await importBooks(txtFiles.map((file) => ({ file })))
    }
    if (txtInputRef.current) txtInputRef.current.value = ''
  }

  async function startTxtImport() {
    if (!isNativeAndroid() || !isNativeFolderPickerAvailable()) {
      txtInputRef.current?.click()
      return
    }
    try {
      const result = await pickNativeFiles()
      if (!result.files.length) return
      const zipFiles = result.files.filter(isZipFile)
      if (zipFiles.length) {
        if (result.files.length !== 1) {
          showToast('请选择一个 ZIP 压缩包，或一次选择多个 TXT 文件。')
          return
        }
        setActivityMessage('正在读取 ZIP 压缩包')
        try {
          await openZipForSelection(await readNativeFolderFile(zipFiles[0]))
        } finally {
          setActivityMessage(null)
        }
        return
      }
      await importFolderFiles(result.files)
    } catch (error) {
      if (error instanceof Error && !error.message.toLowerCase().includes('cancel')) {
        showToast(error.message || '文件读取失败。')
      }
    }
  }

  async function handleFolderFiles(files: FileList | null) {
    if (!files?.length) return
    const firstFile = files[0] as File & { webkitRelativePath?: string }
    const folderName = firstFile.webkitRelativePath?.split('/')[0] || '已选择的文件夹'
    const commonFolder: CommonFolder = {
      id: `web:${folderName}`,
      name: folderName,
      uri: '',
      displayPath: firstFile.webkitRelativePath ? `浏览器 / ${folderName}` : '浏览器中已选择的文件夹',
    }
    setActivityMessage('正在扫描文件夹')
    try {
      const commonFolders = [...settings.commonFolders.filter((folder) => folder.id !== commonFolder.id), commonFolder]
      await updateSettings({ commonFolders })
      const candidates = Array.from(files).map((file) => ({
        name: file.name,
        size: file.size,
        uri: '',
        modifiedAt: file.lastModified,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
        webFile: file,
      }))
      const sortedFiles = (await filterCommonFolderFiles(candidates)).sort((left, right) => (right.modifiedAt || 0) - (left.modifiedAt || 0)
        || (left.relativePath || left.name).localeCompare(right.relativePath || right.name, 'zh-CN'))
      setFolderBrowser({
        folder: commonFolder,
        files: sortedFiles,
      })
      setSelectedFolderFiles([])
      setFolderSearchQuery('')
    } finally {
      setActivityMessage(null)
      if (folderInputRef.current) folderInputRef.current.value = ''
    }
  }

  async function openCommonFolder(folder: CommonFolder) {
    if (scanningFolderRef.current) return
    if (!folder.uri) {
      folderInputRef.current?.click()
      return
    }
    scanningFolderRef.current = folder.id
    setScanningFolderId(folder.id)
    try {
      const result = await listNativeFolder(folder)
      const files = (await filterCommonFolderFiles(result.files)).sort((left, right) =>
        (right.modifiedAt || 0) - (left.modifiedAt || 0)
        || (left.relativePath || left.name).localeCompare(right.relativePath || right.name, 'zh-CN'))
      setFolderBrowser({ folder, files })
      setSelectedFolderFiles([])
      setFolderSearchQuery('')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文件夹读取失败。')
    } finally {
      if (scanningFolderRef.current === folder.id) {
        scanningFolderRef.current = null
        setScanningFolderId(null)
      }
    }
  }

  async function filterCommonFolderFiles(files: FolderFile[]): Promise<FolderFile[]> {
    const visibleFiles: FolderFile[] = []
    for (const file of files) {
      const lowerName = file.name.toLocaleLowerCase()
      if (lowerName.endsWith('.txt')) {
        visibleFiles.push(file)
        continue
      }
      if (!isZipFile(file)) continue
      const cacheKey = `${folderFileId(file)}:${file.size}:${file.modifiedAt || 0}`
      let containsTxt = zipTextScanCacheRef.current.get(cacheKey)
      if (containsTxt === undefined) {
        try {
          containsTxt = await zipContainsImportableTxt(await readNativeFolderFile(file))
        } catch {
          containsTxt = false
        }
        zipTextScanCacheRef.current.set(cacheKey, containsTxt)
      }
      if (containsTxt) visibleFiles.push(file)
    }
    return visibleFiles
  }

  function isFolderFileImported(file: FolderFile): boolean {
    if (folderBrowser?.archiveReader) return false
    return books.some((book) => (file.uri && book.sourceUri === file.uri)
      || (book.originalName === file.name && book.size === file.size))
  }

  function toggleFolderFile(file: FolderFile) {
    if (isFolderFileImported(file)) return
    const id = folderFileId(file)
    setSelectedFolderFiles((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id])
  }

  function toggleAllFolderFiles() {
    if (!folderBrowser) return
    const available = folderBrowser.files.filter((file) => !isFolderFileImported(file)).map(folderFileId)
    const allSelected = available.length > 0 && available.every((id) => selectedFolderFiles.includes(id))
    setSelectedFolderFiles(allSelected ? [] : available)
  }

  async function importArchiveFiles(files: FolderFile[], browser: FolderBrowserState, groupName?: string): Promise<boolean> {
    const archiveReader = browser.archiveReader
    const archiveEntries = browser.archiveEntries
    if (!archiveReader || !archiveEntries) {
      showToast('压缩包读取状态已失效，请重新选择 ZIP 文件。')
      return false
    }
    const password = browser.archivePassword || ''
    const needsPassword = files.some((file) => archiveEntries.get(folderFileId(file))?.encrypted)
    if (needsPassword && !password) {
      setFolderBrowser((current) => current === browser ? { ...current, archivePasswordError: '请输入压缩包密码。' } : current)
      showToast('请输入压缩包密码。')
      return false
    }
    setActivityMessage('正在导入书籍')
    setBusy(true)
    try {
      const items = await Promise.all(files.map(async (file) => {
        const entry = archiveEntries.get(folderFileId(file))
        if (!entry) throw new Error('找不到所选的 ZIP 文件条目。')
        const data = await entry.arrayBuffer(entry.encrypted ? { password } : undefined)
        return { file: new File([data], file.name, { type: 'text/plain' }) }
      }))
      await importPreparedBooks(items, groupName)
      return true
    } catch (error) {
      const message = archiveReadErrorMessage(error, error instanceof Error ? error.message : '无法读取压缩包中的 TXT 文件。')
      setFolderBrowser((current) => current === browser ? { ...current, archivePasswordError: message } : current)
      showToast(message)
      return false
    } finally {
      setBusy(false)
      setActivityMessage(null)
    }
  }

  async function confirmFolderFiles() {
    if (!folderBrowser || !selectedFolderFiles.length) return
    const browser = folderBrowser
    const selected = browser.files.filter((file) => selectedFolderFiles.includes(folderFileId(file)))
    const zipFiles = browser.archiveReader ? [] : selected.filter(isZipFile)
    if (zipFiles.length) {
      if (selected.length !== 1) {
        showToast('请选择一个 ZIP 压缩包，或一次选择多个 TXT 文件。')
        return
      }
      setBusy(true)
      setActivityMessage('正在读取 ZIP 压缩包')
      try {
        const zipFile = await readNativeFolderFile(zipFiles[0])
        await closeFolderBrowser(browser)
        await openZipForSelection(zipFile)
      } catch (error) {
        showToast(error instanceof Error ? error.message : '无法读取这个 ZIP 压缩包。')
      } finally {
        setBusy(false)
        setActivityMessage(null)
      }
      return
    }
    const requestedGroupName = browser.archiveGroupName?.trim()
    if (browser.archiveReader && browser.archiveCreateGroup && !requestedGroupName) {
      showToast('请输入分组名称。')
      return
    }
    const groupName = browser.archiveReader && browser.archiveCreateGroup && requestedGroupName
      ? archiveGroupName(requestedGroupName, settings.bookGroups)
      : undefined
    if (browser.archiveReader) {
      const imported = await importArchiveFiles(selected, browser, groupName)
      if (!imported) return
      await closeFolderBrowser(browser)
      return
    }
    await importFolderFiles(selected, groupName)
    await closeFolderBrowser(browser)
  }

  async function addCommonFolder() {
    if (!isNativeAndroid() || !isNativeFolderPickerAvailable()) {
      folderInputRef.current?.click()
      return
    }
    try {
      const result = await pickNativeFolder()
      const commonFolder: CommonFolder = { id: result.uri, name: result.name, uri: result.uri, displayPath: result.displayPath }
      await updateSettings({ commonFolders: [...settings.commonFolders.filter((folder) => folder.uri !== result.uri), commonFolder] })
      showToast(`已添加常用文件夹“${result.name}”。`)
    } catch (error) {
      if (error instanceof Error && !error.message.toLowerCase().includes('cancel')) showToast(error.message)
    }
  }

  async function removeCommonFolder(folderId: string) {
    await updateSettings({ commonFolders: settings.commonFolders.filter((folder) => folder.id !== folderId) })
  }

  async function importFolderFiles(files: FolderFile[], groupName?: string) {
    setActivityMessage('正在导入书籍')
    setBusy(true)
    try {
      const items = await Promise.all(files.map(async (file) => ({
        file: await readNativeFolderFile(file),
        sourceUri: file.uri || undefined,
      })))
      await importPreparedBooks(items, groupName)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文件读取失败。')
    } finally {
      setBusy(false)
      setActivityMessage(null)
    }
  }

  async function importBooks(files: Array<{ file: File; sourceUri?: string }>) {
    setActivityMessage('正在导入书籍')
    setBusy(true)
    try {
      await importPreparedBooks(files)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '文件读取失败。')
    } finally {
      setBusy(false)
      setActivityMessage(null)
    }
  }

  async function importPreparedBooks(files: Array<{ file: File; sourceUri?: string }>, groupName?: string) {
    const candidates = await Promise.all(files.map(async ({ file, sourceUri }) => ({
      candidate: await prepareImport(file),
      sourceUri,
    })))
    const knownFingerprints = new Set(books.map((book) => book.fingerprint))
    const imported: Book[] = []
    let skipped = 0

    for (const { candidate: prepared, sourceUri } of candidates) {
      const duplicate = knownFingerprints.has(prepared.fingerprint)
        ? true
        : await findBookByFingerprint(prepared.fingerprint)
      if (duplicate) {
        skipped += 1
        continue
      }
      const book = makeBook(prepared, sourceUri)
      await saveBook(book)
      try {
        getCachedReaderDocument(book)
        await prewarmReaderPagination(book, settings)
      } catch {
        // The imported book remains usable if optional preprocessing fails.
      }
      knownFingerprints.add(book.fingerprint)
      imported.push(book)
    }

    const importedGroup = groupName && imported.length
      ? { id: crypto.randomUUID(), name: groupName, createdAt: Date.now() }
      : undefined
    const importedBooks = importedGroup
      ? imported.map((book) => ({ ...book, groupId: importedGroup.id }))
      : imported
    if (importedGroup) {
      await Promise.all(importedBooks.map((book) => saveBook(book)))
      await updateSettings({ bookGroups: [...settings.bookGroups, importedGroup] })
    }
    if (importedBooks.length) setBooks((current) => [...importedBooks, ...current])
    if (!imported.length) {
      showToast('所选书籍都已在书架中。')
      return
    }
    const message = [`已导入 ${imported.length} 本`]
    if (skipped) message.push(`跳过 ${skipped} 本重复书籍`)
    showToast(message.join('，'))
  }

  function openBook(book: Book) {
    const now = Date.now()
    const latest = activeBookRef.current?.id === book.id ? activeBookRef.current : book
    const updated = { ...latest, lastReadAt: now }
    const mountedPaper = readerRef.current?.querySelector<HTMLElement>('.reader-paper')
    const sameMountedReader = mountedPaper?.dataset.readerBookId === book.id
    const reuseMountedReader = sameMountedReader && readerPositionReady
    readerResumeWithoutRestoreRef.current = reuseMountedReader
    setReaderPositionReady(reuseMountedReader)
    setBooks((current) => current.map((item) => item.id === book.id ? updated : item))
    checkpointBookProgress(updated)
    void saveBookProgress(updated)
    void updateSettings({ lastBookId: book.id })
    setSheet(null)
    setActiveGroupId(null)
    if (!sameMountedReader) {
      readerRef.current?.replaceChildren()
      readerPageHeightRef.current = 0
      readerPageWidthRef.current = 0
      readerPaginationKeyRef.current = ''
      readerPaginationPagesRef.current = 1
      readerLocationIndexRef.current = null
      setReaderPages(1)
      setReaderCurrentPage(1)
    }
    readerRestoreTokenRef.current += 1
    pendingReaderRestoreRef.current = null
    readerRestoreRef.current = false
    setActiveBookId(book.id)
    setReaderChromeVisible(false)
    setMainTab('shelf')
    setView('reader')
  }

  function closeReader() {
    void flushReaderProgress()
    if (document.activeElement instanceof HTMLElement && readerRef.current?.parentElement?.contains(document.activeElement)) {
      document.activeElement.blur()
    }
    readerRestoreTokenRef.current += 1
    pendingReaderRestoreRef.current = null
    readerRestoreRef.current = false
    setSheet(null)
    setView('shelf')
    setReaderChromeVisible(true)
  }

  function changeMainTab(tab: MainTab) {
    setMainTab(tab)
    setSearchOpen(false)
    setSearchQuery('')
    setSelectedBookIds([])
  }

  function renderReaderWindow(element: HTMLDivElement, book: Book, targetOffset: number, direction: -1 | 0 | 1 = 0): ReaderRenderWindow {
    const document = getCachedReaderDocument(book)
    const renderWindow = readerBlockWindow(document, book, targetOffset, direction)
    const useLazyChunks = settings.pageTurnMode === 'scroll'
      && settings.progressDisplay === 'percent'
      && renderWindow.endOffset - renderWindow.startOffset > 120_000
    const contentHtml = readerBlocksHtml(renderWindow.blocks, useLazyChunks, settings.paragraphSpacing, settings.paragraphIndent)
    const title = renderWindow.startOffset === 0
      ? `<h1>${escapeReaderHtml(book.title)}</h1><div class="reader-rule"><span></span></div>`
      : ''
    const footer = renderWindow.endOffset >= book.content.length ? '<footer>— 全文完 —</footer>' : ''
    const documentKey = readerDocumentCacheKey(book)
    element.innerHTML = `<article class="reader-paper" data-reader-book-id="${escapeReaderHtml(book.id)}" data-reader-document-key="${escapeReaderHtml(documentKey)}" data-reader-layout-key="${readerContentLayoutKey(settings)}" data-reader-window-start="${renderWindow.startOffset}" data-reader-window-end="${renderWindow.endOffset}">${title}<div class="reader-content">${contentHtml}</div>${footer}</article>`
    readerRenderWindowRef.current = renderWindow
    readerLocationIndexRef.current = null
    readerPaginationKeyRef.current = ''
    return renderWindow
  }

  function getReaderLocationBlocks(element: HTMLDivElement, book: Book): HTMLElement[] {
    const key = readerDocumentCacheKey(book)
    const cached = readerLocationIndexRef.current
    if (cached?.key === key && cached.element === element && cached.blocks[0]?.isConnected) return cached.blocks
    const blocks = Array.from(element.querySelectorAll<HTMLElement>('[data-reader-offset]'))
    readerLocationIndexRef.current = { key, element, blocks }
    return blocks
  }

  function firstReaderBlockAfterViewportStart(element: HTMLDivElement, blocks: HTMLElement[], horizontal: boolean): number {
    const bounds = element.getBoundingClientRect()
    const viewportStart = horizontal ? bounds.left + 1 : bounds.top + 1
    let low = 0
    let high = blocks.length - 1
    let found = blocks.length - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const rect = blocks[middle].getBoundingClientRect()
      const blockEnd = horizontal ? rect.right : rect.bottom
      if (blockEnd > viewportStart) {
        found = middle
        high = middle - 1
      } else low = middle + 1
    }
    return Math.max(0, found)
  }

  function lastReaderBlockAtOrBeforeOffset(blocks: HTMLElement[], targetOffset: number): number {
    let low = 0
    let high = blocks.length - 1
    let found = -1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const offset = Number(blocks[middle].dataset.readerOffset) || 0
      if (offset <= targetOffset) {
        found = middle
        low = middle + 1
      } else high = middle - 1
    }
    return found
  }

  function getReaderTextOffset(element: HTMLDivElement, book: Book, progress: number): number {
    const blocks = getReaderLocationBlocks(element, book)
    if (!blocks.length) return Math.round(book.content.length * progress)
    const viewportTop = element.getBoundingClientRect().top + 1
    const currentIndex = firstReaderBlockAfterViewportStart(element, blocks, false)
    const current = blocks[currentIndex]
    const next = blocks[currentIndex + 1]
    const currentOffset = Number(current.dataset.readerOffset) || 0
    if (!next) return Math.min(book.content.length, Math.max(currentOffset, Math.round(book.content.length * progress)))
    const nextOffset = Number(next.dataset.readerOffset) || currentOffset
    const currentTop = current.getBoundingClientRect().top
    const nextTop = next.getBoundingClientRect().top
    const ratio = Math.min(1, Math.max(0, (viewportTop - currentTop) / Math.max(1, nextTop - currentTop)))
    return Math.round(currentOffset + (nextOffset - currentOffset) * ratio)
  }

  function getHorizontalReaderTextOffset(element: HTMLDivElement, book: Book, progress: number): number {
    const blocks = getReaderLocationBlocks(element, book)
    if (!blocks.length) return Math.round(book.content.length * progress)
    const bounds = element.getBoundingClientRect()
    const viewportLeft = bounds.left + 1
    const viewportRight = bounds.right - 1
    const candidateIndex = firstReaderBlockAfterViewportStart(element, blocks, true)
    const start = Math.max(0, candidateIndex - 2)
    const end = Math.min(blocks.length, candidateIndex + 4)
    for (let index = start; index < end; index += 1) {
      const block = blocks[index]
      const rects = Array.from(block.getClientRects())
      const visibleRectIndex = rects.findIndex((rect) => rect.right > viewportLeft && rect.left < viewportRight)
      if (visibleRectIndex < 0) continue
      const blockOffset = Number(block.dataset.readerOffset) || 0
      const nextOffset = Number(blocks[index + 1]?.dataset.readerOffset) || book.content.length
      const fragmentRatio = rects.length > 1 ? visibleRectIndex / rects.length : 0
      return Math.round(blockOffset + (nextOffset - blockOffset) * fragmentRatio)
    }
    return Math.round(book.content.length * progress)
  }

  function getReaderSnapshot(): Book | null {
    const element = readerRef.current
    const book = activeBookRef.current
    if (!element || !book) return null
    const horizontal = settings.pageTurnMode === 'horizontal'
    const scrollable = Math.max(1, horizontal
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight)
    const scrollPosition = horizontal ? element.scrollLeft : element.scrollTop
    const scrollProgress = Math.min(1, Math.max(0, scrollPosition / scrollable))
    const textOffset = horizontal
      ? getHorizontalReaderTextOffset(element, book, scrollProgress)
      : getReaderTextOffset(element, book, scrollProgress)
    const progress = book.content.length
      ? Math.min(1, Math.max(0, textOffset / book.content.length))
      : scrollProgress
    return {
      ...book,
      progress,
      textOffset,
      lastReadAt: Date.now(),
    }
  }

  function stableReaderPageHeight(element: HTMLDivElement): number {
    const width = Math.round(element.clientWidth)
    const height = Math.max(1, element.clientHeight)
    if (!readerPageHeightRef.current
      || Math.abs(width - readerPageWidthRef.current) > 1
      || Math.abs(height - readerPageHeightRef.current) > 1) {
      readerPageWidthRef.current = width
      readerPageHeightRef.current = height
    }
    return readerPageHeightRef.current
  }

  function readerPaginationKey(element: HTMLDivElement): string {
    const book = activeBookRef.current
    return book ? readerPaginationCacheKey(book, settings, element.clientWidth, element.clientHeight) : ''
  }

  function syncReaderPageGrid(element: HTMLDivElement): void {
    const requestedLineHeight = settings.fontSize * settings.lineHeight
    const bottomPadding = 22
    const topPadding = Math.min(12, settings.pageMargin)
    const availableHeight = Math.max(requestedLineHeight, element.clientHeight - bottomPadding - topPadding)
    const lineCount = Math.max(1, Math.round(availableHeight / requestedLineHeight))
    const fittedLineHeight = availableHeight / lineCount
    const lineHeight = `${fittedLineHeight}px`
    const pageTopPadding = `${topPadding}px`
    const pageBottomPadding = `${bottomPadding}px`
    if (element.style.lineHeight !== lineHeight) element.style.lineHeight = lineHeight
    if (element.style.getPropertyValue('--reader-line-height') !== lineHeight) element.style.setProperty('--reader-line-height', lineHeight)
    if (element.style.getPropertyValue('--reader-page-top-padding') !== pageTopPadding) element.style.setProperty('--reader-page-top-padding', pageTopPadding)
    if (element.style.getPropertyValue('--reader-page-bottom-padding') !== pageBottomPadding) element.style.setProperty('--reader-page-bottom-padding', pageBottomPadding)
  }

  function measureReaderPages(element: HTMLDivElement): number {
    syncReaderPageGrid(element)
    const pageWidth = Math.max(1, element.clientWidth)
    const key = readerPaginationKey(element)
    if (readerPaginationKeyRef.current === key) return readerPaginationPagesRef.current
    const cached = cachedReaderPages(key)
    if (cached) {
      readerPaginationKeyRef.current = key
      readerPaginationPagesRef.current = cached
      return cached
    }
    if (settings.pageTurnMode === 'horizontal') {
      const localPages = Math.max(1, Math.ceil(element.scrollWidth / pageWidth))
      const renderWindow = readerRenderWindowRef.current
      const book = activeBookRef.current
      const windowLength = renderWindow ? Math.max(1, renderWindow.endOffset - renderWindow.startOffset) : book?.content.length || 1
      const total = book ? Math.max(1, Math.ceil(localPages * book.content.length / windowLength)) : localPages
      readerPaginationKeyRef.current = key
      readerPaginationPagesRef.current = total
      rememberReaderPages(key, total)
      return total
    }

    const paper = element.querySelector<HTMLElement>('.reader-paper')
    const host = element.parentElement
    if (!paper || !host) return readerPaginationPagesRef.current
    const measurement = document.createElement('div')
    measurement.className = 'reader-scroll mode-horizontal reader-pagination-measure'
    measurement.setAttribute('aria-hidden', 'true')
    measurement.style.width = `${pageWidth}px`
    measurement.style.height = `${Math.max(1, element.clientHeight)}px`
    measurement.style.fontSize = element.style.fontSize
    measurement.style.lineHeight = element.style.lineHeight
    for (const property of ['--paragraph-gap', '--paragraph-indent', '--reader-page-margin', '--reader-line-height', '--reader-page-top-padding', '--reader-page-bottom-padding']) {
      measurement.style.setProperty(property, element.style.getPropertyValue(property))
    }
    measurement.appendChild(paper.cloneNode(true))
    host.appendChild(measurement)
    const localPages = Math.max(1, Math.ceil(measurement.scrollWidth / pageWidth))
    measurement.remove()
    const renderWindow = readerRenderWindowRef.current
    const book = activeBookRef.current
    const windowLength = renderWindow ? Math.max(1, renderWindow.endOffset - renderWindow.startOffset) : book?.content.length || 1
    const total = book ? Math.max(1, Math.ceil(localPages * book.content.length / windowLength)) : localPages
    readerPaginationKeyRef.current = key
    readerPaginationPagesRef.current = total
    rememberReaderPages(key, total)
    return total
  }

  function updateReaderPagination(element: HTMLDivElement) {
    if (settings.pageTurnMode === 'scroll' && settings.progressDisplay === 'percent') {
      setReaderPages(1)
      setReaderCurrentPage(1)
      return
    }
    const total = measureReaderPages(element)
    const renderWindow = readerRenderWindowRef.current
    const book = activeBookRef.current
    if (settings.pageTurnMode === 'horizontal') {
      const pageWidth = Math.max(1, element.clientWidth)
      const localScrollable = Math.max(1, element.scrollWidth - pageWidth)
      const localRatio = Math.min(1, Math.max(0, element.scrollLeft / localScrollable))
      const globalOffset = renderWindow
        ? renderWindow.startOffset + localRatio * (renderWindow.endOffset - renderWindow.startOffset)
        : (book?.progress ?? 0) * (book?.content.length ?? 0)
      const current = Math.min(total, Math.max(1, Math.round((book?.content.length ? globalOffset / book.content.length : 0) * Math.max(0, total - 1)) + 1))
      setReaderPages(total)
      setReaderCurrentPage(current)
      return
    }
    const pageHeight = stableReaderPageHeight(element)
    const scrollable = Math.max(0, element.scrollHeight - element.clientHeight)
    const paper = element.querySelector<HTMLElement>('.reader-paper')
    const paperStyle = paper ? getComputedStyle(paper) : null
    const pageContentHeight = Math.max(1, pageHeight
      - (paperStyle ? Number.parseFloat(paperStyle.paddingTop) || 0 : 0)
      - (paperStyle ? Number.parseFloat(paperStyle.paddingBottom) || 0 : 0))
    const contentPosition = Math.max(0, element.scrollTop
      - (paperStyle ? Number.parseFloat(paperStyle.paddingTop) || 0 : 0))
    const localRatio = scrollable <= 1 ? 0 : Math.min(1, Math.max(0, element.scrollTop / scrollable))
    const globalOffset = renderWindow
      ? renderWindow.startOffset + localRatio * (renderWindow.endOffset - renderWindow.startOffset)
      : (book?.progress ?? 0) * (book?.content.length ?? 0)
    const current = Math.min(total, Math.max(1, Math.round((book?.content.length ? globalOffset / book.content.length : 0) * Math.max(0, total - 1)) + 1))
    setReaderPages(total)
    setReaderCurrentPage(current)
  }

  function scrollReaderToTextOffset(element: HTMLDivElement, book: Book, requestedOffset: number, behavior: ScrollBehavior = 'auto') {
    const targetOffset = Math.max(0, Math.min(book.content.length, requestedOffset))
    const renderWindow = readerRenderWindowRef.current
    if (!renderWindow
      || renderWindow.bookId !== book.id
      || targetOffset < renderWindow.startOffset
      || targetOffset > renderWindow.endOffset) {
      renderReaderWindow(element, book, targetOffset)
    }
    if (targetOffset <= 0) {
      readerPageTargetRef.current = 0
      element.scrollTo({ left: 0, top: 0, behavior })
      return
    }
    const blocks = getReaderLocationBlocks(element, book)
    const anchorIndex = lastReaderBlockAtOrBeforeOffset(blocks, targetOffset)
    if (settings.pageTurnMode === 'horizontal') {
      const pageWidth = Math.max(1, element.clientWidth)
      const scrollable = Math.max(0, element.scrollWidth - pageWidth)
      let targetLeft = (book.content.length ? targetOffset / book.content.length : book.progress) * scrollable
      if (anchorIndex >= 0) {
        const anchor = blocks[anchorIndex]
        const anchorOffset = Number(anchor.dataset.readerOffset) || 0
        const nextOffset = Number(blocks[anchorIndex + 1]?.dataset.readerOffset) || book.content.length
        const rects = Array.from(anchor.getClientRects())
        if (rects.length) {
          const fragmentRatio = Math.min(1, Math.max(0, (targetOffset - anchorOffset) / Math.max(1, nextOffset - anchorOffset)))
          const fragmentIndex = Math.min(rects.length - 1, Math.floor(fragmentRatio * rects.length))
          targetLeft = element.scrollLeft + rects[fragmentIndex].left - element.getBoundingClientRect().left
        }
      }
      const requestedPage = Math.floor(Math.max(0, targetLeft) / pageWidth)
      readerPageTargetRef.current = requestedPage
      element.scrollTo({ left: Math.min(scrollable, requestedPage * pageWidth), top: 0, behavior })
      return
    }
    const containerTop = element.getBoundingClientRect().top
    const scrollable = Math.max(0, element.scrollHeight - element.clientHeight)
    let targetTop = book.progress * scrollable
    if (anchorIndex >= 0) {
      const anchor = blocks[anchorIndex]
      const next = blocks[anchorIndex + 1]
      const anchorOffset = Number(anchor.dataset.readerOffset) || 0
      const anchorTop = element.scrollTop + anchor.getBoundingClientRect().top - containerTop
      if (next) {
        const nextOffset = Number(next.dataset.readerOffset) || anchorOffset
        const nextTop = element.scrollTop + next.getBoundingClientRect().top - containerTop
        const ratio = Math.min(1, Math.max(0, (targetOffset - anchorOffset) / Math.max(1, nextOffset - anchorOffset)))
        targetTop = anchorTop + (nextTop - anchorTop) * ratio
      } else {
        const ratio = Math.min(1, Math.max(0, (targetOffset - anchorOffset) / Math.max(1, book.content.length - anchorOffset)))
        targetTop = anchorTop + (scrollable - anchorTop) * ratio
      }
    }
    element.scrollTo({ top: Math.min(scrollable, Math.max(0, targetTop)), behavior })
  }

  function restoreReaderPosition(element: HTMLDivElement, book: Book, requestedToken = readerRestoreTokenRef.current) {
    readerRestoreRef.current = true
    if (readerRestoreFrameRef.current !== null) cancelAnimationFrame(readerRestoreFrameRef.current)
    syncReaderPageGrid(element)
    const savedOffset = book.textOffset > 0 || book.progress <= 0
      ? book.textOffset
      : Math.round(book.content.length * book.progress)
    scrollReaderToTextOffset(element, book, savedOffset)
    updateReaderPagination(element)
    readerRestoreFrameRef.current = requestAnimationFrame(() => {
      readerRestoreFrameRef.current = requestAnimationFrame(() => {
        if (requestedToken !== readerRestoreTokenRef.current) return
        readerRestoreRef.current = false
        pendingReaderRestoreRef.current = null
        readerPageTargetRef.current = null
        readerRestoreFrameRef.current = null
      })
    })
  }

  function persistReaderSnapshot(next: Book) {
    activeBookRef.current = next
    if (readerProgressUiTimerRef.current === null) {
      readerProgressUiTimerRef.current = window.setTimeout(() => {
        readerProgressUiTimerRef.current = null
        const latest = activeBookRef.current
        if (!latest) return
        setBooks((current) => current.map((book) => book.id === latest.id ? latest : book))
      }, 80)
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void queueReaderProgressSave(next)
    }, 250)
  }

  function bookAtTextOffset(book: Book, requestedOffset: number): Book {
    const textOffset = Math.max(0, Math.min(book.content.length, Math.round(requestedOffset)))
    return {
      ...book,
      textOffset,
      progress: book.content.length ? textOffset / book.content.length : 0,
      lastReadAt: Date.now(),
    }
  }

  function persistExactReaderLocation(book: Book, requestedOffset: number): Book {
    if (readerSnapshotTimerRef.current !== null) window.clearTimeout(readerSnapshotTimerRef.current)
    readerSnapshotTimerRef.current = null
    const next = bookAtTextOffset(book, requestedOffset)
    activeBookRef.current = next
    setBooks((current) => current.map((item) => item.id === next.id ? next : item))
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    void queueReaderProgressSave(next)
    return next
  }

  function queueReaderProgressSave(next: Book): Promise<void> {
    checkpointBookProgress(next)
    const pending = progressSaveChain.current
      .catch(() => undefined)
      .then(() => saveBookProgress(next))
    progressSaveChain.current = pending
    return pending
  }

  function flushReaderProgress(): Promise<void> {
    if (readerSnapshotTimerRef.current !== null) window.clearTimeout(readerSnapshotTimerRef.current)
    readerSnapshotTimerRef.current = null
    const next = getReaderSnapshot()
    if (!next) return progressSaveChain.current
    activeBookRef.current = next
    if (readerProgressUiTimerRef.current !== null) window.clearTimeout(readerProgressUiTimerRef.current)
    readerProgressUiTimerRef.current = null
    setBooks((current) => current.map((book) => book.id === next.id ? next : book))
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    return queueReaderProgressSave(next)
  }
  flushReaderProgressRef.current = flushReaderProgress

  function shiftReaderWindowIfNeeded(element: HTMLDivElement, book: Book, textOffset: number): void {
    const renderWindow = readerRenderWindowRef.current
    if (!renderWindow || renderWindow.bookId !== book.id || readerRestoreRef.current) return
    const horizontal = settings.pageTurnMode === 'horizontal'
    const scrollable = Math.max(1, horizontal
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight)
    const position = horizontal ? element.scrollLeft : element.scrollTop
    const ratio = position / scrollable
    const direction: -1 | 0 | 1 = ratio > 0.9 && renderWindow.endOffset < book.content.length
      ? 1
      : ratio < 0.06 && renderWindow.startOffset > 0
        ? -1
        : 0
    if (!direction) return
    renderReaderWindow(element, book, textOffset, direction)
    restoreReaderPosition(element, bookAtTextOffset(book, textOffset))
  }

  function handleReaderScroll() {
    const element = readerRef.current
    if (!element) return
    if (readerScrollFrameRef.current === null) {
      readerScrollFrameRef.current = requestAnimationFrame(() => {
        readerScrollFrameRef.current = null
        const currentElement = readerRef.current
        if (currentElement) updateReaderPagination(currentElement)
      })
    }
    if (readerRestoreRef.current) return
    if (settings.pageTurnMode === 'horizontal') {
      if (readerPageSettleTimerRef.current !== null) window.clearTimeout(readerPageSettleTimerRef.current)
      readerPageSettleTimerRef.current = window.setTimeout(() => {
        readerPageTargetRef.current = null
        readerPageSettleTimerRef.current = null
      }, 180)
    }
    if (readerSnapshotTimerRef.current !== null) window.clearTimeout(readerSnapshotTimerRef.current)
    readerSnapshotTimerRef.current = window.setTimeout(() => {
      readerSnapshotTimerRef.current = null
      const next = getReaderSnapshot()
      if (next) {
        persistReaderSnapshot(next)
        shiftReaderWindowIfNeeded(element, next, next.textOffset)
      }
    }, 120)
  }

  function turnReaderPage(direction: -1 | 1) {
    const element = readerRef.current
    if (!element || settings.pageTurnMode !== 'horizontal') return
    const pageWidth = Math.max(1, element.clientWidth)
    const totalPages = Math.max(1, Math.ceil(element.scrollWidth / pageWidth))
    const currentPage = readerPageTargetRef.current ?? Math.round(element.scrollLeft / pageWidth)
    const renderWindow = readerRenderWindowRef.current
    const book = activeBookRef.current
    if (book && renderWindow && direction > 0 && currentPage >= totalPages - 1 && renderWindow.endOffset < book.content.length) {
      const targetOffset = Math.max(renderWindow.startOffset, renderWindow.endOffset - 1)
      renderReaderWindow(element, book, targetOffset, 1)
      restoreReaderPosition(element, bookAtTextOffset(book, targetOffset))
      return
    }
    if (book && renderWindow && direction < 0 && currentPage <= 0 && renderWindow.startOffset > 0) {
      const targetOffset = renderWindow.startOffset
      renderReaderWindow(element, book, targetOffset, -1)
      restoreReaderPosition(element, bookAtTextOffset(book, targetOffset))
      return
    }
    const targetPage = Math.min(totalPages - 1, Math.max(0, currentPage + direction))
    readerPageTargetRef.current = targetPage
    element.scrollTo({ left: targetPage * pageWidth, top: 0, behavior: 'smooth' })
  }

  function startReaderGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (settings.pageTurnMode !== 'horizontal') return
    readerGestureRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function finishReaderGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (settings.pageTurnMode !== 'horizontal') return
    const start = readerGestureRef.current
    readerGestureRef.current = null
    if (!start || start.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const deltaX = event.clientX - start.x
    const deltaY = event.clientY - start.y
    suppressReaderClick.current = true
    if (Math.abs(deltaX) >= 42 && Math.abs(deltaX) > Math.abs(deltaY)) {
      turnReaderPage(deltaX < 0 ? 1 : -1)
      return
    }
    if (Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = (event.clientX - bounds.left) / Math.max(1, bounds.width)
    if (position >= 0.3 && position <= 0.7 && !sheet) setReaderChromeVisible((visible) => !visible)
  }

  function cancelReaderGesture(event: React.PointerEvent<HTMLDivElement>) {
    readerGestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function handleReaderClick() {
    if (suppressReaderClick.current) {
      suppressReaderClick.current = false
      return
    }
    if (window.getSelection()?.toString().trim()) return
    if (settings.pageTurnMode === 'scroll' && !sheet) setReaderChromeVisible((visible) => !visible)
  }

  function readerProgressLabel(): string {
    if (!activeBook) return '0.0%'
    if (settings.progressDisplay === 'percent') return formatProgressPercent(activeBook.progress)
    return `${readerCurrentPage} / ${readerPages}`
  }

  function openProgressJump() {
    if (!activeBook) return
    const value = settings.progressDisplay === 'percent'
      ? progressPercentValue(activeBook.progress)
      : String(readerCurrentPage)
    setProgressInput(value)
    setSheet('progress')
  }

  function closeProgressJump(): void {
    progressInputRef.current?.blur()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    setSheet(null)
  }

  function updateProgressInput(value: string): void {
    if (settings.progressDisplay === 'page') {
      setProgressInput(value.replace(/\D/g, '').slice(0, 8))
      return
    }
    const normalized = value.replace(/[^\d.]/g, '')
    const [integer = '', ...decimals] = normalized.split('.')
    setProgressInput(decimals.length ? `${integer}.${decimals.join('').slice(0, 1)}` : integer.slice(0, 3))
  }

  function jumpToProgress() {
    if (!activeBook || !readerRef.current) return
    if (!progressInput.trim()) {
      showToast('请输入有效的进度。')
      return
    }
    const value = Number(progressInput)
    if (!Number.isFinite(value)) {
      showToast('请输入有效的进度。')
      return
    }
    const requestedPage = Math.min(readerPages, Math.max(1, Math.round(value)))
    const element = readerRef.current
    if (settings.progressDisplay === 'percent') {
      const targetOffset = Math.round(Math.min(100, Math.max(0, value)) / 100 * activeBook.content.length)
      const next = persistExactReaderLocation(activeBook, targetOffset)
      restoreReaderPosition(element, next)
      closeProgressJump()
      return
    }
    const ratio = readerPages <= 1 ? 0 : (requestedPage - 1) / (readerPages - 1)
    const targetOffset = Math.round(ratio * activeBook.content.length)
    const next = persistExactReaderLocation(activeBook, targetOffset)
    restoreReaderPosition(element, next)
    closeProgressJump()
  }

  function showTocScrollbar(autoHide = true): void {
    if (tocScrollbarHideTimerRef.current !== null) window.clearTimeout(tocScrollbarHideTimerRef.current)
    tocScrollbarHideTimerRef.current = null
    setTocScrollbarVisible(true)
    if (autoHide && !tocScrollbarDragRef.current) {
      tocScrollbarHideTimerRef.current = window.setTimeout(() => {
        tocScrollbarHideTimerRef.current = null
        setTocScrollbarVisible(false)
      }, 850)
    }
  }

  function handleTocScroll(event: React.UIEvent<HTMLDivElement>) {
    showTocScrollbar(true)
    tocLatestScrollTopRef.current = event.currentTarget.scrollTop
    if (tocScrollFrameRef.current !== null) return
    tocScrollFrameRef.current = requestAnimationFrame(() => {
      tocScrollFrameRef.current = null
      setTocScrollTop(tocLatestScrollTopRef.current)
    })
  }

  function scrollTocFromScrollbar(clientY: number, grabOffset: number): void {
    const list = tocListRef.current
    const track = tocScrollbarTrackRef.current
    if (!list || !track) return
    const rect = track.getBoundingClientRect()
    const travel = Math.max(1, rect.height - tocScrollbarThumbHeight)
    const ratio = Math.min(1, Math.max(0, (clientY - rect.top - grabOffset) / travel))
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight)
    const nextTop = ratio * maxScroll
    tocLatestScrollTopRef.current = nextTop
    list.scrollTo({ top: nextTop, behavior: 'auto' })
    setTocScrollTop(nextTop)
  }

  function startTocScrollbarDrag(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    tocScrollbarDragRef.current = { pointerId: event.pointerId, grabOffset: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    setTocScrollbarDragging(true)
    showTocScrollbar(false)
  }

  function moveTocScrollbar(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = tocScrollbarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    scrollTocFromScrollbar(event.clientY, drag.grabOffset)
  }

  function finishTocScrollbarDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const drag = tocScrollbarDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    tocScrollbarDragRef.current = null
    setTocScrollbarDragging(false)
    showTocScrollbar(true)
  }

  function handleTocScrollbarKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    const list = tocListRef.current
    if (!list) return
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight)
    let nextTop = list.scrollTop
    if (event.key === 'ArrowUp') nextTop -= TOC_ROW_HEIGHT
    else if (event.key === 'ArrowDown') nextTop += TOC_ROW_HEIGHT
    else if (event.key === 'PageUp') nextTop -= list.clientHeight * 0.85
    else if (event.key === 'PageDown') nextTop += list.clientHeight * 0.85
    else if (event.key === 'Home') nextTop = 0
    else if (event.key === 'End') nextTop = maxScroll
    else return
    event.preventDefault()
    list.scrollTo({ top: Math.min(maxScroll, Math.max(0, nextTop)), behavior: 'auto' })
  }

  function jumpToChapter(chapter: Chapter) {
    const reader = readerRef.current
    if (!reader || !activeBook) return
    const next = persistExactReaderLocation(activeBook, chapter.offset)
    restoreReaderPosition(reader, next)
    setSheet(null)
  }

  function jumpToStart() {
    const element = readerRef.current
    if (!element || !activeBook) return
    const next = persistExactReaderLocation(activeBook, 0)
    restoreReaderPosition(element, next)
    setSheet(null)
  }

  async function recognizeTableOfContents() {
    if (!activeBook || tocRecognizing) return
    setTocRecognizing(true)
    showToast('正在重新识别目录…')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)))
      const recognition: ChapterRecognition = 'auto'
      const nextBook = { ...activeBook, chapterRecognition: recognition }
      readerDocumentCache.delete(readerDocumentCacheKey(nextBook))
      readerChapterRecognitionCache.delete(nextBook.id)
      const chapterCount = getCachedReaderDocument(nextBook).chapters.length
      setBooks((current) => current.map((book) => book.id === nextBook.id ? nextBook : book))
      activeBookRef.current = nextBook
      await saveBook(nextBook)
      showToast(`已重新识别，找到 ${chapterCount} 个章节。`)
    } catch {
      showToast('目录识别失败，请稍后重试')
    } finally {
      setTocRecognizing(false)
    }
  }

  async function removeChapterFromTableOfContents(chapter: Chapter) {
    if (!activeBook) return
    if (tocMutation) return
    const readerSnapshot = getReaderSnapshot()
    const preservedOffset = readerSnapshot?.id === activeBook.id
      ? readerSnapshot.textOffset
      : activeBookRef.current?.id === activeBook.id ? activeBookRef.current.textOffset : activeBook.textOffset
    const chapterExclusions = chapter.source === 'auto'
      ? [...new Set([...(activeBook.chapterExclusions ?? []), chapter.offset])]
      : activeBook.chapterExclusions
    const chapterAdditions = (activeBook.chapterAdditions ?? []).filter((addition) => addition.offset !== chapter.offset)
    const next = bookAtTextOffset({ ...activeBook, chapterExclusions, chapterAdditions }, preservedOffset)
    setTocDeleteCandidate(null)
    setTocMutation('delete')
    showToast('正在删除目录…')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)))
      const nextDocument = getCachedReaderDocument(next)
      rememberReaderDocument(next, nextDocument)
      const reader = readerRef.current
      if (reader) {
        renderReaderWindow(reader, next, preservedOffset)
        readerLocationIndexRef.current = null
        requestAnimationFrame(() => restoreReaderPosition(reader, next))
      }
      const paper = readerRef.current?.querySelector<HTMLElement>('.reader-paper')
      if (paper) paper.dataset.readerDocumentKey = readerDocumentCacheKey(next)
      activeBookRef.current = next
      setBooks((current) => current.map((book) => book.id === next.id ? next : book))
      await saveBook(next)
      showToast('已从目录移除该章节')
    } catch {
      showToast('目录修改保存失败，请稍后重试')
    } finally {
      setTocMutation(null)
    }
  }

  function clearReaderTextSelection() {
    window.getSelection()?.removeAllRanges()
    setReaderTextSelection(null)
  }

  async function addTextSelectionAsChapter(kind: 'title' | 'subtitle') {
    if (!activeBook || !readerTextSelection || tocMutation) return
    const currentDocument = getCachedReaderDocument(activeBook)
    let ownerChapter: Chapter | undefined
    let title = readerTextSelection.title
    let offset = readerTextSelection.offset
    let endOffset = readerTextSelection.endOffset
    let subtitleOffset: number | undefined
    let subtitleEndOffset: number | undefined
    if (kind === 'subtitle') {
      for (let index = currentDocument.chapters.length - 1; index >= 0; index -= 1) {
        if (currentDocument.chapters[index].offset < readerTextSelection.offset) {
          ownerChapter = currentDocument.chapters[index]
          break
        }
      }
      if (!ownerChapter) {
        showToast('副标题前没有可关联的章节')
        clearReaderTextSelection()
        return
      }
      const ownerIndex = currentDocument.chapters.findIndex((chapter) => chapter.id === ownerChapter!.id)
      const nextChapter = currentDocument.chapters[ownerIndex + 1]
      if (nextChapter && readerTextSelection.offset >= nextChapter.offset) {
        showToast('请选择当前章节内的副标题')
        clearReaderTextSelection()
        return
      }
      const ownerBlock = currentDocument.blocks.find((block) => block.offset === ownerChapter!.offset)
      const mainTitle = ownerBlock?.text.trim().replace(/\s+/g, ' ') || ownerChapter.title
      title = `${mainTitle} ${readerTextSelection.title}`.slice(0, 160)
      offset = ownerChapter.offset
      endOffset = (activeBook.chapterAdditions ?? []).find((item) => item.offset === ownerChapter!.offset)?.endOffset
        ?? (ownerBlock ? ownerBlock.offset + ownerBlock.text.length : ownerChapter.offset + mainTitle.length)
      subtitleOffset = readerTextSelection.offset
      subtitleEndOffset = readerTextSelection.endOffset
    }
    const addition: ChapterAddition = {
      offset,
      endOffset,
      title,
      subtitleOffset,
      subtitleEndOffset,
    }
    if (kind === 'title' && currentDocument.chapters.some((chapter) => chapter.offset === addition.offset)) {
      showToast('这一段已经在目录中')
      clearReaderTextSelection()
      return
    }
    const next = {
      ...activeBook,
      chapterAdditions: [...(activeBook.chapterAdditions ?? []).filter((item) => item.offset !== addition.offset), addition],
    }
    const nextDocument = readerDocumentWithManualChapter(currentDocument, addition)
    setTocMutation('add')
    showToast('正在添加目录…')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)))
      rememberReaderDocument(next, nextDocument)
      const reader = readerRef.current
      if (reader) {
        renderReaderWindow(reader, next, addition.offset)
        readerLocationIndexRef.current = null
      }
      const paper = readerRef.current?.querySelector<HTMLElement>('.reader-paper')
      if (paper) paper.dataset.readerDocumentKey = readerDocumentCacheKey(next)
      activeBookRef.current = next
      setBooks((current) => current.map((book) => book.id === next.id ? next : book))
      clearReaderTextSelection()
      if (reader) {
        requestAnimationFrame(() => restoreReaderPosition(reader, bookAtTextOffset(next, addition.offset)))
      }
      await saveBook(next)
      if (kind === 'title') {
        const occupiedOffsets = new Set(nextDocument.chapters.map((chapter) => chapter.offset))
        const matches = manualChapterMatchCandidates(next.content, addition, occupiedOffsets)
        if (matches.length) setBatchChapterSuggestion({ bookId: next.id, title: addition.title, additions: matches })
        else showToast('已添加到目录')
      } else showToast('已设为副标题')
    } catch {
      showToast('添加目录失败，请稍后重试')
    } finally {
      setTocMutation(null)
    }
  }

  async function confirmBatchChapterAddition() {
    const suggestion = batchChapterSuggestion
    const book = activeBookRef.current
    if (!suggestion || !book || suggestion.bookId !== book.id || tocMutation) {
      setBatchChapterSuggestion(null)
      return
    }
    const currentDocument = getCachedReaderDocument(book)
    const occupiedOffsets = new Set(currentDocument.chapters.map((chapter) => chapter.offset))
    const additions = suggestion.additions.filter((addition) => !occupiedOffsets.has(addition.offset))
    setBatchChapterSuggestion(null)
    if (!additions.length) {
      showToast('匹配位置已经在目录中')
      return
    }
    const additionsByOffset = new Map((book.chapterAdditions ?? []).map((addition) => [addition.offset, addition]))
    for (const addition of additions) additionsByOffset.set(addition.offset, addition)
    const next = { ...book, chapterAdditions: [...additionsByOffset.values()] }
    let nextDocument = currentDocument
    for (const addition of additions) nextDocument = readerDocumentWithManualChapter(nextDocument, addition)
    setTocMutation('add')
    showToast(`正在批量添加 ${additions.length} 个目录…`)
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)))
      rememberReaderDocument(next, nextDocument)
      const reader = readerRef.current
      if (reader) {
        renderReaderWindow(reader, next, book.textOffset)
        readerLocationIndexRef.current = null
        requestAnimationFrame(() => restoreReaderPosition(reader, bookAtTextOffset(next, book.textOffset)))
      }
      const paper = reader?.querySelector<HTMLElement>('.reader-paper')
      if (paper) paper.dataset.readerDocumentKey = readerDocumentCacheKey(next)
      activeBookRef.current = next
      setBooks((current) => current.map((item) => item.id === next.id ? next : item))
      await saveBook(next)
      showToast(`已批量添加 ${additions.length} 个目录`)
    } catch {
      showToast('批量添加目录失败，请稍后重试')
    } finally {
      setTocMutation(null)
    }
  }

  function startTocChapterLongPress(chapter: Chapter, event: React.PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (tocLongPressTimer.current !== null) window.clearTimeout(tocLongPressTimer.current)
    tocLongPressed.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    tocLongPressTimer.current = window.setTimeout(() => {
      tocLongPressed.current = true
      setTocDeleteCandidate(chapter)
    }, 650)
  }

  function cancelTocChapterLongPress(event?: React.PointerEvent<HTMLButtonElement>) {
    if (tocLongPressTimer.current !== null) window.clearTimeout(tocLongPressTimer.current)
    tocLongPressTimer.current = null
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  async function confirmDeleteBook(removeSource = false) {
    if (!deleteCandidate) return
    if (removeSource) {
      if (!isNativeAndroid() || !deleteCandidate.sourceUri) {
        showToast('这本书没有可删除的源 TXT 文件。')
        return
      }
      setActivityMessage('正在删除源文件')
      setBusy(true)
      try {
        await deleteNativeFile(deleteCandidate.sourceUri)
      } catch (error) {
        showToast(error instanceof Error ? `源 TXT 文件未删除：${error.message}` : '源 TXT 文件未删除，书架内容已保留。')
        return
      } finally {
        setBusy(false)
        setActivityMessage(null)
      }
    }
    await deleteBook(deleteCandidate.id)
    readerChapterRecognitionCache.delete(deleteCandidate.id)
    setBooks((current) => current.filter((item) => item.id !== deleteCandidate.id))
    setSelectedBookIds((current) => current.filter((id) => id !== deleteCandidate.id))
    if (bookActionCandidate?.id === deleteCandidate.id) setBookActionCandidate(null)
    setDeleteCandidate(null)
    showToast(removeSource ? '书籍和源 TXT 文件已删除。' : '书籍已从书架删除。')
  }

  async function exportBackup() {
    if (!books.length && !customFonts.length) {
      showToast('暂无书籍或自定义字体可备份。')
      return
    }
    setActivityMessage('正在生成备份')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      const data = createBackup(books, settings, customFonts)
      if (isNativeAndroid()) await shareNativeBackup(data, backupFileName())
      else downloadBackup(data)
      showToast(`已备份 ${books.length} 本书和 ${customFonts.length} 个自定义字体。`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '备份生成失败。')
    } finally {
      setActivityMessage(null)
    }
  }

  async function handleBackupFile(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    setActivityMessage('正在读取备份')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      setRestorePayload(readBackup(await file.arrayBuffer()))
      setSheet(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '备份读取失败。')
    } finally {
      setActivityMessage(null)
      if (backupInputRef.current) backupInputRef.current.value = ''
    }
  }

  async function restoreBackup(mode: 'merge' | 'replace') {
    if (!restorePayload) return
    setActivityMessage('正在恢复备份')
    try {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      let nextBooks = restorePayload.books
      let nextFonts = restorePayload.customFonts
      let nextSettings = normalizeSettings(restorePayload.settings)
      if (mode === 'merge') {
        const fingerprints = new Set(restorePayload.books.map((book) => book.fingerprint))
        nextBooks = [...restorePayload.books, ...books.filter((book) => !fingerprints.has(book.fingerprint))]
        nextSettings = {
          ...normalizeSettings(restorePayload.settings),
          bookGroups: [...normalizeSettings(restorePayload.settings).bookGroups, ...settings.bookGroups.filter((group) => !normalizeSettings(restorePayload.settings).bookGroups.some((restored) => restored.id === group.id))],
        }
        const restoredFontIds = new Set(restorePayload.customFonts.map((font) => font.id))
        nextFonts = [...restorePayload.customFonts, ...customFonts.filter((font) => !restoredFontIds.has(font.id))]
      }
      const loadedFonts = await activateCustomFonts(nextFonts)
      const selectedFontId = customFontId(nextSettings.fontFamily)
      if (selectedFontId && !loadedFonts.some((font) => font.id === selectedFontId)) nextSettings = { ...nextSettings, fontFamily: 'serif' }
      await replaceLibrary(nextBooks, nextSettings, loadedFonts)
      readerChapterRecognitionCache.clear()
      setBooks(nextBooks.sort((a, b) => b.lastReadAt - a.lastReadAt))
      setSettings(nextSettings)
      setRestorePayload(null)
      showToast(`恢复完成，共 ${nextBooks.length} 本书和 ${loadedFonts.length} 个自定义字体。`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '备份恢复失败。')
    } finally {
      setActivityMessage(null)
    }
  }

  const appTheme = view === 'reader' ? settings.theme : 'paper'

  return (
    <div className={`app theme-${appTheme}`}>
      <input
        ref={txtInputRef}
        className="visually-hidden"
        type="file"
        accept=".txt,.zip,text/plain,application/zip,application/x-zip-compressed"
        multiple
        onChange={(event) => void handleTxtFiles(event.target.files)}
      />
      <input
        ref={backupInputRef}
        className="visually-hidden"
        type="file"
        accept=".reader-backup,application/octet-stream"
        onChange={(event) => void handleBackupFile(event.target.files)}
      />
      <input
        ref={folderInputRef}
        className="visually-hidden"
        type="file"
        accept=".txt,.zip,text/plain,application/zip,application/x-zip-compressed"
        multiple
        onChange={(event) => void handleFolderFiles(event.target.files)}
      />
      <input
        ref={customFontInputRef}
        className="visually-hidden"
        type="file"
        accept=".ttf,.otf,.hwt,font/ttf,font/otf,application/x-font-ttf,application/zip,application/octet-stream"
        onChange={(event) => void handleCustomFontFile(event.target.files?.[0])}
      />

      {view === 'shelf' && (
        <main className={`shelf-view ${mainTab === 'settings' ? 'settings-view' : ''}`} onClick={mainTab === 'shelf' && !groupBatchAddTargetId ? clearBookSelectionFromBlank : undefined}>
          <header className="topbar">
            <div className="topbar-title">
              <p className="eyebrow">一页</p>
              <h1>{mainTab === 'shelf' ? '书架' : '设置'}</h1>
            </div>
            {mainTab === 'shelf' && (
              <div className="topbar-actions">
                {selectedBooks.length > 0 && !groupBatchAddTargetId ? (
                  <button className="icon-button" aria-label={`分享已选 ${selectedBooks.length} 本书`} onClick={() => void shareBooks(selectedBooks)}><Icon name="share" /></button>
                ) : (
                  <>
                    {searchOpen ? (
                      <div ref={searchFieldRef} className="search-field">
                        <Icon name="search" size={18} />
                        <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索书名" aria-label="搜索书名" />
                      </div>
                    ) : (
                      <button className="icon-button" aria-label="搜索书籍" onClick={() => setSearchOpen(true)}><Icon name="search" /></button>
                    )}
                    <button className="icon-button library-menu-button" aria-label="书架布局" disabled={!books.length} onClick={() => setSheet('library-actions')}>
                      <Icon name="grid-more" />
                    </button>
                  </>
                )}
              </div>
            )}
          </header>

          {mainTab === 'settings' ? (
            <section className="settings-page" aria-label="设置">
              <div className="settings-section file-section">
                <p className="section-label">书籍文件</p>
                <button className="action-card" onClick={() => void startTxtImport()}>
                  <span className="action-icon"><Icon name="plus" /></span>
                  <span><strong>导入 TXT</strong><small>从手机文件中选择一本或多本书</small></span>
                  <Icon name="back" size={18} />
                </button>
              </div>
              <div className="settings-section common-path-section">
                <div className="section-heading">
                  <p className="section-label">常用路径</p>
                  <button className="add-path-button" aria-label="添加常用路径" title="添加常用路径" onClick={() => void addCommonFolder()}><Icon name="plus" size={19} /></button>
                </div>
                {settings.commonFolders.length > 0 && (
                  <div className="folder-list" aria-label="已添加的常用文件夹">
                    {settings.commonFolders.map((folder) => (
                      <div className="folder-row" key={folder.id}>
                        <button className={`folder-open ${scanningFolderId === folder.id ? 'scanning' : ''}`} disabled={scanningFolderId !== null} onClick={() => void openCommonFolder(folder)}>
                          {scanningFolderId === folder.id ? <span className="spinner" /> : <Icon name="folder" size={18} />}
                          <span className="folder-info"><strong>{folder.name}</strong><small>{scanningFolderId === folder.id ? '正在查找书籍…' : folder.displayPath}</small></span>
                        </button>
                        <button className="folder-remove" aria-label={`移除常用文件夹 ${folder.name}`} onClick={() => void removeCommonFolder(folder.id)}><Icon name="close" size={16} /></button>
                      </div>
                    ))}
                  </div>
                )}
                {settings.commonFolders.length === 0 && <p className="empty-paths">还没有常用路径</p>}
              </div>
              <div className="settings-section reader-preferences-section">
                <p className="section-label">阅读设置</p>
                <ReaderPreferences settings={settings} fontLabel={activeFontLabel} onUpdate={updateSettings} onTheme={applyReaderTheme} onOpenFonts={() => { setFontPickerReturnSheet(null); setSheet('fonts') }} />
              </div>
              <div className="settings-section backup-section">
                <p className="section-label">本机数据</p>
                <button className="action-card" onClick={() => void exportBackup()}>
                  <span className="action-icon"><Icon name="download" /></span>
                  <span><strong>导出完整备份</strong><small>包含 {books.length} 本书和 {customFonts.length} 个自定义字体</small></span>
                  <Icon name="back" size={18} />
                </button>
                <button className="action-card" onClick={() => backupInputRef.current?.click()}>
                  <span className="action-icon restore"><Icon name="upload" /></span>
                  <span><strong>从备份恢复</strong><small>选择 .reader-backup 文件</small></span>
                  <Icon name="back" size={18} />
                </button>
                <p className="backup-warning">备份文件未加密，其中包含原始 TXT 内容和自定义字体文件，请妥善保管。</p>
              </div>
            </section>
          ) : busy ? (
            <div className="loading-state"><span className="spinner" />正在整理书架…</div>
          ) : books.length === 0 ? (
            <section className="empty-state">
              <div className="empty-illustration" aria-hidden="true">
                <span className="book-shape book-one" />
                <span className="book-shape book-two" />
                <span className="book-shape book-three" />
                <span className="reading-sun" />
              </div>
              <p className="empty-kicker">从一本书开始</p>
              <h2>书架还是空的</h2>
              <button className="primary-button" onClick={() => setMainTab('settings')}>
                <Icon name="plus" size={20} />添加书籍
              </button>
            </section>
          ) : shelfItems.length === 0 ? (
            <section className="no-results-state">
              <Icon name="search" size={26} />
              <h2>没有找到这本书</h2>
              <p>换个书名试试。</p>
            </section>
          ) : (
            <>
              <section className="library-heading">
                <div><span>{books.length}</span> 本书</div>
                {!searchQuery && <button onClick={() => { setGroupName(''); setGroupNameError(''); setSheet('create-group') }}><Icon name="folder-plus" size={18} />新建分组</button>}
              </section>
              <section className={`book-list columns-${settings.shelfColumns} ${draggedBookId ? 'is-dragging-book' : ''}`} aria-label="我的书架">
                {shelfItems.map((item) => item.kind === 'book' ? (
                  <article className={`book-card ${draggedBookId === item.book.id ? 'dragging' : ''} ${selectedBookIds.includes(item.book.id) ? 'selected' : ''}`} key={item.book.id}>
                    <button
                      className="book-main"
                      onPointerDown={groupBatchAddTargetId ? undefined : (event) => startBookLongPress(item.book.id, event)}
                      onPointerMove={groupBatchAddTargetId ? undefined : moveBookLongPress}
                      onPointerUp={groupBatchAddTargetId ? undefined : (event) => void finishBookLongPress(event)}
                      onPointerCancel={groupBatchAddTargetId ? undefined : cancelBookDrag}
                      onClick={() => {
                        if (suppressBookClick.current) {
                          suppressBookClick.current = false
                          return
                        }
                        if (groupBatchAddTargetId) {
                          if (item.book.groupId !== groupBatchAddTargetId) toggleBookSelection(item.book.id)
                          return
                        }
                        openBook(item.book)
                      }}
                    >
                      <span className={`book-cover cover-${getBookCoverIndex(item.book)}`}>
                        <span>{item.book.title}</span>
                        <small>TXT</small>
                      </span>
                      <span className="shelf-book-progress">{formatProgressPercent(item.book.progress)}</span>
                    </button>
                    <button className={`book-select-button ${selectedBookIds.includes(item.book.id) ? 'selected' : ''}`} disabled={Boolean(groupBatchAddTargetId && item.book.groupId === groupBatchAddTargetId)} aria-label={`${selectedBookIds.includes(item.book.id) ? '取消选择' : '选择'}《${item.book.title}》`} aria-pressed={selectedBookIds.includes(item.book.id)} onClick={() => toggleBookSelection(item.book.id)}>
                      <Icon name="check" size={14} />
                    </button>
                  </article>
                ) : (
                  <article className={`group-card ${dropGroupId === item.group.id ? 'drop-target' : ''}`} data-group-id={item.group.id} key={item.group.id}>
                    <button className="group-main" data-group-id={item.group.id} onClick={() => { if (!groupBatchAddTargetId) setSelectedBookIds([]); setActiveGroupId(item.group.id); setSheet('group') }}>
                      <span className="group-cover" aria-hidden="true">
                        {item.group.books.length === 0 ? <Icon name="folder" size={29} /> : Array.from({ length: 4 }, (_, index) => item.group.books[index]
                          ? <i className="group-mini-book" key={item.group.books[index].id}>
                              <span className={`book-cover cover-${getBookCoverIndex(item.group.books[index])}`}>
                                <span>{item.group.books[index].title}</span>
                                <small>TXT</small>
                              </span>
                            </i>
                          : <i className="group-mini-book empty" key={`empty-${index}`} />)}
                      </span>
                      <span className="group-meta">
                        <span className="shelf-book-label">{item.group.name}</span>
                        <small>{item.group.books.length}</small>
                      </span>
                    </button>
                  </article>
                ))}
              </section>
              {dragPreview && <div className="drag-preview" aria-hidden="true" style={{ left: dragPreview.x - dragPreview.offsetX, top: dragPreview.y - dragPreview.offsetY, width: dragPreview.width }}>
                <span className={`book-cover cover-${getBookCoverIndex(dragPreview.book)}`}>
                  <span>{dragPreview.book.title}</span>
                  <small>TXT</small>
                </span>
                <span className="shelf-book-progress">{formatProgressPercent(dragPreview.book.progress)}</span>
              </div>}
            </>
          )}
          {groupBatchAddTarget ? (
            <nav className="bottom-nav selection-bottom-nav group-batch-add-nav" aria-label={`添加书籍到${groupBatchAddTarget.name}`}>
              <button onClick={cancelGroupBatchAdd}><Icon name="close" size={21} /><span>取消</span></button>
              <button className="confirm" disabled={!selectedBooks.length} onClick={() => void addSelectedBooksToActiveGroup()}><Icon name="plus" size={21} /><span>{selectedBooks.length ? `添加 ${selectedBooks.length} 本` : `添加到 ${groupBatchAddTarget.name}`}</span></button>
            </nav>
          ) : selectedBooks.length > 0 ? (
            <nav className={`bottom-nav selection-bottom-nav ${selectedBooks.length === 1 ? 'selection-bottom-nav-with-rename' : ''}`} aria-label="已选书籍操作">
              {selectedBooks.length === 1 && <button onClick={startRenameSelectedBook}><Icon name="type" size={21} /><span>重命名</span></button>}
              <button onClick={() => setSheet('move-selection')}><Icon name="folder" size={21} /><span>移动到</span></button>
              <button className="danger" onClick={requestDeleteSelectedBooks}><Icon name="trash" size={21} /><span>删除</span></button>
            </nav>
          ) : (
            <nav className="bottom-nav" aria-label="主导航">
              <button className={mainTab === 'shelf' ? 'active' : ''} onClick={() => changeMainTab('shelf')}>
                <Icon name="book" size={21} /><span>书架</span>
              </button>
              <button className={mainTab === 'settings' ? 'active' : ''} onClick={() => changeMainTab('settings')}>
                <Icon name="settings" size={21} /><span>设置</span>
              </button>
            </nav>
          )}
        </main>
      )}
      {activeBook && (
        <main
          className={`reader-view mode-${settings.pageTurnMode} ${view !== 'reader' ? 'reader-inactive' : ''} ${view === 'reader' && !readerPositionReady ? 'reader-position-pending' : ''} ${sheet === 'settings' ? 'reader-settings-open' : ''}`}
          aria-hidden={view !== 'reader'}
          style={{
            '--reader-bg': settings.backgroundColor,
            '--reader-ink': settings.textColor,
            '--reader-font': readerFontCss(settings.fontFamily, settings.followSystemFont),
          } as React.CSSProperties}
          >
            <header className={`reader-header ${!readerChromeVisible ? 'chrome-hidden' : ''}`}>
            <button className="icon-button" aria-label="返回书架" onClick={closeReader}><Icon name="back" /></button>
            <div><strong>{activeBook.title}</strong></div>
          </header>
          <div
            ref={readerRef}
            className={`reader-scroll mode-${settings.pageTurnMode}`}
            onScroll={handleReaderScroll}
            onClick={handleReaderClick}
            onPointerDown={startReaderGesture}
            onPointerUp={finishReaderGesture}
            onPointerCancel={cancelReaderGesture}
            style={{
              fontSize: `${settings.fontSize}px`,
              lineHeight: settings.lineHeight,
              '--reader-line-height': `${settings.fontSize * settings.lineHeight}px`,
              '--paragraph-gap': `${settings.paragraphSpacing === 0.3 ? 0 : settings.paragraphSpacing === 0.7 ? 1 : 2}lh`,
              '--paragraph-indent': `${settings.paragraphIndent}em`,
              '--reader-page-margin': `${settings.pageMargin}px`,
            } as React.CSSProperties}
          />
          {view === 'reader' && !readerPositionReady && <div className="reader-opening-state" role="status" aria-label="正在打开书籍"><span className="spinner" /></div>}
          <nav className="reader-bottom-bar" aria-label="阅读导航">
            <button onClick={openProgressJump} aria-label="跳转阅读进度">{readerProgressLabel()}</button>
            <time>{readerClock}</time>
            <strong>{activeChapter?.title ?? '未分章'}</strong>
          </nav>
          <button className={`reader-toc-fab ${!readerChromeVisible ? 'chrome-hidden' : ''}`} aria-label="打开章节目录" onClick={() => setSheet('toc')}><Icon name="list" size={20} /></button>
          <button className={`reader-settings-fab ${!readerChromeVisible ? 'chrome-hidden' : ''}`} aria-label="阅读设置" onClick={() => setSheet('settings')}><Icon name="type" size={20} /></button>
          {readerTextSelection && !sheet && (
            <div ref={readerSelectionToolbarRef} className="reader-selection-toolbar" style={{ left: readerTextSelection.left, top: readerTextSelection.top }}>
              <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => void addTextSelectionAsChapter('title')} disabled={tocMutation === 'add'}>{tocMutation === 'add' ? '处理中' : '设为标题'}</button>
              <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => void addTextSelectionAsChapter('subtitle')} disabled={tocMutation === 'add'}>设为副标题</button>
            </div>
          )}
        </main>
      )}

      {activityMessage && (
        <div className="activity-overlay" role="status" aria-live="polite">
          <span className="spinner" />
          <strong>{activityMessage}</strong>
          <small>处理内容较多时需要一点时间，请稍候</small>
        </div>
      )}

      {scanningFolderId && !folderBrowser && (
        <div className="folder-scan-page" role="status" aria-live="polite">
          <span className="spinner" />
          <strong>正在查看 {settings.commonFolders.find((folder) => folder.id === scanningFolderId)?.name ?? '常用路径'}</strong>
          <small>正在查找这个文件夹里的书籍，请稍候</small>
        </div>
      )}

      {folderBrowser && (
        <div className="folder-browser-page">
          <section className="folder-browser-shell" aria-labelledby="folder-title">
            <div className="dialog-title-row">
              <button className="icon-button" aria-label="返回设置" onClick={() => void closeFolderBrowser(folderBrowser)}><Icon name="back" /></button>
              <div><h2 id="folder-title">选择书籍</h2><small>{folderBrowser.folder.name}</small></div>
            </div>
            {folderBrowser.archiveReader && <section className="archive-import-options" aria-label="压缩包导入选项">
              <div className="archive-group-row">
                <span className="archive-group-label">自动新建分组</span>
                {folderBrowser.archiveCreateGroup && <input
                  className="archive-group-name-input"
                  value={folderBrowser.archiveGroupName || ''}
                  onChange={(event) => setFolderBrowser((current) => current ? { ...current, archiveGroupName: event.target.value } : current)}
                  placeholder="分组名称"
                  maxLength={18}
                  aria-label="分组名称"
                />}
                <label className="archive-group-switch" aria-label="自动新建分组">
                  <input
                    type="checkbox"
                    checked={Boolean(folderBrowser.archiveCreateGroup)}
                    onChange={(event) => setFolderBrowser((current) => current ? { ...current, archiveCreateGroup: event.target.checked } : current)}
                  />
                  <i aria-hidden="true" />
                </label>
              </div>
              {folderBrowser.archivePasswordRequired && <label className="archive-option-field archive-password-field">
                <span>压缩包密码</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={folderBrowser.archivePassword || ''}
                  onChange={(event) => setFolderBrowser((current) => current ? { ...current, archivePassword: event.target.value, archivePasswordError: undefined } : current)}
                  placeholder="输入密码"
                  aria-label="压缩包密码"
                />
                {folderBrowser.archivePasswordError && <em>{folderBrowser.archivePasswordError}</em>}
              </label>}
            </section>}
            {(folderBrowser.files.length > 6 || folderSearchQuery) && <label className="folder-browser-search">
              <Icon name="search" size={17} />
              <input value={folderSearchQuery} onChange={(event) => setFolderSearchQuery(event.target.value)} placeholder="搜索书名或文件夹" aria-label="搜索书名或文件夹" />
              {folderSearchQuery && <button type="button" aria-label="清除搜索" onClick={() => setFolderSearchQuery('')}><Icon name="close" size={14} /></button>}
            </label>}
            <div className="folder-browser-toolbar">
              <span>{folderBrowser.archiveReader
                ? `${folderSearchQuery.trim() ? `${visibleFolderFiles.length} / ${folderBrowser.files.length}` : folderBrowser.files.length} 本书`
                : `按修改时间 · ${folderSearchQuery.trim() ? `${visibleFolderFiles.length} / ${folderBrowser.files.length}` : folderBrowser.files.length} 个文件`}</span>
              <button disabled={!selectableFolderFileIds.length} onClick={toggleAllFolderFiles}>{allFolderFilesSelected ? '取消全选' : '全选'}</button>
            </div>
            <div className={`folder-file-list ${folderBrowser.archiveReader ? 'archive-file-list' : ''}`}>
              {visibleFolderFiles.length ? visibleFolderFileGroups.map((group) => (
                <section className="folder-date-group" key={group.label}>
                  {group.label && <div className="folder-date-heading"><strong>{group.label}</strong><span>|</span><small>{group.files.length} 项</small></div>}
                  {group.files.map((file) => {
                    const imported = isFolderFileImported(file)
                      const selected = selectedFolderFiles.includes(folderFileId(file))
                    return (
                      <button key={folderFileId(file)} className={`folder-file ${selected ? 'selected' : ''} ${imported ? 'imported' : ''}`} onClick={() => toggleFolderFile(file)} disabled={imported}>
                        <span className="folder-file-info"><strong>{file.name}</strong><small>{formatSize(file.size)}<b>|</b>{formatFolderFileDate(file.modifiedAt)}</small></span>
                        {imported && <em>已导入</em>}
                        <span className="file-check">{imported || selected ? <Icon name="check" size={15} /> : null}</span>
                      </button>
                    )
                  })}
                </section>
              )) : <div className="folder-empty">没有找到匹配的书籍</div>}
            </div>
            <button
              className="primary-button full-button"
              disabled={!selectedFolderFiles.length || Boolean(folderBrowser.archiveReader && selectedFolderFiles.some((id) => {
                const file = folderBrowser.files.find((item) => folderFileId(item) === id)
                return file && folderBrowser.archiveEntries?.get(folderFileId(file))?.encrypted && !folderBrowser.archivePassword
              }))}
              onClick={() => void confirmFolderFiles()}
            >{selectedFolderFiles.length
              ? `导入 ${selectedFolderFiles.length} ${folderBrowser.archiveReader ? '本书' : '个文件'}`
              : '选择书籍后导入'}</button>
          </section>
        </div>
      )}

      {restorePayload && (
        <div className="modal-backdrop">
          <section className="dialog restore-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-title">
            <div className="restore-icon"><Icon name="archive" size={26} /></div>
            <p className="eyebrow">备份有效</p>
            <h2 id="restore-title">发现 {restorePayload.manifest.bookCount} 本书</h2>
            <p>包含 {restorePayload.customFonts.length} 个自定义字体</p>
            <p>备份时间：{new Date(restorePayload.manifest.createdAt).toLocaleString('zh-CN')}</p>
            <div className="restore-actions">
              <button className="primary-button" onClick={() => void restoreBackup('merge')}>与现有书架合并</button>
              <button className="secondary-button danger" onClick={() => void restoreBackup('replace')}>清空并恢复</button>
              <button className="text-button" onClick={() => setRestorePayload(null)}>取消</button>
            </div>
          </section>
        </div>
      )}

      {batchChapterSuggestion && (
        <div className="modal-backdrop">
          <section className="dialog batch-chapter-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-chapter-title">
            <p className="eyebrow">发现相同标题</p>
            <h2 id="batch-chapter-title">另外找到 {batchChapterSuggestion.additions.length} 处</h2>
            <p>这些位置的标题文字、缩进和前后空行结构一致。是否一起添加到目录？</p>
            <strong className="batch-chapter-preview">{batchChapterSuggestion.title}</strong>
            <div className="delete-actions">
              <button className="secondary-button" onClick={() => { setBatchChapterSuggestion(null); showToast('已只添加当前标题') }}>只加当前</button>
              <button className="primary-button" onClick={() => void confirmBatchChapterAddition()}>全部添加</button>
            </div>
          </section>
        </div>
      )}

      {deleteCandidate && (
        <div className="modal-backdrop">
          <section className="dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <div className="restore-icon delete-icon"><Icon name="trash" size={24} /></div>
            <p className="eyebrow">从书架移除</p>
            <h2 id="delete-title">删除《{deleteCandidate.title}》？</h2>
            <p>{deleteCandidate.sourceUri && isNativeAndroid() ? '可以只移除书架内容，或一并删除原始 TXT 文件。' : '阅读进度也会一并删除。'}</p>
            <div className="delete-actions">
              <button className="secondary-button" onClick={() => setDeleteCandidate(null)}>取消</button>
              <button className="primary-button delete-confirm" onClick={() => void confirmDeleteBook(false)}>只从书架删除</button>
            </div>
            {deleteCandidate.sourceUri && isNativeAndroid() && (
              <button className="source-delete-button" onClick={() => void confirmDeleteBook(true)}>同时删除源 TXT 文件</button>
            )}
          </section>
        </div>
      )}

      {batchDeleteCandidates.length > 0 && (
        <div className="modal-backdrop">
          <section className="dialog delete-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-delete-title">
            <div className="restore-icon delete-icon"><Icon name="trash" size={24} /></div>
            <p className="eyebrow">批量移除</p>
            <h2 id="batch-delete-title">删除选中的 {batchDeleteCandidates.length} 本书？</h2>
            <p>阅读进度也会一并删除，但不会删除手机中的原始 TXT 文件。</p>
            <div className="delete-actions">
              <button className="secondary-button" onClick={() => setBatchDeleteCandidates([])}>取消</button>
              <button className="primary-button delete-confirm" onClick={() => void confirmBatchDeleteBooks()}>从书架删除</button>
            </div>
          </section>
        </div>
      )}

      {sheet === 'library-actions' && (
        <div className="library-popover-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(null) }}>
          <section className="library-popover shelf-options-popover" role="dialog" aria-modal="true" aria-label="书架排序和筛选">
            <div className="library-option-section">
              <span className="library-option-label">排序</span>
              <div className="library-choice-list">
                {SHELF_SORT_OPTIONS.map((option) => (
                  <button className={`library-columns-option ${settings.shelfSort === option.value ? 'active' : ''}`} key={option.value} aria-pressed={settings.shelfSort === option.value} onClick={() => void updateSettings({ shelfSort: option.value })}>
                    <span>{option.label}</span>{settings.shelfSort === option.value && <Icon name="check" size={16} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="library-option-section">
              <span className="library-option-label">筛选</span>
              <div className="library-choice-list">
                {SHELF_FILTER_OPTIONS.map((option) => (
                  <button className={`library-columns-option ${settings.shelfFilter === option.value ? 'active' : ''}`} key={option.value} aria-pressed={settings.shelfFilter === option.value} onClick={() => void updateSettings({ shelfFilter: option.value })}>
                    <span>{option.label}</span>{settings.shelfFilter === option.value && <Icon name="check" size={16} />}
                  </button>
                ))}
              </div>
            </div>
            <div className="library-option-section">
              <span className="library-option-label">每行书籍</span>
              <div className="library-choice-list library-columns-list">
            {([3, 4, 5] as const).map((columns) => (
                  <button className={`library-columns-option ${settings.shelfColumns === columns ? 'active' : ''}`} key={columns} aria-pressed={settings.shelfColumns === columns} onClick={() => void updateSettings({ shelfColumns: columns })}>
                    <span>{columns} 本</span>{settings.shelfColumns === columns && <Icon name="check" size={17} />}
                  </button>
            ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {sheet === 'move-selection' && (
        <div className="library-popover-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(null) }}>
          <section className="library-popover" role="dialog" aria-modal="true" aria-label="移动到分组">
            <div className="library-popover-title"><strong>移动到</strong><button aria-label="关闭移动菜单" onClick={() => setSheet(null)}><Icon name="close" size={16} /></button></div>
            <button className="library-popover-action" disabled={!selectedBooks.length || selectedBooks.every((book) => !book.groupId)} onClick={() => void moveSelectedBooksToGroup(undefined)}>
              <Icon name="book" size={17} /><span>书架</span>
            </button>
            {settings.bookGroups.map((group) => (
              <button className="library-popover-action" key={group.id} disabled={!selectedBooks.length || selectedBooks.every((book) => book.groupId === group.id)} onClick={() => void moveSelectedBooksToGroup(group.id)}>
                <Icon name="folder" size={17} /><span>{group.name}</span>
              </button>
            ))}
            {!settings.bookGroups.length && <p className="selection-empty-note">还没有分组</p>}
          </section>
        </div>
      )}

      {(sheet === 'book-actions' || sheet === 'rename-book') && bookActionCandidate && (
        <div className={`modal-backdrop sheet-backdrop book-action-backdrop ${sheet === 'rename-book' ? 'group-editor-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) { setSheet(renameBookReturnToGroup && activeGroupId ? 'group' : null); setRenameBookReturnToGroup(false); setBookActionCandidate(null) } }}>
          <section className={`bottom-sheet book-action-sheet ${sheet === 'rename-book' ? 'group-editor-dialog' : ''}`} role="dialog" aria-modal="true">
            <div className="dialog-handle" />
            {sheet === 'rename-book' ? (
              <>
                <div className="sheet-title"><h2>重命名书籍</h2></div>
                <div className="group-name-form">
                  <input id="book-name" aria-label="书架书名" autoFocus maxLength={80} value={bookName} onChange={(event) => { setBookName(event.target.value); setBookNameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') void renameBook() }} placeholder="输入书名" />
                  {bookNameError && <small>{bookNameError}</small>}
                  {bookActionCandidate.sourceUri && isNativeAndroid() && <p className="rename-source-note">将同时尝试修改手机中的原 TXT 文件名。</p>}
                  <button className="editor-submit" onClick={() => void renameBook()}>保存书名</button>
                </div>
              </>
            ) : (
              <>
                <div className="sheet-title"><div><p className="eyebrow">书籍操作</p><h2>{bookActionCandidate.title}</h2></div></div>
                <button className="reader-action-row" onClick={() => { setBookName(bookActionCandidate.title); setBookNameError(''); setSheet('rename-book') }}><span><strong>重命名书籍</strong><small>{bookActionCandidate.sourceUri && isNativeAndroid() ? '同时尝试修改原 TXT 文件名' : '仅修改书架显示名称'}</small></span><Icon name="back" size={18} /></button>
                {bookActionCandidate.groupId && <button className="reader-action-row" onClick={() => { void moveBookToGroup(bookActionCandidate.id, undefined); setBookActionCandidate(null); setSheet(null) }}><span><strong>移回书架</strong><small>从当前分组中移出</small></span><Icon name="back" size={18} /></button>}
                <button className="book-delete-action" onClick={() => { setDeleteCandidate(bookActionCandidate); setBookActionCandidate(null); setSheet(null) }}>删除书籍</button>
              </>
            )}
          </section>
        </div>
      )}

      {(sheet === 'group' || sheet === 'create-group' || sheet === 'rename-group') && (
        <div className={`modal-backdrop sheet-backdrop group-backdrop ${sheet === 'create-group' || sheet === 'rename-group' ? 'group-editor-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelectedBookIds([]); setSheet(null); setActiveGroupId(null) } }}>
          <section className={`bottom-sheet group-sheet ${sheet === 'create-group' || sheet === 'rename-group' ? 'group-editor-dialog' : ''}`} role="dialog" aria-modal="true" onClick={clearBookSelectionFromBlank}>
            <div className="dialog-handle" />
            {sheet === 'create-group' || sheet === 'rename-group' ? (
              <>
                <div className="sheet-title"><h2>{sheet === 'create-group' ? '新建分组' : '重命名分组'}</h2></div>
                <div className="group-name-form">
                  <input id="group-name" aria-label="分组名称" autoFocus maxLength={18} value={groupName} onChange={(event) => { setGroupName(event.target.value); setGroupNameError('') }} onKeyDown={(event) => { if (event.key === 'Enter') void (sheet === 'create-group' ? createGroup() : renameActiveGroup()) }} placeholder="例如：已读、小说、待看" />
                  {groupNameError && <small>{groupNameError}</small>}
                  <button className="editor-submit" onClick={() => void (sheet === 'create-group' ? createGroup() : renameActiveGroup())}>{sheet === 'create-group' ? '创建分组' : '保存名称'}</button>
                </div>
              </>
            ) : activeGroup ? (
              <>
                <div className="sheet-title group-sheet-title">
                  <div className="group-title-block">
                    <h2><button className="group-name-button" onClick={() => { setGroupName(activeGroup.name); setGroupNameError(''); setSheet('rename-group') }}>{activeGroup.name}</button></h2>
                  </div>
                  {selectedGroupBooks.length > 0 && <button className="icon-button group-share-button" aria-label={`分享已选 ${selectedGroupBooks.length} 本书`} onClick={() => void shareBooks(selectedGroupBooks)}><Icon name="share" size={20} /></button>}
                </div>
                {activeGroup.books.length ? (
                  <section className={`group-book-grid columns-${settings.shelfColumns}`} aria-label={`${activeGroup.name}中的书籍`}>
                    {activeGroup.books.map((book) => (
                      <article className={`group-book-card ${selectedBookIds.includes(book.id) ? 'selected' : ''}`} key={book.id}>
                        <button className="group-book-main" onClick={() => { if (groupBatchAddTargetId) { if (book.groupId !== groupBatchAddTargetId) toggleBookSelection(book.id) } else openBook(book) }}>
                          <span className={`book-cover cover-${getBookCoverIndex(book)}`}><span>{book.title}</span><small>TXT</small></span>
                          <span>{formatProgressPercent(book.progress)}</span>
                        </button>
                        <button className={`book-select-button ${selectedBookIds.includes(book.id) ? 'selected' : ''}`} disabled={Boolean(groupBatchAddTargetId && book.groupId === groupBatchAddTargetId)} aria-label={`${selectedBookIds.includes(book.id) ? '取消选择' : '选择'}《${book.title}》`} aria-pressed={selectedBookIds.includes(book.id)} onClick={() => toggleBookSelection(book.id)}><Icon name="check" size={14} /></button>
                      </article>
                    ))}
                  </section>
                ) : <div className="group-empty"><Icon name="folder" size={29} /><p>长按书架中的书，拖到这个分组。</p></div>}
                {groupBatchAddTarget ? (
                  <nav className="bottom-nav selection-bottom-nav group-bottom-nav" aria-label={`添加书籍到${groupBatchAddTarget.name}`}>
                    <button onClick={() => { setSheet(null); setActiveGroupId(null) }}><Icon name="back" size={18} /><span>返回书架</span></button>
                    <button className="confirm" disabled={!selectedBooks.length} onClick={() => void addSelectedBooksToActiveGroup()}><Icon name="plus" size={18} /><span>{selectedBooks.length ? `添加 ${selectedBooks.length} 本` : '请选择'}</span></button>
                  </nav>
                ) : selectedGroupBooks.length > 0 ? (
                  <nav className={`bottom-nav selection-bottom-nav group-bottom-nav ${selectedGroupBooks.length === 1 ? 'group-bottom-nav-with-rename' : ''}`} aria-label="分组内已选书籍操作">
                    {selectedGroupBooks.length === 1 && <button onClick={startRenameSelectedBook}><Icon name="type" size={18} /><span>重命名</span></button>}
                    <button onClick={() => void removeSelectedBooksFromActiveGroup()}><Icon name="book" size={18} /><span>移出分组</span></button>
                    <button className="danger" onClick={requestDeleteSelectedBooks}><Icon name="trash" size={18} /><span>删除</span></button>
                  </nav>
                ) : <nav className="bottom-nav group-bottom-nav" aria-label="分组操作"><button onClick={openGroupBatchAdd}><Icon name="plus" size={18} /><span>批量添加</span></button><button className="danger" onClick={() => void dissolveActiveGroup()}><Icon name="folder" size={18} /><span>解散分组</span></button></nav>}
              </>
            ) : null}
          </section>
        </div>
      )}

      {sheet && sheet !== 'group' && sheet !== 'create-group' && sheet !== 'rename-group' && sheet !== 'book-actions' && sheet !== 'rename-book' && sheet !== 'library-actions' && sheet !== 'move-selection' && (
        <div className={`modal-backdrop ${sheet === 'toc' ? 'toc-drawer-backdrop' : 'sheet-backdrop'} ${sheet === 'settings' || sheet === 'toc' || sheet === 'fonts' ? 'reader-control-backdrop' : ''} ${sheet === 'progress' ? 'progress-jump-backdrop group-editor-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) { if (sheet === 'fonts') closeFontPicker(); else if (sheet === 'progress') closeProgressJump(); else if (sheet === 'settings' || sheet === 'toc') setSheet(null) } }}>
          <section
            className={`${sheet === 'toc' ? 'toc-drawer' : 'bottom-sheet'} ${sheet === 'fonts' ? 'font-sheet' : ''} ${sheet === 'progress' ? 'group-editor-dialog progress-jump-dialog' : ''}`}
            role="dialog"
            aria-modal="true"
            style={sheet === 'settings' || sheet === 'toc' || sheet === 'fonts' ? {
              '--reader-bg': settings.backgroundColor,
              '--reader-ink': settings.textColor,
              '--reader-muted': settings.theme === 'night' ? '#9da19d' : '#74746d',
            } as React.CSSProperties : undefined}
          >
            <div className="dialog-handle" />
            {sheet === 'settings' ? (
              <>
                <div className="sheet-title"><h2>阅读设置</h2></div>
                <div className="reader-settings-scroll" onTouchMove={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
                  <ReaderPreferences settings={settings} fontLabel={activeFontLabel} onUpdate={updateSettings} onTheme={applyReaderTheme} onOpenFonts={() => { setFontPickerReturnSheet('settings'); setSheet('fonts') }} />
                </div>
              </>
            ) : sheet === 'toc' ? (
              <>
                 <div className="sheet-title"><div><p className="eyebrow">本书导航</p><h2>目录 <small className="toc-chapter-count">共 {readerDocument.chapters.length} 章</small></h2></div><button className="toc-rescan-button" disabled={tocRecognizing || tocMutation !== null} onClick={() => void recognizeTableOfContents()}>{tocRecognizing ? '识别中…' : '重新识别'}</button></div>
                <div className="toc-list-wrap">
                  <div id="toc-list" className="toc-list" ref={tocListRef} onScroll={handleTocScroll} onWheel={(event) => event.stopPropagation()} onTouchMove={(event) => event.stopPropagation()}>
                    {readerDocument.chapters.length ? (
                      <div className="toc-virtual-space" style={{ height: `${tocTotalRows * TOC_ROW_HEIGHT}px` }}>
                      {Array.from({ length: Math.max(0, tocEndRow - tocStartRow) }, (_, virtualIndex) => {
                        const rowIndex = tocStartRow + virtualIndex
                        if (rowIndex === 0) {
                          return <div className="toc-virtual-row" style={{ top: 0 }} key="toc-start"><button className="toc-item toc-start" onClick={jumpToStart}><span>开头</span><small>返回正文起始处</small></button></div>
                        }
                        const chapter = readerDocument.chapters[rowIndex - 1]
                        if (!chapter) return null
                        return (
                          <div className="toc-virtual-row" style={{ top: `${rowIndex * TOC_ROW_HEIGHT}px` }} key={chapter.id}>
                            <div className="toc-item-row">
                              <button id={`toc-${chapter.id}`} title={chapter.title} className={`toc-item ${activeChapter?.id === chapter.id ? 'active' : ''}`} aria-current={activeChapter?.id === chapter.id ? 'location' : undefined} onPointerDown={(event) => startTocChapterLongPress(chapter, event)} onPointerUp={(event) => { const longPressed = tocLongPressed.current; cancelTocChapterLongPress(event); if (!longPressed) { setTocDeleteCandidate(null); jumpToChapter(chapter) } }} onPointerCancel={(event) => cancelTocChapterLongPress(event)} onContextMenu={(event) => event.preventDefault()}>{chapter.title}</button>
                              {tocDeleteCandidate?.id === chapter.id && <button className="toc-delete-button" aria-label={`删除目录章节 ${chapter.title}`} disabled={tocMutation === 'delete'} onClick={() => void removeChapterFromTableOfContents(chapter)}>{tocMutation === 'delete' ? '删除中' : '删除'}</button>}
                            </div>
                          </div>
                        )
                      })}
                      </div>
                    ) : <p className="toc-empty">未识别到章节标题，可以点击右上角重新识别。</p>}
                  </div>
                  {tocMaxScroll > 0 && (
                    <div className={`toc-scrollbar-track ${tocScrollbarVisible || tocScrollbarDragging ? 'visible' : ''}`} ref={tocScrollbarTrackRef}>
                      <div
                        className={`toc-scrollbar-thumb ${tocScrollbarDragging ? 'dragging' : ''}`}
                        role="scrollbar"
                        aria-label="快速滚动目录"
                        aria-controls="toc-list"
                        aria-orientation="vertical"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(tocMaxScroll)}
                        aria-valuenow={Math.round(Math.min(tocMaxScroll, tocScrollTop))}
                        tabIndex={0}
                        style={{ height: `${tocScrollbarThumbHeight}px`, transform: `translateY(${tocScrollbarThumbTop}px)` }}
                        onPointerDown={startTocScrollbarDrag}
                        onPointerMove={moveTocScrollbar}
                        onPointerUp={finishTocScrollbarDrag}
                        onPointerCancel={finishTocScrollbarDrag}
                        onKeyDown={handleTocScrollbarKey}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : sheet === 'progress' ? (
              <>
                <div className="sheet-title"><h2>跳转进度</h2></div>
                <form className="group-name-form progress-jump-form" onSubmit={(event) => { event.preventDefault(); jumpToProgress() }}>
                  <input ref={progressInputRef} autoFocus type="text" inputMode={settings.progressDisplay === 'percent' ? 'decimal' : 'numeric'} enterKeyHint="go" pattern={settings.progressDisplay === 'page' ? '[0-9]*' : '[0-9]*[.]?[0-9]*'} value={progressInput} onFocus={(event) => event.currentTarget.select()} onChange={(event) => updateProgressInput(event.target.value)} aria-label={settings.progressDisplay === 'percent' ? '跳转百分比' : '跳转页码'} placeholder={settings.progressDisplay === 'percent' ? '0 - 100' : `1 - ${readerPages}`} />
                  <button type="submit" className="editor-submit">跳转</button>
                </form>
              </>
            ) : sheet === 'fonts' ? (
              <>
                <div className="sheet-title"><h2>选择字体</h2></div>
                <button className="font-import-button" onClick={() => customFontInputRef.current?.click()}><Icon name="plus" size={18} /><span><strong>导入字体</strong><small>TTF、OTF、HWT</small></span></button>
                <div className="font-picker-list">
                  {FONT_OPTIONS.map(({ value, label }) => <button key={value} className={settings.fontFamily === value && !settings.followSystemFont ? 'active' : ''} onClick={() => void updateSettings({ fontFamily: value, followSystemFont: false })} style={{ fontFamily: readerFontCss(value, false) }}>{label}{settings.fontFamily === value && !settings.followSystemFont && <Icon name="check" size={17} />}</button>)}
                </div>
                {customFonts.length > 0 && (
                  <section className="custom-font-section">
                    <p>自定义字体</p>
                    <div className="custom-font-list">
                      {customFonts.map((font) => (
                        <div className="custom-font-row" key={font.id}>
                          <button className={`custom-font-select ${settings.fontFamily === customFontValue(font.id) && !settings.followSystemFont ? 'active' : ''}`} onClick={() => void updateSettings({ fontFamily: customFontValue(font.id), followSystemFont: false })} style={{ fontFamily: `"${customFontCssFamily(font.id)}", serif` }}>
                            <span><strong>{font.name}</strong><small>{formatSize(font.data.byteLength)}</small></span>
                            {settings.fontFamily === customFontValue(font.id) && !settings.followSystemFont && <Icon name="check" size={17} />}
                          </button>
                          <button className="custom-font-delete" aria-label={`删除字体 ${font.name}`} onClick={() => void removeCustomFont(font)}><Icon name="trash" size={17} /></button>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              <>
                <div className="sheet-title"><div><p className="eyebrow">本机数据</p><h2>备份与恢复</h2></div><button className="icon-button" onClick={() => setSheet(null)}><Icon name="close" /></button></div>
                <p className="sheet-description">将书籍、阅读进度、显示设置和自定义字体保存为一个文件，换手机时可以完整恢复。</p>
                <button className="action-card" onClick={() => void exportBackup()}>
                  <span className="action-icon"><Icon name="download" /></span>
                  <span><strong>导出完整备份</strong><small>包含 {books.length} 本书和 {customFonts.length} 个自定义字体</small></span>
                  <Icon name="back" size={18} />
                </button>
                <button className="action-card" onClick={() => backupInputRef.current?.click()}>
                  <span className="action-icon restore"><Icon name="upload" /></span>
                  <span><strong>从备份恢复</strong><small>选择 .reader-backup 文件</small></span>
                  <Icon name="back" size={18} />
                </button>
                <p className="backup-warning">备份文件未加密，其中包含原始 TXT 内容和自定义字体文件，请妥善保管。</p>
              </>
            )}
          </section>
        </div>
      )}

      {toast && <div className="toast" role="status"><Icon name="check" size={18} />{toast}</div>}
    </div>
  )
}
