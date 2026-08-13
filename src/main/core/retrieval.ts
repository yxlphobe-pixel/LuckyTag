import type { ReplyEvidence } from '../../shared/contracts'
import type { KnowledgeChunk, KnowledgeSnapshotFile } from './types'

const ENGLISH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'this',
  'to',
  'what',
  'with'
])
const CHINESE_STOP_WORDS = new Set(['如何', '怎么', '什么', '是否', '可以', '一下', '请问'])

export const tokenize = (input: string): string[] => {
  const normalized = input.normalize('NFKC').toLocaleLowerCase('en-US')
  const segments = normalized.match(/\p{Script=Han}+|[\p{L}\p{N}]+/gu) ?? []
  const tokens: string[] = []
  for (const segment of segments) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment]
      if (characters.length === 1) tokens.push(characters[0] ?? '')
      for (let index = 0; index < characters.length - 1; index += 1) {
        const token = `${characters[index] ?? ''}${characters[index + 1] ?? ''}`
        if (token && !CHINESE_STOP_WORDS.has(token)) tokens.push(token)
      }
      if (characters.length >= 2 && characters.length <= 6 && !CHINESE_STOP_WORDS.has(segment)) {
        tokens.push(segment)
      }
      continue
    }
    if (segment.length > 1 && !ENGLISH_STOP_WORDS.has(segment)) tokens.push(segment)
  }
  return tokens.filter(Boolean)
}

interface IndexedChunk {
  chunk: KnowledgeChunk
  tokens: string[]
  frequencies: Map<string, number>
  titleTokens: Set<string>
}

export class KnowledgeIndex {
  private readonly indexed: IndexedChunk[]
  private readonly documentFrequency = new Map<string, number>()
  private readonly averageLength: number

  constructor(snapshot: Pick<KnowledgeSnapshotFile, 'chunks'> | readonly KnowledgeChunk[]) {
    const chunks: readonly KnowledgeChunk[] = Array.isArray(snapshot)
      ? (snapshot as readonly KnowledgeChunk[])
      : (snapshot as Pick<KnowledgeSnapshotFile, 'chunks'>).chunks
    this.indexed = chunks.map((chunk) => {
      const tokens = tokenize(chunk.text)
      const frequencies = new Map<string, number>()
      for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
      for (const token of frequencies.keys()) {
        this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
      }
      return { chunk, tokens, frequencies, titleTokens: new Set(tokenize(chunk.title)) }
    })
    this.averageLength =
      this.indexed.reduce((total, document) => total + document.tokens.length, 0) /
      Math.max(1, this.indexed.length)
  }

  search(query: string, limit = 5): ReplyEvidence[] {
    const queryTokens = [...new Set(tokenize(query))]
    if (queryTokens.length === 0 || this.indexed.length === 0) return []
    const totalDocuments = this.indexed.length
    const scored = this.indexed.flatMap(({ chunk, tokens, frequencies, titleTokens }) => {
      let rawScore = 0
      let matched = 0
      for (const token of queryTokens) {
        const frequency = frequencies.get(token) ?? 0
        const titleMatch = titleTokens.has(token)
        if (frequency === 0 && !titleMatch) continue
        matched += 1
        const documentFrequency = this.documentFrequency.get(token) ?? 0
        const inverseDocumentFrequency = Math.log(
          1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5)
        )
        const lengthNormalization = 1 - 0.75 + 0.75 * (tokens.length / Math.max(1, this.averageLength))
        const termScore =
          frequency > 0
            ? (inverseDocumentFrequency * frequency * (1.5 + 1)) /
              (frequency + 1.5 * lengthNormalization)
            : 0
        rawScore += termScore + (titleMatch ? inverseDocumentFrequency * 0.9 : 0)
      }
      if (matched === 0) return []
      const coverage = matched / queryTokens.length
      const saturation = 1 - Math.exp(-rawScore / Math.max(1.2, queryTokens.length * 0.45))
      const score = Math.min(1, saturation * (0.6 + coverage * 0.4))
      return [
        {
          evidence: {
            documentId: chunk.documentId,
            title: chunk.title,
            sourceLabel: chunk.sourceLabel,
            excerpt: selectExcerpt(chunk.text, queryTokens),
            score: Number(score.toFixed(4))
          },
          position: chunk.position
        }
      ]
    })

    scored.sort(
      (left, right) =>
        right.evidence.score - left.evidence.score ||
        left.evidence.documentId.localeCompare(right.evidence.documentId) ||
        left.position - right.position
    )
    return scored.slice(0, Math.max(1, Math.min(20, limit))).map((entry) => entry.evidence)
  }
}

export const composeKnowledgeReply = (
  evidence: readonly ReplyEvidence[],
  maxLength: number
): string => {
  const unique: ReplyEvidence[] = []
  const seen = new Set<string>()
  for (const item of evidence) {
    const key = `${item.documentId}\0${item.excerpt}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
    if (unique.length >= 3) break
  }
  if (unique.length === 0) return ''

  const lines = ['根据本地知识库，我找到这些直接相关的信息：', '']
  for (const [index, item] of unique.entries()) {
    lines.push(`${index + 1}. ${item.excerpt}`)
  }
  lines.push('', `参考：${[...new Set(unique.map((item) => item.title))].join('；')}`)
  const reply = lines.join('\n').trim()
  const safeLimit = Math.max(1, maxLength)
  if (reply.length <= safeLimit) return reply
  return `${reply.slice(0, Math.max(1, safeLimit - 1)).trimEnd()}…`
}

const selectExcerpt = (text: string, queryTokens: readonly string[]): string => {
  const normalized = text.replace(/\s+/gu, ' ').trim()
  const sentences = normalized.split(/(?<=[。！？.!?])\s*/u).filter(Boolean)
  const ranked = sentences
    .map((sentence, index) => {
      const terms = new Set(tokenize(sentence))
      const score = queryTokens.reduce((total, token) => total + (terms.has(token) ? 1 : 0), 0)
      return { sentence, index, score }
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .sort((left, right) => left.index - right.index)
  const excerpt = ranked.map((entry) => entry.sentence).join(' ') || normalized
  return excerpt.length <= 360 ? excerpt : `${excerpt.slice(0, 359).trimEnd()}…`
}
