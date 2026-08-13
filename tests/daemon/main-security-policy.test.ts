import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/shared/contracts'
import {
  LocalKnowledgePathAuthorizer,
  requiresLiveSendingApproval
} from '../../src/main/security-policy'
import { assertNativeApproval } from '../../src/daemon/index'
import {
  DAEMON_NATIVE_APPROVAL,
  DAEMON_NATIVE_APPROVAL_HEADER
} from '../../src/daemon/protocol'

describe('Electron Main security policy', () => {
  it('只允许新增由系统文件夹选择器授权的本地知识目录', () => {
    const authorizer = new LocalKnowledgePathAuthorizer()
    const current = structuredClone(DEFAULT_CONFIG)
    const proposed = structuredClone(current)
    proposed.knowledgeSources = [{
      id: 'local-1',
      type: 'local-directory',
      label: '本地知识',
      path: '/Users/test/Documents/Knowledge',
      enabled: true
    }]

    expect(() => authorizer.assertConfigTransition(current, proposed)).toThrow(
      '系统文件夹选择器授权'
    )
    authorizer.authorizeSelectedPath('/Users/test/Documents/Knowledge')
    expect(() => authorizer.assertConfigTransition(current, proposed)).not.toThrow()
    authorizer.commitConfig(proposed)
    expect(() => authorizer.assertConfigTransition(current, proposed)).toThrow()
  })

  it('既有本地知识目录可继续启停或改名', () => {
    const authorizer = new LocalKnowledgePathAuthorizer()
    const current = structuredClone(DEFAULT_CONFIG)
    current.knowledgeSources = [{
      id: 'local-1',
      type: 'local-directory',
      label: '旧名称',
      path: '/Users/test/Documents/Knowledge',
      enabled: true
    }]
    const proposed = structuredClone(current)
    proposed.knowledgeSources[0] = { ...proposed.knowledgeSources[0]!, label: '新名称', enabled: false }

    expect(() => authorizer.assertConfigTransition(current, proposed)).not.toThrow()
  })

  it('只有从预演切到真实发送时要求新的原生批准', () => {
    const current = structuredClone(DEFAULT_CONFIG)
    const live = structuredClone(current)
    live.replyPolicy.enabled = true
    live.replyPolicy.dryRun = false
    expect(requiresLiveSendingApproval(current, live)).toBe(true)
    expect(requiresLiveSendingApproval(live, live)).toBe(false)
    expect(requiresLiveSendingApproval(live, current)).toBe(false)

    const armedButDisabled = structuredClone(current)
    armedButDisabled.replyPolicy.dryRun = false
    const enabledLater = structuredClone(armedButDisabled)
    enabledLater.replyPolicy.enabled = true
    expect(requiresLiveSendingApproval(armedButDisabled, enabledLater)).toBe(true)
  })

  it('Daemon 对敏感操作强制校验精确的 Main 原生批准断言', () => {
    const approved = {
      headers: { [DAEMON_NATIVE_APPROVAL_HEADER]: DAEMON_NATIVE_APPROVAL.enableLiveSending }
    }
    expect(() => assertNativeApproval(
      approved,
      DAEMON_NATIVE_APPROVAL.enableLiveSending
    )).not.toThrow()
    expect(() => assertNativeApproval(
      { headers: {} },
      DAEMON_NATIVE_APPROVAL.enableLiveSending
    )).toThrow('原生确认')
    expect(() => assertNativeApproval(
      approved,
      DAEMON_NATIVE_APPROVAL.disconnectSampleAuth
    )).toThrow('原生确认')
  })
})
