import type { CachedChapterHeading, ChapterAddition, ChapterRecognition } from './types'

export const CHAPTER_RECOGNITION_VERSION = 2

export type ReaderBlockType = 'paragraph' | 'chapter' | 'chapter-subtitle'

export interface ReaderBlock {
  id: string
  type: ReaderBlockType
  text: string
  offset: number
  chapterOffset?: number
}

export interface Chapter {
  id: string
  title: string
  offset: number
  source: 'auto' | 'manual'
}

export interface ReaderDocument {
  blocks: ReaderBlock[]
  chapters: Chapter[]
}

export type DetectedChapter = CachedChapterHeading

type LineInfo = {
  index: number
  raw: string
  text: string
  offset: number
  indent: number
  beforeBlank: boolean
  afterBlank: boolean
}

type AnchorKind = 'explicit' | 'english' | 'named' | 'unitless'

type AnchorCandidate = {
  line: LineInfo
  kind: AnchorKind
  number: number | null
}

const CHINESE_NUMBER = '[一二三四五六七八九十百千万零〇两]+'
const CHAPTER_NUMBER = `(?:[0-9]{1,5}|${CHINESE_NUMBER}|[ivxlcdm]{1,8})`
const EXPLICIT_CHAPTER = new RegExp(`^(?:正文\\s*)?[【\\[（(《]?\\s*第\\s*(${CHAPTER_NUMBER})\\s*[章节卷回篇部集幕](?:\\s*[】\\]）)》])?(?:\\s+.*)?$`, 'i')
const EXPLICIT_VOLUME = new RegExp(`^(?:正文\\s*)?(?:[上下中]\\s*)?(?:卷|篇|部)\\s*(${CHAPTER_NUMBER})(?:\\s*[】\\]）)》])?(?:\\s+.*)?$`, 'i')
const ENGLISH_CHAPTER = new RegExp(`^(?:chapter|chap\\.?|volume|vol\\.?|part|book|no\\.?)\\s*(${CHAPTER_NUMBER})(?:\\s+.*)?$`, 'i')
const PREFIXED_UNITLESS = new RegExp(`^第\\s*(${CHAPTER_NUMBER})[ \\t\\u3000]{2,}\\S.*$`, 'i')
const NUMERIC_UNITLESS = new RegExp(`^[【\\[（(]?\\s*(${CHAPTER_NUMBER})(?:[】\\]）)》])?[ \\t\\u3000]{2,}\\S.*$`, 'i')
const NAMED_CHAPTER = /^(?:序章|序幕|楔子|引子|引言|序言|前言|尾声|终章|终篇|大结局|番外|后记|后序|上卷|中卷|下卷)(?:\s*\d{0,4}|\s*[一二三四五六七八九十百千万零〇两]{0,8})?(?:\s*(?:之|篇|章)?\s*.*)?$/
const ALLOWED_CLOSING_BRACKETS = new Set([...')]）]】}〕〉》'])

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function hasTerminalChapterPunctuation(value: string): boolean {
  const text = value.trim()
  const last = [...text].at(-1)
  if (!last || ALLOWED_CLOSING_BRACKETS.has(last)) return false
  return /[\p{P}\p{S}]/u.test(last)
}

function indentationWidth(raw: string): number {
  let width = 0
  for (const character of raw) {
    if (character === ' ') width += 1
    else if (character === '\t') width += 4
    else if (character === '\u3000') width += 2
    else if (/\s/u.test(character) && character !== '\r' && character !== '\n') width += 1
    else break
  }
  return width
}

function parseChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value)
  if (/^[ivxlcdm]+$/i.test(value)) return null
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (![...value].some((character) => '十百千万'.includes(character))) {
    const number = [...value].map((character) => digits[character]).join('')
    return number ? Number(number) : null
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let total = 0
  let current = 0
  for (const character of value) {
    if (character in digits) current = current * 10 + digits[character]
    else if (character in units) {
      total += (current || 1) * units[character]
      current = 0
    }
  }
  return total + current || null
}

