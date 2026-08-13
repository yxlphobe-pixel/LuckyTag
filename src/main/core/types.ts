import type { ReplyRecord, RuntimeStatus } from '../../shared/contracts'

export interface KnowledgeDocument {
  id: string
  sourceId: string
  sourceLabel: string
  title: string
  origin: string
  body: string
  hash: string
  updatedAt?: string
}

export interface KnowledgeChunk {
  id: string
  documentId: string
  sourceId: string
  sourceLabel: string
  title: string
  text: string
  position: number
}

export interface KnowledgeSnapshotFile {
  version: 1
  generatedAt?: string
  documents: KnowledgeDocument[]
  chunks: KnowledgeChunk[]
  sourceErrors: Array<{ sourceId: string; message: string }>
}

export interface PersistedReplyRecord extends ReplyRecord {
  attemptCount: number
  idempotencyUuid: string
  senderId?: string
  followUpClosedAt?: string
  followUpCloseReason?: string
}

export interface CoreStateFile {
  version: 1
  initializedGroups: string[]
  replies: PersistedReplyRecord[]
  runtime: RuntimeStatus
}

export interface DemoMessageMessage {
  id: string
  groupId: string
  text: string
  createdAt: string
  recalled: boolean
  isSelf: boolean
  senderId?: string
  senderLabel?: string
}

export interface DemoMessageMentionPage {
  messages: DemoMessageMessage[]
  hasMore: boolean
  nextCursor?: string
}

export interface DemoMessageSendResult {
  platformTaskId?: string
  messageId?: string
  deduplicated: boolean
}

export interface DemoMessageAuthStatus {
  authenticated: boolean
  detail: string
  version?: string
}

export interface SampleLibraryAuthStatus {
  authenticated: boolean
  detail: string
  version?: string
}

export interface SampleLibraryDocument {
  route: string
  title: string
  body: string
  updatedAt?: string
}

export interface DemoMessageClient {
  setAllowlistedGroups(groupIds: Iterable<string>): void
  listMentions(input: {
    groupId: string
    start: string
    end: string
    limit?: number
    cursor?: string
  }): Promise<DemoMessageMentionPage>
  listConversationMessages(input: {
    groupId: string
    time: string
    forward?: boolean
    limit?: number
  }): Promise<DemoMessageMessage[]>
  sendMessage(input: {
    groupId: string
    text: string
    uuid: string
  }): Promise<DemoMessageSendResult>
}

export interface SampleLibraryClient {
  probe(): Promise<SampleLibraryAuthStatus>
  authenticate(): Promise<SampleLibraryAuthStatus>
  resolve(input: string): Promise<string>
  listDocuments(namespace: string): Promise<Array<{ route: string; title?: string }>>
  showDocument(route: string): Promise<SampleLibraryDocument>
}

export const EMPTY_KNOWLEDGE_SNAPSHOT: KnowledgeSnapshotFile = {
  version: 1,
  documents: [],
  chunks: [],
  sourceErrors: []
}
