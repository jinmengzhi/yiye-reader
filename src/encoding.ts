import type { ImportCandidate } from './types'

const SUPPORTED_ENCODINGS = ['utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'] as const
export type SupportedEncoding = (typeof SUPPORTED_ENCODINGS)[number]

function decode(buffer: ArrayBuffer, encoding: string, fatal = false): string {
  return new TextDecoder(encoding, { fatal }).decode(buffer)
}

function looksLikeUtf16(bytes: Uint8Array): SupportedEncoding | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  const sample = bytes.subarray(0, Math.min(bytes.length, 400))
  let evenZeros = 0
  let oddZeros = 0
  for (let i = 0; i < sample.length; i += 1) {
    if (sample[i] === 0) {
      if (i % 2 === 0) evenZeros += 1
      else oddZeros += 1
    }
  }
  if (oddZeros > sample.length * 0.2) return 'utf-16le'
  if (evenZeros > sample.length * 0.2) return 'utf-16be'
  return null
}

function detectEncoding(buffer: ArrayBuffer): { encoding: SupportedEncoding; confidence: 'high' | 'medium' } {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', confidence: 'high' }
  }
  const utf16 = looksLikeUtf16(bytes)
  if (utf16) return { encoding: utf16, confidence: 'high' }
  try {
    decode(buffer, 'utf-8', true)
    return { encoding: 'utf-8', confidence: 'high' }
  } catch {
    return { encoding: 'gb18030', confidence: 'medium' }
  }
}

export function decodeWithEncoding(buffer: ArrayBuffer, encoding: string): string {
  return decode(buffer, encoding).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

export async function fingerprint(buffer: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function prepareImport(file: File): Promise<ImportCandidate> {
  const buffer = await file.arrayBuffer()
  const detected = detectEncoding(buffer)
  return {
    file,
    buffer,
    encoding: detected.encoding,
    content: decodeWithEncoding(buffer, detected.encoding),
    confidence: detected.confidence,
    fingerprint: await fingerprint(buffer),
  }
}

export function changeCandidateEncoding(candidate: ImportCandidate, encoding: string): ImportCandidate {
  return {
    ...candidate,
    encoding,
    content: decodeWithEncoding(candidate.buffer, encoding),
  }
}

export const ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GBK / GB18030' },
  { value: 'big5', label: 'Big5' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
]
