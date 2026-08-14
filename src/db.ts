import type { Book, ChapterRecognitionCacheRecord, CustomFont, ReaderSettings } from './types'
import { normalizeSettings } from './types'

const DB_NAME = 'one-page-reader'
const DB_VERSION = 4
const BOOKS = 'books'
const SETTINGS = 'settings'
const CUSTOM_FONTS = 'customFonts'
const BOOK_PROGRESS = 'bookProgress'
const CHAPTER_RECOGNITION_CACHE = 'chapterRecognitionCache'
const PROGRESS_CHECKPOINT_PREFIX = 'one-page-reader-progress:'

interface BookProgressRecord {
  id: string
  progress: number
  textOffset: number
  lastReadAt: number
}

function readProgressCheckpoint(id: string): BookProgressRecord | null {
  try {
    const value = localStorage.getItem(`${PROGRESS_CHECKPOINT_PREFIX}${id}`)
    if (!value) return null
    const record = JSON.parse(value) as Partial<BookProgressRecord>
    if (record.id !== id || !Number.isFinite(record.progress) || !Number.isFinite(record.textOffset) || !Number.isFinite(record.lastReadAt)) return null
    return record as BookProgressRecord
  } catch {
    return null
  }
}

export function checkpointBookProgress(book: Pick<Book, 'id' | 'progress' | 'textOffset' | 'lastReadAt'>): void {
  try {
    localStorage.setItem(`${PROGRESS_CHECKPOINT_PREFIX}${book.id}`, JSON.stringify({
      id: book.id,
      progress: book.progress,
      textOffset: book.textOffset,
      lastReadAt: book.lastReadAt,
    }))
  } catch {
    // IndexedDB remains the persistent fallback when localStorage is unavailable.
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(BOOKS)) {
        const store = db.createObjectStore(BOOKS, { keyPath: 'id' })
        store.createIndex('fingerprint', 'fingerprint', { unique: true })
        store.createIndex('lastReadAt', 'lastReadAt')
      }
      if (!db.objectStoreNames.contains(SETTINGS)) {
        db.createObjectStore(SETTINGS)
      }
      if (!db.objectStoreNames.contains(CUSTOM_FONTS)) {
        db.createObjectStore(CUSTOM_FONTS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(BOOK_PROGRESS)) {
        db.createObjectStore(BOOK_PROGRESS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(CHAPTER_RECOGNITION_CACHE)) {
        db.createObjectStore(CHAPTER_RECOGNITION_CACHE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function getBooks(): Promise<Book[]> {
  const db = await openDatabase()
  const transaction = db.transaction([BOOKS, BOOK_PROGRESS])
  const [books, progressRecords] = await Promise.all([
    requestResult(transaction.objectStore(BOOKS).getAll()),
    requestResult<BookProgressRecord[]>(transaction.objectStore(BOOK_PROGRESS).getAll()),
  ])
  db.close()
  const progressByBook = new Map(progressRecords.map((record) => [record.id, record]))
  return books
    .map((book) => {
      const storedRecord = progressByBook.get(book.id)
      const checkpoint = readProgressCheckpoint(book.id)
      const record = checkpoint && (!storedRecord || checkpoint.lastReadAt >= storedRecord.lastReadAt)
        ? checkpoint
        : storedRecord
      return record ? {
        ...book,
        progress: record.progress,
        textOffset: record.textOffset,
        lastReadAt: Math.max(book.lastReadAt, record.lastReadAt),
      } : book
    })
    .sort((a, b) => b.lastReadAt - a.lastReadAt)
}

export async function saveBook(book: Book): Promise<void> {
  const db = await openDatabase()
  await requestResult(db.transaction(BOOKS, 'readwrite').objectStore(BOOKS).put(book))
  db.close()
}

export async function saveBookProgress(book: Pick<Book, 'id' | 'progress' | 'textOffset' | 'lastReadAt'>): Promise<void> {
  const db = await openDatabase()
  const record: BookProgressRecord = {
    id: book.id,
    progress: book.progress,
    textOffset: book.textOffset,
    lastReadAt: book.lastReadAt,
  }
  await requestResult(db.transaction(BOOK_PROGRESS, 'readwrite').objectStore(BOOK_PROGRESS).put(record))
  db.close()
}

export async function getChapterRecognitionCaches(): Promise<ChapterRecognitionCacheRecord[]> {
  const db = await openDatabase()
  const records = await requestResult<ChapterRecognitionCacheRecord[]>(
    db.transaction(CHAPTER_RECOGNITION_CACHE).objectStore(CHAPTER_RECOGNITION_CACHE).getAll(),
  )
  db.close()
  return records
}

export async function saveChapterRecognitionCache(record: ChapterRecognitionCacheRecord): Promise<void> {
  const db = await openDatabase()
  await requestResult(db.transaction(CHAPTER_RECOGNITION_CACHE, 'readwrite').objectStore(CHAPTER_RECOGNITION_CACHE).put(record))
  db.close()
}

export async function deleteBook(id: string): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction([BOOKS, BOOK_PROGRESS, CHAPTER_RECOGNITION_CACHE], 'readwrite')
  transaction.objectStore(BOOKS).delete(id)
  transaction.objectStore(BOOK_PROGRESS).delete(id)
  transaction.objectStore(CHAPTER_RECOGNITION_CACHE).delete(id)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
  try { localStorage.removeItem(`${PROGRESS_CHECKPOINT_PREFIX}${id}`) } catch { /* no-op */ }
}

export async function findBookByFingerprint(fingerprint: string): Promise<Book | undefined> {
  const db = await openDatabase()
  const book = await requestResult(
    db.transaction(BOOKS).objectStore(BOOKS).index('fingerprint').get(fingerprint),
  )
  db.close()
  return book
}

export async function getSettings(): Promise<ReaderSettings> {
  const db = await openDatabase()
  const saved = await requestResult(
    db.transaction(SETTINGS).objectStore(SETTINGS).get('reader'),
  )
  db.close()
  return normalizeSettings(saved)
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  const db = await openDatabase()
  await requestResult(
    db.transaction(SETTINGS, 'readwrite').objectStore(SETTINGS).put(settings, 'reader'),
  )
  db.close()
}

export async function getCustomFonts(): Promise<CustomFont[]> {
  const db = await openDatabase()
  const fonts = await requestResult(db.transaction(CUSTOM_FONTS).objectStore(CUSTOM_FONTS).getAll())
  db.close()
  return fonts.sort((a, b) => a.importedAt - b.importedAt)
}

export async function saveCustomFont(font: CustomFont): Promise<void> {
  const db = await openDatabase()
  await requestResult(db.transaction(CUSTOM_FONTS, 'readwrite').objectStore(CUSTOM_FONTS).put(font))
  db.close()
}

export async function deleteCustomFont(id: string): Promise<void> {
  const db = await openDatabase()
  await requestResult(db.transaction(CUSTOM_FONTS, 'readwrite').objectStore(CUSTOM_FONTS).delete(id))
  db.close()
}

export async function replaceLibrary(books: Book[], settings: ReaderSettings, customFonts: CustomFont[] = []): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction([BOOKS, SETTINGS, CUSTOM_FONTS, BOOK_PROGRESS, CHAPTER_RECOGNITION_CACHE], 'readwrite')
  const bookStore = transaction.objectStore(BOOKS)
  bookStore.clear()
  for (const book of books) bookStore.put(book)
  transaction.objectStore(SETTINGS).put(settings, 'reader')
  const fontStore = transaction.objectStore(CUSTOM_FONTS)
  fontStore.clear()
  for (const font of customFonts) fontStore.put(font)
  const progressStore = transaction.objectStore(BOOK_PROGRESS)
  progressStore.clear()
  for (const book of books) {
    progressStore.put({ id: book.id, progress: book.progress, textOffset: book.textOffset, lastReadAt: book.lastReadAt })
  }
  transaction.objectStore(CHAPTER_RECOGNITION_CACHE).clear()
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  db.close()
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => Boolean(key?.startsWith(PROGRESS_CHECKPOINT_PREFIX)))
    for (const key of keys) localStorage.removeItem(key)
    for (const book of books) checkpointBookProgress(book)
  } catch { /* no-op */ }
}
