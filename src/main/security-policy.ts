import { resolve } from 'node:path'
import type { AppConfig } from '../shared/contracts'

/** Main-process capability set for local folders explicitly chosen by the user. */
export class LocalKnowledgePathAuthorizer {
  private readonly selectedPaths = new Set<string>()

  authorizeSelectedPath(path: string): void {
    this.selectedPaths.add(canonicalPath(path))
  }

  assertConfigTransition(current: AppConfig, proposed: AppConfig): void {
    const existing = new Set(
      current.knowledgeSources
        .filter((source) => source.type === 'local-directory')
        .map((source) => canonicalPath(source.path))
    )
    for (const source of proposed.knowledgeSources) {
      if (source.type !== 'local-directory') continue
      const path = canonicalPath(source.path)
      if (existing.has(path) || this.selectedPaths.has(path)) continue
      throw Object.assign(
        new Error('本地知识目录必须通过系统文件夹选择器授权'),
        { code: 'LOCAL_KNOWLEDGE_PATH_NOT_AUTHORIZED' }
      )
    }
  }

  commitConfig(proposed: AppConfig): void {
    for (const source of proposed.knowledgeSources) {
      if (source.type === 'local-directory') {
        this.selectedPaths.delete(canonicalPath(source.path))
      }
    }
  }
}

export const requiresLiveSendingApproval = (
  current: AppConfig,
  proposed: AppConfig
): boolean => !isLiveSendingEnabled(current) && isLiveSendingEnabled(proposed)

export const isLiveSendingEnabled = (config: AppConfig): boolean =>
  config.replyPolicy.enabled && !config.replyPolicy.dryRun

const canonicalPath = (value: string): string => resolve(value)