function makeLines(text: string): LineInfo[] {
  const rawLines = text.split('\n')
  const lines: LineInfo[] = []
  let offset = 0
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    lines.push({
      index,
      raw,
      text: raw.trim(),
      offset,
      indent: indentationWidth(raw),
      beforeBlank: index === 0 || !rawLines[index - 1].trim(),
      afterBlank: index === rawLines.length - 1 || !rawLines[index + 1].trim(),
    })
    offset += raw.length + 1
  }
  return lines
}

function anchorCandidate(line: LineInfo): AnchorCandidate | null {
  const text = line.text
  if (!text || text.length > 100 || hasTerminalChapterPunctuation(text)) return null
  let match = text.match(EXPLICIT_CHAPTER)
  if (match) return { line, kind: 'explicit', number: parseChineseNumber(match[1]) }
  match = text.match(EXPLICIT_VOLUME)
  if (match) return { line, kind: 'explicit', number: parseChineseNumber(match[1]) }
  match = text.match(ENGLISH_CHAPTER)
  if (match) return { line, kind: 'english', number: parseChineseNumber(match[1]) }
  if (NAMED_CHAPTER.test(text)) return { line, kind: 'named', number: null }
  match = text.match(PREFIXED_UNITLESS) ?? text.match(NUMERIC_UNITLESS)
  if (match) return { line, kind: 'unitless', number: parseChineseNumber(match[1]) }
  return null
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))]
}

function supportedUnitlessOffsets(candidates: AnchorCandidate[]): Set<number> {
  const numeric = candidates.filter((candidate) => candidate.number !== null)
  const supported = new Set<number>()
  let chain: AnchorCandidate[] = []
  const flush = () => {
    if (chain.length >= 3) for (const candidate of chain) supported.add(candidate.line.offset)
    chain = []
  }
  for (const candidate of numeric) {
    const previous = chain.at(-1)
    if (!previous || candidate.number === (previous.number as number) + 1) chain.push(candidate)
    else {
      flush()
      chain.push(candidate)
    }
  }
  flush()
  return supported
}

function removeDenseFrontRuns(candidates: AnchorCandidate[], documentLength: number): AnchorCandidate[] {
  if (candidates.length < 8) return candidates
  const gaps = candidates.slice(1).map((candidate, index) => candidate.line.offset - candidates[index].line.offset)
  const typicalGap = percentile(gaps, 0.6)
  if (typicalGap <= 0) return candidates
  const denseLimit = Math.max(24, typicalGap * 0.16)
  const excluded = new Set<number>()
  let start = 0
  for (let index = 1; index <= candidates.length; index += 1) {
    const continues = index < candidates.length
      && candidates[index].line.offset - candidates[index - 1].line.offset <= denseLimit
      && candidates[index].line.index - candidates[index - 1].line.index <= 5
    if (continues) continue
    const run = candidates.slice(start, index)
    const nearFront = run[0].line.offset < documentLength * 0.18
    if (run.length >= 4 && nearFront) {
      const lastTitleOffsets = new Map<string, number>()
      for (const candidate of candidates) lastTitleOffsets.set(normalizeTitle(candidate.line.text), candidate.line.offset)
      const duplicated = run.filter((candidate) => (lastTitleOffsets.get(normalizeTitle(candidate.line.text)) ?? candidate.line.offset) > candidate.line.offset)
      if (duplicated.length >= 4) {
        for (const candidate of duplicated) excluded.add(candidate.line.offset)
      }
    }
    start = index
  }
  return candidates.filter((candidate) => !excluded.has(candidate.line.offset))
}

