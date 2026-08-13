import { describe, expect, it } from 'vitest'
import { composeKnowledgeReply, KnowledgeIndex, tokenize } from '../../src/main/core/retrieval'
import type { KnowledgeChunk } from '../../src/main/core/types'

const chunks: KnowledgeChunk[] = [
  {
    id: 'chunk-sampleMessaging',
    documentId: 'doc-sampleMessaging',
    sourceId: 'source-1',
    sourceLabel: '自动回复手册',
    title: '示例消息知识库自动回复配置',
    text: '启用示例消息自动回复前，必须先配置群白名单。默认使用 dry-run，只生成预览而不发送。',
    position: 0
  },
  {
    id: 'chunk-holiday',
    documentId: 'doc-holiday',
    sourceId: 'source-2',
    sourceLabel: '行政手册',
    title: 'Holiday policy',
    text: 'Employees can review the annual holiday policy in the HR portal.',
    position: 0
  }
]

describe('KnowledgeIndex', () => {
  it('tokenizes Chinese bigrams and English words', () => {
    expect(tokenize('示例消息自动回复 Knowledge Base')).toEqual(
      expect.arrayContaining(['示例', '消息', '自动', '回复', 'knowledge', 'base'])
    )
  })

  it('ranks the relevant evidence and produces a grounded excerpt', () => {
    const result = new KnowledgeIndex(chunks).search('示例消息自动回复要怎么配置？')

    expect(result[0]?.documentId).toBe('doc-sampleMessaging')
    expect(result[0]?.score).toBeGreaterThan(0.2)
    expect(result[0]?.excerpt).toContain('群白名单')
  })

  it('assembles only supplied evidence and obeys the maximum length', () => {
    const evidence = new KnowledgeIndex(chunks).search('示例消息自动回复配置')
    const reply = composeKnowledgeReply(evidence, 120)

    expect(reply).toContain('根据本地知识库')
    expect(reply.length).toBeLessThanOrEqual(120)
  })
})
