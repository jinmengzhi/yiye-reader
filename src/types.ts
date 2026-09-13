export type ReaderTheme = 'paper' | 'green' | 'night'
export type ReaderFont = 'serif' | 'heiti' | 'kaiti' | 'yuanti'
export type CustomFontFamily = `custom:${string}`
export type ProgressDisplay = 'percent' | 'page'
export type PageTurnMode = 'scroll' | 'horizontal'
export type ShelfColumns = 3 | 4 | 5
export type ShelfSort = 'recent' | 'imported' | 'title' | 'progress' | 'size'
export type ShelfFilter = 'all' | 'unread' | 'reading' | 'finished'
export type ChapterRecognition = 'auto' | 'strict' | 'off'

export interface CommonFolder {
  id: string
  name: string
  uri: string
  displayPath: string
}

export interface BookGroup {
  id: string
  name: string
  createdAt: number
}

export interface ChapterAddition {
  offset: number
  endOffset?: number
  title: string
  subtitleOffset?: number
  subtitleEndOffset?: number
}

export interface Bookmark {
  id: string
  offset: number
  label: string
  createdAt: number
}

export interface CachedChapterHeading {
  offset: number
  title: string
  subtitleOffset?: number
}

export interface ChapterRecognitionCacheRecord {
  id: string
  fingerprint: string
  contentLength: number
  recognition: ChapterRecognition
  version: number
  chapters: CachedChapterHeading[]
}

export interface Book {
  id: string
  title: string
  originalName: string
  /** Android content URI for deleting the original file when requested. */
  sourceUri?: string
  content: string
  encoding: string
  fingerprint: string
  size: number
  importedAt: number
  lastReadAt: number
  progress: number
  textOffset: number
  bookmarks?: Bookmark[]
  groupId?: string
  chapterRecognition?: ChapterRecognition
  chapterExclusions?: number[]
  chapterAdditions?: ChapterAddition[]
}

export interface CustomFont {
  id: string
  name: string
  fileName: string
  mimeType: string
  data: ArrayBuffer
  importedAt: number
}

export interface ReaderSettings {
  theme: ReaderTheme
  fontSize: number
  lineHeight: number
  paragraphSpacing: number
  paragraphIndent: number
  pageMargin: number
  backgroundColor: string
  textColor: string
  commonColors: string[]
  fontFamily: ReaderFont | CustomFontFamily
  followSystemFont: boolean
  progressDisplay: ProgressDisplay
  pageTurnMode: PageTurnMode
  shelfColumns: ShelfColumns
  shelfSort: ShelfSort
  shelfFilter: ShelfFilter
  lastBookId: string | null
  commonFolders: CommonFolder[]
  bookGroups: BookGroup[]
}

export interface ImportCandidate {
  file: File
  buffer: ArrayBuffer
  encoding: string
  content: string
  confidence: 'high' | 'medium'
  fingerprint: string
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'paper',
  fontSize: 14,
  lineHeight: 1.5,
  paragraphSpacing: 0.3,
  paragraphIndent: 0,
  pageMargin: 16,
  backgroundColor: '#f5f0e7',
  textColor: '#2e2b26',
  commonColors: [],
  fontFamily: 'serif',
  followSystemFont: false,
  progressDisplay: 'percent',
  pageTurnMode: 'scroll',
  shelfColumns: 3,
  shelfSort: 'recent',
  shelfFilter: 'all',
  lastBookId: null,
  commonFolders: [],
  bookGroups: [],
}

export function normalizeSettings(saved: Partial<ReaderSettings> & { commonFolderName?: string } | undefined): ReaderSettings {
  const legacyFolders = saved?.commonFolderName ? [{ id: saved.commonFolderName, name: saved.commonFolderName, uri: '', displayPath: saved.commonFolderName }] : []
  const rawFolders = Array.isArray(saved?.commonFolders) ? saved.commonFolders : legacyFolders
  const folders = rawFolders.map((folder) => typeof folder === 'string'
    ? { id: folder, name: folder, uri: '', displayPath: folder }
    : { id: folder.id || folder.name, name: folder.name, uri: folder.uri || '', displayPath: folder.displayPath || folder.name })
  const rawGroups = Array.isArray(saved?.bookGroups) ? saved.bookGroups : []
  const commonColors = Array.isArray(saved?.commonColors) ? saved.commonColors
    .filter((color): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    .map((color) => color.toLowerCase())
    .filter((color, index, all) => all.indexOf(color) === index)
    .slice(0, 12)
    : []
  const bookGroups = rawGroups
    .filter((group): group is BookGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string'))
    .map((group) => ({ id: group.id, name: group.name.trim(), createdAt: Number(group.createdAt) || 0 }))
    .filter((group, index, all) => group.name && all.findIndex((item) => item.id === group.id) === index)
  const savedFont = saved?.fontFamily as string | undefined
  const fontFamily = savedFont === 'sans'
    ? 'heiti'
    : savedFont?.startsWith('custom:')
      ? savedFont as CustomFontFamily
      : (['serif', 'heiti', 'kaiti', 'yuanti'] as const).includes(savedFont as ReaderFont)
        ? savedFont as ReaderFont
        : DEFAULT_SETTINGS.fontFamily
  return {
    ...DEFAULT_SETTINGS,
    ...(saved ?? {}),
    fontFamily,
    paragraphIndent: Number(saved?.paragraphIndent) > 0 ? 2 : 0,
    pageMargin: saved?.pageMargin === 16 || saved?.pageMargin === 36 ? saved.pageMargin : 24,
    pageTurnMode: saved?.pageTurnMode === 'horizontal' ? 'horizontal' : 'scroll',
    shelfColumns: saved?.shelfColumns === 4 || saved?.shelfColumns === 5 ? saved.shelfColumns : 3,
    shelfSort: (['recent', 'imported', 'title', 'progress', 'size'] as const).includes(saved?.shelfSort as ShelfSort) ? saved?.shelfSort as ShelfSort : DEFAULT_SETTINGS.shelfSort,
    shelfFilter: (['all', 'unread', 'reading', 'finished'] as const).includes(saved?.shelfFilter as ShelfFilter) ? saved?.shelfFilter as ShelfFilter : DEFAULT_SETTINGS.shelfFilter,
    commonColors,
    commonFolders: folders.filter((folder, index, all) => folder.name && all.findIndex((item) => item.id === folder.id) === index),
    bookGroups,
  }
}