function dominantBodyIndent(lines: LineInfo[], anchors: Set<number>): number | null {
  const counts = new Map<number, number>()
  for (const line of lines) {
    if (!line.text || anchors.has(line.offset)) continue
    if (line.text.length < 20 && !hasTerminalChapterPunctuation(line.text)) continue
    counts.set(line.indent, (counts.get(line.indent) ?? 0) + 1)
  }
  let result: number | null = null
  let count = 0
  for (const [indent, occurrences] of counts) {
    if (occurrences > count) {
      result = indent
      count = occurrences
    }
  }
  return result
}

function nextNonEmptyLine(lines: LineInfo[], start: number): LineInfo | null {
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].text) return lines[index]
  }
  return null
}

function learnSubtitleOffsets(lines: LineInfo[], anchors: AnchorCandidate[]): Map<number, LineInfo> {
  const anchorOffsets = new Set(anchors.map((candidate) => candidate.line.offset))
  const bodyIndent = dominantBodyIndent(lines, anchorOffsets)
  const examples = new Map<number, LineInfo>()
  const signatures = new Map<number, number>()
  for (const anchor of anchors) {
    const subtitle = nextNonEmptyLine(lines, anchor.line.index + 1)
    if (!subtitle || subtitle.index - anchor.line.index > 2) continue
    if (subtitle.text.length > 60 || hasTerminalChapterPunctuation(subtitle.text) || anchorOffsets.has(subtitle.offset)) continue
    const following = nextNonEmptyLine(lines, subtitle.index + 1)
    const differsFromBody = bodyIndent === null || subtitle.indent !== bodyIndent
    const differsFromFollowing = Boolean(following && subtitle.indent !== following.indent)
    if (!subtitle.indent || (!differsFromBody && !differsFromFollowing)) continue
    examples.set(anchor.line.offset, subtitle)
    signatures.set(subtitle.indent, (signatures.get(subtitle.indent) ?? 0) + 1)
  }
  const learnedIndents = new Set([...signatures].filter(([, count]) => count >= 3).map(([indent]) => indent))
  return new Map([...examples].filter(([, subtitle]) => learnedIndents.has(subtitle.indent)))
}

function unpunctuatedRunLengths(lines: LineInfo[]): number[] {
  const lengths = new Array<number>(lines.length).fill(0)
  let start = 0
  while (start < lines.length) {
    if (!lines[start].text || hasTerminalChapterPunctuation(lines[start].text)) {
      start += 1
      continue
    }
    let end = start + 1
    while (end < lines.length && lines[end].text && !hasTerminalChapterPunctuation(lines[end].text)) end += 1
    const length = end - start
    for (let index = start; index < end; index += 1) lengths[index] = length
    start = end
  }
  return lengths
}

function repeatedUnnumberedHeadings(lines: LineInfo[], occupiedOffsets: Set<number>): LineInfo[] {
  const bodyIndent = dominantBodyIndent(lines, occupiedOffsets)
  const runLengths = unpunctuatedRunLengths(lines)
  const textOccurrences = new Map<string, number>()
  for (const line of lines) {
    if (line.text) textOccurrences.set(normalizeTitle(line.text), (textOccurrences.get(normalizeTitle(line.text)) ?? 0) + 1)
  }
  const groups = new Map<string, LineInfo[]>()
  for (const line of lines) {
    if (occupiedOffsets.has(line.offset) || !line.text || line.text.length > 40) continue
    if ((textOccurrences.get(normalizeTitle(line.text)) ?? 0) > 1) continue
    if (hasTerminalChapterPunctuation(line.text) || runLengths[line.index] > 2) continue
    if (!line.beforeBlank && !line.afterBlank) continue
    if (bodyIndent !== null && line.indent === bodyIndent) continue
    if (/^(?:https?:\/\/|www\.)/i.test(line.text)) continue
    const meaningful = [...line.text].filter((character) => /[\p{L}\p{N}]/u.test(character)).length
    if (meaningful < Math.max(1, line.text.length * 0.55)) continue
    const key = `${line.indent}:${line.beforeBlank ? 1 : 0}:${line.afterBlank ? 1 : 0}`
    const group = groups.get(key) ?? []
    group.push(line)
    groups.set(key, group)
  }

  const selected: LineInfo[] = []
  for (const group of groups.values()) {
    if (group.length < 4) continue
    const gaps = group.slice(1).map((line, index) => line.offset - group[index].offset)
    const typicalGap = percentile(gaps, 0.5)
    if (!typicalGap) continue
    for (let index = 0; index < group.length; index += 1) {
      const previousGap = index ? group[index].offset - group[index - 1].offset : Number.POSITIVE_INFINITY
      const nextGap = index + 1 < group.length ? group[index + 1].offset - group[index].offset : Number.POSITIVE_INFINITY
      if (Math.max(previousGap, nextGap) >= typicalGap * 0.2) selected.push(group[index])
    }
  }
  return selected
}

