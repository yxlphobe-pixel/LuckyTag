import type { ReplyStatus, RuntimeStatus } from '../../shared/contracts'
import type { CoreStateFile, PersistedReplyRecord } from './types'
import { isRecord } from './value-utils'

const REPLY_STATUSES = new Set<ReplyStatus>([
  'pending',
  'sending',
  'sent',
  'ignored',
  'needs_manual',
  'recalled',
  'dry_run',
  'failed'
])

export const createCoreState = (instanceId: string): CoreStateFile => ({
  version: 1,
  initializedGroups: [],
  replies: [],
  runtime: {
    running: false,
    processing: false,
    instanceId
  }
})

export const isCoreStateFile = (value: unknown): value is CoreStateFile =>
  isRecord(value) &&
  value.version === 1 &&
  Array.isArray(value.initializedGroups) &&
  value.initializedGroups.every((groupId) => typeof groupId === 'string') &&
  Array.isArray(value.replies) &&
  value.replies.every(isPersistedReplyRecord) &&
  isRuntimeStatus(value.runtime)

const isRuntimeStatus = (value: unknown): value is RuntimeStatus =>
  isRecord(value) &&
  typeof value.running === 'boolean' &&
  typeof value.processing === 'boolean' &&
  typeof value.instanceId === 'string' &&
  optionalString(value.lastRunAt) &&
  optionalString(value.nextRunAt) &&
  optionalString(value.lastError)

export const isPersistedReplyRecord = (value: unknown): value is PersistedReplyRecord =>
  isRecord(value) &&
  ['id', 'messageId', 'groupId', 'groupLabel', 'question', 'createdAt', 'updatedAt'].every(
    (key) => typeof value[key] === 'string'
  ) &&
  typeof value.status === 'string' &&
  REPLY_STATUSES.has(value.status as ReplyStatus) &&
  Array.isArray(value.evidence) &&
  value.evidence.every(
    (evidence) =>
      isRecord(evidence) &&
      typeof evidence.documentId === 'string' &&
      typeof evidence.title === 'string' &&
      typeof evidence.sourceLabel === 'string' &&
      typeof evidence.excerpt === 'string' &&
      typeof evidence.score === 'number'
  ) &&
  Number.isInteger(value.attemptCount) &&
  Number(value.attemptCount) >= 0 &&
  typeof value.idempotencyUuid === 'string' &&
  optionalString(value.senderLabel) &&
  optionalString(value.reply) &&
  optionalString(value.reason) &&
  optionalString(value.leaseExpiresAt) &&
  optionalString(value.platformTaskId) &&
  optionalString(value.senderId) &&
  optionalString(value.followUpClosedAt) &&
  optionalString(value.followUpCloseReason)

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
