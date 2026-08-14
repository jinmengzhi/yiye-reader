import { registerPlugin } from '@capacitor/core'
import { Filesystem } from '@capacitor/filesystem'
import type { CommonFolder } from './types'

export interface FolderFile {
  name: string
  uri: string
  size: number
  modifiedAt?: number
  relativePath?: string
  webFile?: File
}

interface NativeFolderResult {
  name: string
  uri: string
  displayPath: string
}

interface NativeFilesResult {
  files: FolderFile[]
}

interface RenamedFileResult {
  uri: string
  name: string
}

interface FolderPickerPlugin {
  pickFiles(): Promise<NativeFilesResult>
  pickFolder(): Promise<NativeFolderResult>
  listFolder(options: { uri: string }): Promise<NativeFilesResult>
  getFileInfo(options: { uri: string }): Promise<FolderFile>
  deleteFile(options: { uri: string }): Promise<void>
  renameFile(options: { uri: string; name: string }): Promise<RenamedFileResult>
}

const FolderPicker = registerPlugin<FolderPickerPlugin>('FolderPicker')

export function isNativeFolderPickerAvailable(): boolean {
  return typeof FolderPicker.pickFolder === 'function'
}

export async function pickNativeFolder(): Promise<NativeFolderResult> {
  return FolderPicker.pickFolder()
}

export async function pickNativeFiles(): Promise<NativeFilesResult> {
  return FolderPicker.pickFiles()
}

export async function listNativeFolder(folder: CommonFolder): Promise<NativeFilesResult> {
  return FolderPicker.listFolder({ uri: folder.uri })
}

export async function getNativeFileInfo(uri: string): Promise<FolderFile> {
  return FolderPicker.getFileInfo({ uri })
}

export async function deleteNativeFile(uri: string): Promise<void> {
  await FolderPicker.deleteFile({ uri })
}

export async function renameNativeFile(uri: string, name: string): Promise<RenamedFileResult> {
  return FolderPicker.renameFile({ uri, name })
}

export async function readNativeFolderFile(file: FolderFile): Promise<File> {
  if (file.webFile) return file.webFile
  const result = await Filesystem.readFile({ path: file.uri })
  if (typeof result.data !== 'string') throw new Error('无法读取这个文件。')
  const binary = atob(result.data)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new File([bytes], file.name, { type: file.name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'text/plain' })
}