export function detectChapterHeadings(text: string, recognition: ChapterRecognition = 'auto'): DetectedChapter[] {
  if (recognition === 'off') return []
  const lines = makeLines(text)
  const allCandidates = lines.map(anchorCandidate).filter((candidate): candidate is AnchorCandidate => Boolean(candidate))
  const unitlessSupport = supportedUnitlessOffsets(allCandidates)
  let anchors = allCandidates.filter((candidate) => {
    if (recognition === 'strict') return candidate.kind === 'explicit' || candidate.kind === 'english'
    return candidate.kind !== 'unitless' || unitlessSupport.has(candidate.line.offset)
  })
  anchors = removeDenseFrontRuns(anchors, text.length)

  const occupiedOffsets = new Set(anchors.map((candidate) => candidate.line.offset))
  const subtitles = recognition === 'auto' ? learnSubtitleOffsets(lines, anchors) : new Map<number, LineInfo>()
  for (const subtitle of subtitles.values()) occupiedOffsets.add(subtitle.offset)

  if (recognition === 'auto') {
    const genericLines = repeatedUnnumberedHeadings(lines, occupiedOffsets)
    anchors.push(...genericLines.map((line) => ({ line, kind: 'named' as const, number: null })))
    anchors.sort((left, right) => left.line.offset - right.line.offset)
  }

  return anchors.map((anchor) => {
    const subtitle = subtitles.get(anchor.line.offset)
    return {
      offset: anchor.line.offset,
      title: subtitle ? `${normalizeTitle(anchor.line.text)} ${normalizeTitle(subtitle.text)}` : normalizeTitle(anchor.line.text),
      subtitleOffset: subtitle?.offset,
    }
  })
}

