import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type { Book, CustomFont, ReaderSettings } from './types'

const FORMAT_VERSION = 2

interface BackupManifest {
  app: 'one-page-reader'
  formatVersion: number
  appVersion: string
  createdAt: string
  bookCount: number
  fontCount?: number
}

interface BookMetadata extends Omit<Book, 'content'> {}
interface CustomFontMetadata extends Omit<CustomFont, 'data'> {}

export interface BackupPayload {
  manifest: BackupManifest
  settings: ReaderSettings
  books: Book[]
  customFonts: CustomFont[]
}

export function createBackup(books: Book[], settings: ReaderSettings, customFonts: CustomFont[] = []): Uint8Array {
  const manifest: BackupManifest = {
    app: 'one-page-reader',
    formatVersion: FORMAT_VERSION,
    appVersion: '0.1.0',
    createdAt: new Date().toISOString(),
    bookCount: books.length,
    fontCount: customFonts.length,
  }
  const files: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'settings.json': strToU8(JSON.stringify(settings, null, 2)),
  }
  for (const book of books) {
    const { content, ...metadata } = book
    files[`books/${book.id}.txt`] = strToU8(content)
    files[`metadata/${book.id}.json`] = strToU8(JSON.stringify(metadata, null, 2))
  }
  for (const font of customFonts) {
    const { data, ...metadata } = font
    files[`fonts/${font.id}.ttf`] = new Uint8Array(data)
    files[`font-metadata/${font.id}.json`] = strToU8(JSON.stringify(metadata, null, 2))
  }
  return zipSync(files, { level: 6 })
}

export function readBackup(buffer: ArrayBuffer): BackupPayload {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(new Uint8Array(buffer))
  } catch {
    throw new Error('无法解压备份文件，文件可能已经损坏。')
  }
  const manifestFile = files['manifest.json']
  const settingsFile = files['settings.json']
  if (!manifestFile || !settingsFile) throw new Error('备份文件缺少必要信息。')

  const manifest = JSON.parse(strFromU8(manifestFile)) as BackupManifest
  const settings = JSON.parse(strFromU8(settingsFile)) as ReaderSettings
  if (manifest.app !== 'one-page-reader') throw new Error('这不是“一页”阅读器的备份文件。')
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== FORMAT_VERSION) throw new Error('暂不支持这个版本的备份文件。')

  const metadataFiles = Object.keys(files).filter((path) => path.startsWith('metadata/') && path.endsWith('.json'))
  const books = metadataFiles.map((path) => {
    const metadata = JSON.parse(strFromU8(files[path])) as BookMetadata
    const contentFile = files[`books/${metadata.id}.txt`]
    if (!contentFile) throw new Error(`备份中的《${metadata.title}》缺少正文。`)
    // A content URI only belongs to the phone that created it.
    return { ...metadata, sourceUri: undefined, content: strFromU8(contentFile) }
  })
  if (books.length !== manifest.bookCount) throw new Error('备份中的书籍数量不一致。')
  const fontMetadataFiles = Object.keys(files).filter((path) => path.startsWith('font-metadata/') && path.endsWith('.json'))
  const customFonts = fontMetadataFiles.map((path) => {
    const metadata = JSON.parse(strFromU8(files[path])) as CustomFontMetadata
    const dataFile = files[`fonts/${metadata.id}.ttf`]
    if (!dataFile) throw new Error(`备份中的字体“${metadata.name}”缺少字体文件。`)
    return { ...metadata, data: Uint8Array.from(dataFile).buffer }
  })
  if (manifest.fontCount !== undefined && customFonts.length !== manifest.fontCount) throw new Error('备份中的字体数量不一致。')
  return { manifest, settings, books, customFonts }
}

export function backupFileName(): string {
  const date = new Date()
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `我的阅读器备份_${stamp}.reader-backup`
}

export function downloadBackup(data: Uint8Array): void {
  const bytes = Uint8Array.from(data)
  const blob = new Blob([bytes.buffer], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = backupFileName()
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
