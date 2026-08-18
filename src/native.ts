import { Capacitor, registerPlugin } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

interface SystemBarsControlPlugin {
  setHidden(options: { statusHidden: boolean; navigationHidden: boolean; night: boolean }): Promise<void>
}

const SystemBarsControl = registerPlugin<SystemBarsControlPlugin>('SystemBarsControl')

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

function toBase64(data: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < data.length; i += chunkSize) {
    binary += String.fromCharCode(...data.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

export async function shareNativeBackup(data: Uint8Array, fileName: string): Promise<void> {
  const result = await Filesystem.writeFile({
    path: fileName,
    data: toBase64(data),
    directory: Directory.Cache,
  })
  await Share.share({
    title: '保存“一页”阅读器备份',
    text: '完整备份包含书籍、阅读进度和阅读设置。',
    url: result.uri,
    dialogTitle: '保存或发送备份文件',
  })
}

interface ShareableTextFile {
  title: string
  content: string
}

function safeSharedFileName(title: string): string {
  const safeTitle = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 80)
  return `${safeTitle || '未命名书籍'}.txt`
}

export async function shareNativeTextFiles(books: ShareableTextFile[]): Promise<void> {
  const folder = `shared-books/${Date.now()}`
  const usedNames = new Set<string>()
  const uris: string[] = []

  for (const book of books) {
    const baseName = safeSharedFileName(book.title)
    const stem = baseName.slice(0, -4)
    let fileName = baseName
    let copyNumber = 2
    while (usedNames.has(fileName.toLocaleLowerCase())) {
      fileName = `${stem} (${copyNumber}).txt`
      copyNumber += 1
    }
    usedNames.add(fileName.toLocaleLowerCase())

    const result = await Filesystem.writeFile({
      path: `${folder}/${fileName}`,
      data: book.content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
      recursive: true,
    })
    uris.push(result.uri)
  }

  await Share.share({
    title: books.length === 1 ? books[0].title : `分享 ${books.length} 本书`,
    text: books.length === 1 ? '来自“一页”阅读器的 TXT 书籍。' : `来自“一页”阅读器的 ${books.length} 本 TXT 书籍。`,
    ...(uris.length === 1 ? { url: uris[0] } : { files: uris }),
    dialogTitle: books.length === 1 ? '分享书籍' : `分享 ${books.length} 本书`,
  })
}

export async function applyNativeStatusBar(night: boolean, statusHidden = false, navigationHidden = false): Promise<void> {
  if (!isNativeAndroid()) return
  // Keep all system-bar work in the native plugin. Capacitor's StatusBar
  // plugin also changes legacy window layout flags, which some Android skins
  // apply after the bars are hidden and can leave a black top inset behind.
  await SystemBarsControl.setHidden({ statusHidden, navigationHidden, night })
  if (navigationHidden) document.documentElement.style.setProperty('--system-bottom-inset', '0px')
  else document.documentElement.style.setProperty('--system-bottom-inset', 'max(20px, env(safe-area-inset-bottom, 0px))')
  if (statusHidden) {
    document.documentElement.style.setProperty('--status-content-inset', '0px')
    return
  }

  // This is intentionally independent of reported inset values: several
  // Android skins report zero while transient system bars are animating.
  document.documentElement.style.setProperty('--status-content-inset', 'max(24px, env(safe-area-inset-top, 0px))')
}