export function buildReaderBlocks(
  text: string,
  recognition: ChapterRecognition = 'auto',
  exclusions: number[] = [],
  additions: ChapterAddition[] = [],
  detectedHeadings?: DetectedChapter[],
): ReaderDocument {
  const excluded = new Set(exclusions)
  const detected = (detectedHeadings ?? detectChapterHeadings(text, recognition)).filter((chapter) => !excluded.has(chapter.offset))
  const detectedByOffset = new Map(detected.map((chapter) => [chapter.offset, chapter]))
  const subtitleOwners = new Map<number, number>()
  for (const chapter of detected) {
    if (chapter.subtitleOffset !== undefined) subtitleOwners.set(chapter.subtitleOffset, chapter.offset)
  }
  const manualTitlesByLine = new Map<number, ChapterAddition[]>()
  const manualSubtitlesByLine = new Map<number, Array<{ offset: number; endOffset: number; chapterOffset: number }>>()
  const manualTitleOffsets = new Set<number>()
  for (const addition of additions) {
    const title = normalizeTitle(addition.title)
    if (!title || !Number.isFinite(addition.offset) || addition.offset < 0 || addition.offset >= text.length) continue
    const lineStart = text.lastIndexOf('\n', Math.max(0, addition.offset - 1)) + 1
    const nextLineBreak = text.indexOf('\n', addition.offset)
    const lineEnd = nextLineBreak < 0 ? text.length : nextLineBreak
    const endOffset = Number.isFinite(addition.endOffset) && addition.endOffset! > addition.offset
      ? Math.min(lineEnd, addition.endOffset!)
      : lineEnd
    const subtitleOffset = Number.isFinite(addition.subtitleOffset) && addition.subtitleOffset! > addition.offset && addition.subtitleOffset! <= text.length
      ? addition.subtitleOffset
      : undefined
    const normalized: ChapterAddition = { offset: addition.offset, endOffset, title, subtitleOffset }
    const titleEvents = manualTitlesByLine.get(lineStart) ?? []
    titleEvents.push(normalized)
    manualTitlesByLine.set(lineStart, titleEvents)
    manualTitleOffsets.add(addition.offset)
    if (subtitleOffset !== undefined) {
      const subtitleLineStart = text.lastIndexOf('\n', Math.max(0, subtitleOffset - 1)) + 1
      const nextSubtitleLineBreak = text.indexOf('\n', subtitleOffset)
      const subtitleLineEnd = nextSubtitleLineBreak < 0 ? text.length : nextSubtitleLineBreak
      const subtitleEndOffset = Number.isFinite(addition.subtitleEndOffset) && addition.subtitleEndOffset! > subtitleOffset
        ? Math.min(subtitleLineEnd, addition.subtitleEndOffset!)
        : subtitleLineEnd
      normalized.subtitleEndOffset = subtitleEndOffset
      const subtitleEvents = manualSubtitlesByLine.get(subtitleLineStart) ?? []
      subtitleEvents.push({ offset: subtitleOffset, endOffset: subtitleEndOffset, chapterOffset: addition.offset })
      manualSubtitlesByLine.set(subtitleLineStart, subtitleEvents)
    }
  }

  const blocks: ReaderBlock[] = []
  const chapters: Chapter[] = []
  let offset = 0
  let blockIndex = 0
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim()) {
      const manualTitles = manualTitlesByLine.get(offset) ?? []
      const manualSubtitles = manualSubtitlesByLine.get(offset) ?? []
      const automatic = detectedByOffset.get(offset)
      const subtitleOwner = subtitleOwners.get(offset)
      if (manualTitles.length || manualSubtitles.length) {
        const events = [
          ...manualTitles.map((addition) => ({
            type: 'chapter' as const,
            offset: addition.offset,
            endOffset: addition.endOffset ?? offset + rawLine.length,
            chapterOffset: addition.offset,
            title: addition.title,
          })),
          ...manualSubtitles.map((subtitle) => ({ type: 'chapter-subtitle' as const, ...subtitle, title: '' })),
        ].sort((left, right) => left.offset - right.offset)
        let cursor = offset
        for (const event of events) {
          const start = Math.max(cursor, event.offset)
          const end = Math.min(offset + rawLine.length, event.endOffset)
          if (end <= start) continue
          if (start > cursor) {
            const paragraph = rawLine.slice(cursor - offset, start - offset)
            if (paragraph.trim()) blocks.push({ id: `paragraph-${blockIndex++}`, type: 'paragraph', text: paragraph, offset: cursor })
          }
          const headingText = rawLine.slice(start - offset, end - offset).trim()
          if (headingText) {
            const id = event.type === 'chapter' ? `manual-chapter-${event.chapterOffset}` : `manual-chapter-subtitle-${start}`
            blocks.push({ id, type: event.type, text: headingText, offset: start, chapterOffset: event.chapterOffset })
            if (event.type === 'chapter') chapters.push({ id, title: event.title, offset: event.chapterOffset, source: automatic && event.chapterOffset === offset ? 'auto' : 'manual' })
          }
          cursor = end
        }
        if (cursor < offset + rawLine.length) {
          const paragraph = rawLine.slice(cursor - offset)
          if (paragraph.trim()) blocks.push({ id: `paragraph-${blockIndex++}`, type: 'paragraph', text: paragraph, offset: cursor })
        }
      } else if (automatic) {
        const id = `chapter-${offset}`
        blocks.push({ id, type: 'chapter', text: rawLine.trim(), offset, chapterOffset: offset })
        chapters.push({ id, title: automatic.title, offset, source: 'auto' })
      } else if (subtitleOwner !== undefined && !manualTitleOffsets.has(subtitleOwner)) {
        blocks.push({ id: `chapter-subtitle-${offset}`, type: 'chapter-subtitle', text: rawLine.trim(), offset, chapterOffset: subtitleOwner })
      } else {
        blocks.push({ id: `paragraph-${blockIndex++}`, type: 'paragraph', text: rawLine, offset })
      }
    }
    offset += rawLine.length + 1
  }
  chapters.sort((left, right) => left.offset - right.offset)
  if (!blocks.length) blocks.push({ id: 'paragraph-0', type: 'paragraph', text: '（这是一个空文件）', offset: 0 })
  return { blocks, chapters }
}

