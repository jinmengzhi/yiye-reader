import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '..')
const referenceDirectory = path.join(root, '参考文档')
const server = await createServer({ root, appType: 'custom', server: { middlewareMode: true } })

function referenceFile(fragment) {
  const name = fs.readdirSync(referenceDirectory).find((entry) => entry.includes(fragment))
  assert.ok(name, `缺少参考文档：${fragment}`)
  const content = fs.readFileSync(path.join(referenceDirectory, name))
  if (content[0] === 0xff && content[1] === 0xfe) return content.subarray(2).toString('utf16le')
  if (content[0] === 0xfe && content[1] === 0xff) {
    const swapped = Buffer.from(content.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return content.toString('utf8').replace(/^\uFEFF/, '')
}

function lineOffsets(text) {
  const result = []
  let offset = 0
  for (const raw of text.split('\n')) {
    result.push({ raw, text: raw.trim(), offset })
    offset += raw.length + 1
  }
  return result
}

try {
  const { buildReaderBlocks, detectChapterHeadings, hasTerminalChapterPunctuation, readerDocumentWithoutChapter, readerDocumentWithManualChapter } = await server.ssrLoadModule('/src/chapterRecognition.ts')

  const standard = [
    '第1章 初见',
    '正文第一段，没有空行也应识别。',
    '第19回 重逢',
    '正文第二段。',
    '第3节 转折',
    '正文第三段。',
    'Chapter 4 Finale',
    '正文第四段。',
  ].join('\n')
  assert.deepEqual(detectChapterHeadings(standard).map((chapter) => chapter.title), ['第1章 初见', '第19回 重逢', '第3节 转折', 'Chapter 4 Finale'])

  const unitless = [
    '1     启明制造厂',
    '　　正文。',
    '2     启明制造厂',
    '　　正文。',
    '第3     茶艺速成班',
    '　　正文。',
  ].join('\n')
  assert.deepEqual(detectChapterHeadings(unitless).map((chapter) => chapter.title), ['1 启明制造厂', '2 启明制造厂', '第3 茶艺速成班'])

  const composite = [1, 2, 3, 4].flatMap((number) => [
    `第${number}章 示例单元`,
    `　　 第${number}个副标题（上）`,
    '　　这是正文，正文使用另一种缩进。',
    '',
  ]).join('\n')
  const compositeChapters = detectChapterHeadings(composite)
  assert.equal(compositeChapters.length, 4)
  assert.ok(compositeChapters.every((chapter) => chapter.subtitleOffset !== undefined && chapter.title.includes('副标题')))
  const compositeDocument = buildReaderBlocks(composite)
  assert.equal(compositeDocument.blocks.filter((block) => block.type === 'chapter-subtitle').length, 4)

  for (const line of ['第1章：', '第2章…', '第3章——', '第4章=', '第5章-', '第6章“结束”']) {
    assert.equal(hasTerminalChapterPunctuation(line), true, `应排除标点结尾：${line}`)
  }
  assert.equal(hasTerminalChapterPunctuation('第7章 新生活（上）'), false)
  const punctuationSample = ['第1章：', '正文。', '第2章…', '正文。', '第3章——', '正文。', '第4章=', '正文。', '第5章-', '正文。', '第6章“结束”', '正文。', '第7章 新生活（上）', '正文。'].join('\n')
  assert.deepEqual(detectChapterHeadings(punctuationSample).map((chapter) => chapter.title), ['第7章 新生活（上）'])

  const denseToc = [
    '第1章 开始', '第2章 相遇', '第3章 转折', '第4章 结束', '',
    '第1章 开始', '这里是第一章较长的正文内容。'.repeat(20), '',
    '第2章 相遇', '这里是第二章较长的正文内容。'.repeat(20), '',
    '第3章 转折', '这里是第三章较长的正文内容。'.repeat(20), '',
    '第4章 结束', '这里是第四章较长的正文内容。'.repeat(20),
  ].join('\n')
  const denseLines = lineOffsets(denseToc)
  const denseDetected = new Set(detectChapterHeadings(denseToc).map((chapter) => chapter.offset))
  assert.ok(denseLines.slice(0, 4).every((line) => !denseDetected.has(line.offset)), '应剔除书首密集目录')
  assert.ok(denseLines.filter((line) => /^第\d章/.test(line.text)).slice(4).every((line) => denseDetected.has(line.offset)), '应保留正文中的章节')

  const threePlainLines = ['无编号标题一', '无编号标题二', '无编号标题三', '这是正文。'].join('\n')
  assert.equal(detectChapterHeadings(threePlainLines).length, 0, '连续三行无标点文本不能识别为标题')

  const manualSource = '普通正文第一行。\n普通正文第二行。'
  const secondOffset = manualSource.indexOf('普通正文第二行')
  const manualDocument = buildReaderBlocks(manualSource, 'auto', [], [{ offset: secondOffset, title: '手动章节' }])
  assert.equal(manualDocument.blocks.find((block) => block.offset === secondOffset)?.type, 'chapter')
  const removedManual = readerDocumentWithoutChapter(manualDocument, manualDocument.chapters[0])
  assert.equal(removedManual.blocks.find((block) => block.offset === secondOffset)?.type, 'paragraph')
  const addedAgain = readerDocumentWithManualChapter(removedManual, { offset: secondOffset, title: '手动章节' })
  assert.equal(addedAgain.blocks.find((block) => block.offset === secondOffset)?.type, 'chapter')

  const embeddedSource = '前方正文。嵌入标题后方正文。'
  const embeddedStart = embeddedSource.indexOf('嵌入标题')
  const embeddedEnd = embeddedStart + '嵌入标题'.length
  const embeddedDocument = buildReaderBlocks(embeddedSource, 'off', [], [{ offset: embeddedStart, endOffset: embeddedEnd, title: '嵌入标题' }])
  assert.deepEqual(embeddedDocument.blocks.map((block) => [block.type, block.text, block.offset]), [
    ['paragraph', '前方正文。', 0],
    ['chapter', '嵌入标题', embeddedStart],
    ['paragraph', '后方正文。', embeddedEnd],
  ], '嵌在正文中的手动标题只应转换选中范围')
  const embeddedAddedLater = readerDocumentWithManualChapter(buildReaderBlocks(embeddedSource, 'off'), { offset: embeddedStart, endOffset: embeddedEnd, title: '嵌入标题' })
  assert.deepEqual(embeddedAddedLater.blocks.map((block) => [block.type, block.text, block.offset]), embeddedDocument.blocks.map((block) => [block.type, block.text, block.offset]))
  const embeddedRemoved = buildReaderBlocks(embeddedSource, 'off', [], [])
  assert.deepEqual(embeddedRemoved.blocks.map((block) => [block.type, block.text, block.offset]), [
    ['paragraph', embeddedSource, 0],
  ], '删除嵌入标题后应恢复为原来的完整正文段落')

  const secondBook = referenceFile('哥你不许打我老公')
  const secondExpected = lineOffsets(secondBook).filter((line) => /^第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*章(?:\s|$)/.test(line.text))
  const secondDetected = new Set(detectChapterHeadings(secondBook).map((chapter) => chapter.offset))
  assert.equal(secondExpected.length, 116, '第二本参考文档的基准章节数发生变化')
  assert.ok(secondExpected.every((line) => secondDetected.has(line.offset)), `第二本漏识别 ${secondExpected.filter((line) => !secondDetected.has(line.offset)).length} 个标准章节`)

  const thirdBook = referenceFile('任务又失败了')
  const thirdLines = lineOffsets(thirdBook)
  const thirdChapters = detectChapterHeadings(thirdBook)
  const thirdAnchorShape = /^(?:(?:正文\s*)?[【\[（(《]?\s*第\s*(?:\d{1,5}|[一二三四五六七八九十百千万零〇两]+)\s*[章节卷回篇部集幕]|(?:chapter|chap\.?|volume|vol\.?|part|book|no\.?)\s*\w+|(?:序章|序幕|楔子|引子|引言|序言|前言|尾声|终章|终篇|大结局|番外|后记|后序|上卷|中卷|下卷)|第\s*(?:\d{1,5}|[一二三四五六七八九十百千万零〇两]+)\s{2,}|(?:\d{1,5}|[一二三四五六七八九十百千万零〇两]+)\s{2,})/i
  const thirdExpectedAnchors = thirdLines.filter((line) => thirdAnchorShape.test(line.text) && !hasTerminalChapterPunctuation(line.text))
  const thirdDetectedOffsets = new Set(thirdChapters.map((chapter) => chapter.offset))
  const thirdCompositeCount = thirdChapters.filter((chapter) => chapter.subtitleOffset !== undefined).length
  assert.equal(thirdExpectedAnchors.length, 322, '第三本参考文档的编号/特殊章节基准数发生变化')
  assert.ok(thirdExpectedAnchors.every((line) => thirdDetectedOffsets.has(line.offset)), `第三本漏识别 ${thirdExpectedAnchors.filter((line) => !thirdDetectedOffsets.has(line.offset)).length} 个编号/特殊章节`)
  assert.ok(thirdCompositeCount >= 200, `第三本两行标题覆盖不足：只识别 ${thirdCompositeCount} 个`)
  const requiredThirdTitles = ['第19章 启明制造厂', '第20章 启明制造厂', '第103     茶艺速成班', '第110  章   茶艺速成班', '番外7']
  for (const title of requiredThirdTitles) {
    const expected = thirdLines.find((line) => line.text === title)
    assert.ok(expected, `第三本缺少基准标题：${title}`)
    assert.ok(thirdChapters.some((chapter) => chapter.offset === expected.offset), `第三本漏识别：${title}`)
  }
  const firstComposite = thirdChapters.find((chapter) => chapter.title.startsWith('1 启明制造厂'))
  assert.ok(firstComposite?.title.includes('记大过（捉虫）'), '第三本两行标题未合并')
  if (process.env.CHAPTER_TEST_DIAGNOSTICS === '1') {
    const rawByOffset = new Map(thirdLines.map((line) => [line.offset, line.text]))
    console.log('第三本非编号目录：', thirdChapters.filter((chapter) => !thirdAnchorShape.test(rawByOffset.get(chapter.offset) ?? '')).map((chapter) => chapter.title))
  }

  const firstBook = referenceFile('有时河是桥')
  const firstLines = lineOffsets(firstBook)
  const firstChapters = detectChapterHeadings(firstBook)
  const firstTitles = firstChapters.map((chapter) => chapter.title)
  const firstDetectedOffsets = new Set(firstChapters.map((chapter) => chapter.offset))
  const firstExpectedAnchors = firstLines.filter((line) => /^第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节卷回篇部集幕](?:\s|$)/.test(line.text) && line.text.length <= 100 && !hasTerminalChapterPunctuation(line.text))
  assert.ok(firstExpectedAnchors.every((line) => firstDetectedOffsets.has(line.offset)), `第一本漏识别 ${firstExpectedAnchors.filter((line) => !firstDetectedOffsets.has(line.offset)).length} 个独立编号章节`)
  const frontMatterFalsePositives = firstTitles.filter((title) => /(?:QQ群|微信群|免责声明|互联网及出版图书|同好交流群)/.test(title))
  assert.deepEqual(frontMatterFalsePositives, [], `书首推广或免责声明被识别为目录：${frontMatterFalsePositives.join(' / ')}`)
  if (process.env.CHAPTER_TEST_DIAGNOSTICS === '1') console.log(`第一本目录（独立编号基准 ${firstExpectedAnchors.length}）：`, firstTitles)

  console.log(`章节识别测试通过：第二本 ${secondExpected.length} 个标准章节全部命中；第三本 ${thirdChapters.length} 个目录项，其中 ${thirdCompositeCount} 个两行标题。`)
} finally {
  await server.close()
}