export function readerDocumentWithoutChapter(document: ReaderDocument, chapter: Chapter): ReaderDocument {
  return {
    blocks: document.blocks.map((block) => block.chapterOffset === chapter.offset && block.type !== 'paragraph'
      ? { ...block, id: `paragraph-${block.offset}`, type: 'paragraph' as const, chapterOffset: undefined }
      : block),
    chapters: document.chapters.filter((item) => item.id !== chapter.id),
  }
}

export function readerDocumentWithManualChapter(document: ReaderDocument, addition: ChapterAddition): ReaderDocument {
  const existingChapter = document.chapters.find((item) => item.offset === addition.offset)
  const chapter: Chapter = {
    id: `manual-chapter-${addition.offset}`,
    title: addition.title,
    offset: addition.offset,
    source: existingChapter?.source ?? 'manual',
  }
  const replaceParagraphRange = (blocks: ReaderBlock[], start: number, end: number | undefined, type: 'chapter' | 'chapter-subtitle', chapterOffset: number): ReaderBlock[] => blocks.flatMap((block) => {
    const blockEnd = block.offset + block.text.length
    if (block.type !== 'paragraph' || start < block.offset || start >= blockEnd) return [block]
    const rangeEnd = end === undefined ? blockEnd : Math.min(blockEnd, Math.max(start, end))
    const before = block.text.slice(0, start - block.offset)
    const heading = block.text.slice(start - block.offset, rangeEnd - block.offset)
    const after = block.text.slice(rangeEnd - block.offset)
    const result: ReaderBlock[] = []
    if (before.trim()) result.push({ ...block, id: `paragraph-${block.offset}`, text: before })
    if (heading.trim()) result.push({ id: type === 'chapter' ? chapter.id : `manual-chapter-subtitle-${start}`, type, text: heading.trim(), offset: start, chapterOffset })
    if (after.trim()) result.push({ id: `paragraph-${rangeEnd}`, type: 'paragraph', text: after, offset: rangeEnd })
    return result
  })
  let blocks = replaceParagraphRange(document.blocks, addition.offset, addition.endOffset, 'chapter', addition.offset)
  blocks = blocks.map((block) => block.type === 'chapter-subtitle' && block.chapterOffset === addition.offset
    ? { ...block, id: `paragraph-${block.offset}`, type: 'paragraph' as const, chapterOffset: undefined }
    : block)
  if (addition.subtitleOffset !== undefined) blocks = replaceParagraphRange(blocks, addition.subtitleOffset, addition.subtitleEndOffset, 'chapter-subtitle', addition.offset)
  return {
    blocks,
    chapters: [...document.chapters.filter((item) => item.offset !== addition.offset), chapter].sort((left, right) => left.offset - right.offset),
  }
}
