import { useCallback, useEffect, useState } from 'react'
import type {
  AgentConfigurationInput,
  AgentConfigurationTestResult,
  AgentRuntimeKind,
  AgentRuntimeStatus,
  AllowlistedGroup,
  AppConfig,
  ConnectionStatus,
  DashboardSnapshot,
  DemoWorkflowRequirementCreateInput,
  DemoWorkflowRequirementInput,
  DemoWorkflowRequirementPreview,
  DemoWorkflowRequirementResult,
  KnowledgeSource,
  ReplyPolicy
} from '@shared/contracts'
import { AuditTable } from './components/AuditTable'
import { ApplicationConfigurationPanel } from './components/ApplicationConfigurationPanel'
import { BrandLogo } from './components/BrandLogo'
import { ConnectionGrid } from './components/ConnectionGrid'
import { DemoWorkflowRequirementPanel } from './components/DemoWorkflowRequirementPanel'
import { GroupWhitelist } from './components/GroupWhitelist'
import { Icon } from './components/Icon'
import { KnowledgePanel, type RemoteSourceInput } from './components/KnowledgePanel'
import { MetricCard } from './components/MetricCard'
import { ReplyPolicyPanel } from './components/ReplyPolicyPanel'
import { Sidebar, type SectionId } from './components/Sidebar'
import { ToastRegion, type ToastMessage } from './components/ToastRegion'
import { WorkerControls } from './components/WorkerControls'
import { formatDateTime, formatRelativeTime } from './format'
import { addBusyAction, hasBusyAction, removeBusyAction, type BusyActionCounts } from '@shared/busy-actions'

const sectionMeta: Record<SectionId, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: '工作台', title: '总览', description: '你的本地分身，一眼掌握连接、知识与自动回复状态。' },
  knowledge: { eyebrow: 'Knowledge', title: '知识库', description: '管理 LuckyTag 可以引用的可信知识来源。' },
  reply: { eyebrow: 'Autopilot', title: '自动回复', description: '控制回复范围、运行方式与每一道安全边界。' },
  demoWorkflow: { eyebrow: 'Chat to Requirement', title: 'DemoWorkflow需求', description: '从指定示例消息群聊中提炼需求，确认后写入目标 DemoWorkflow 空间。' },
  'app-config': { eyebrow: 'Local Agent Runtime', title: '应用配置', description: '配置独立本机服务使用的 Agent Runtime 与模型提供方。' },
  settings: { eyebrow: 'System', title: '设置', description: '管理身份连接、本地数据与应用信息。' }
}

const createId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`

export function App(): React.JSX.Element {
  const [section, setSection] = useState<SectionId>('overview')
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyActions, setBusyActions] = useState<BusyActionCounts>({})
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [confirmLive, setConfirmLive] = useState(false)
  const [confirmSampleAuthDisconnect, setConfirmSampleAuthDisconnect] = useState(false)
  const [demoWorkflowPreview, setDemoWorkflowPreview] = useState<DemoWorkflowRequirementPreview | null>(null)
  const [demoWorkflowResult, setDemoWorkflowResult] = useState<DemoWorkflowRequirementResult | null>(null)
  const [agentTestResult, setAgentTestResult] = useState<AgentConfigurationTestResult | null>(null)
  const [agentTestError, setAgentTestError] = useState<string | null>(null)
  const [agentRuntimeStatuses, setAgentRuntimeStatuses] = useState<Partial<Record<AgentRuntimeKind, AgentRuntimeStatus>>>({})

  const dismissToast = useCallback((id: string): void => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const pushToast = useCallback((tone: ToastMessage['tone'], title: string, message?: string): void => {
    const toast: ToastMessage = { id: createId('toast'), tone, title, ...(message ? { message } : {}) }
    setToasts((current) => [...current.slice(-2), toast])
  }, [])

  const beginBusy = useCallback((action: string): void => {
    setBusyActions((current) => addBusyAction(current, action))
  }, [])

  const endBusy = useCallback((action: string): void => {
    setBusyActions((current) => removeBusyAction(current, action))
  }, [])

  const loadSnapshot = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    if (!window.luckyTag) {
      setLoadError('未检测到 LuckyTag 本地桥接，请从 Electron 桌面端启动应用。')
      setLoading(false)
      return
    }
    try {
      const result = await window.luckyTag.getSnapshot()
      if (result.ok) setSnapshot(result.data)
      else setLoadError(result.error.message)
    } catch (error) {
      setLoadError(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadSnapshot()
    if (!window.luckyTag) return undefined
    return window.luckyTag.onSnapshotUpdated((nextSnapshot) => setSnapshot(nextSnapshot))
  }, [loadSnapshot])

  useEffect(() => {
    const status = snapshot?.agentRuntime
    if (!status) return
    setAgentRuntimeStatuses((current) => ({ ...current, [status.runtime]: status }))
  }, [snapshot?.agentRuntime])

  useEffect(() => {
    if (!confirmLive && !confirmSampleAuthDisconnect) return undefined
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setConfirmLive(false)
      setConfirmSampleAuthDisconnect(false)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [confirmLive, confirmSampleAuthDisconnect])

  const saveConfig = useCallback(async (config: AppConfig, success?: string): Promise<void> => {
    beginBusy('save-config')
    try {
      const result = await window.luckyTag.saveConfig(config)
      if (result.ok) {
        setSnapshot(result.data)
        if (success) pushToast('success', success)
      } else {
        pushToast('error', '配置未保存', result.error.message)
      }
    } catch (error) {
      pushToast('error', '配置未保存', errorText(error))
    } finally {
      endBusy('save-config')
    }
  }, [beginBusy, endBusy, pushToast])

  const saveAgentConfiguration = useCallback(async (input: AgentConfigurationInput): Promise<void> => {
    beginBusy('save-agent-config')
    setAgentTestResult(null)
    setAgentTestError(null)
    try {
      const result = await window.luckyTag.saveAgentConfiguration(input)
      if (result.ok) {
        setSnapshot(result.data)
        const agent = result.data.config.agent
        pushToast(
          'success',
          '应用配置已安全保存',
          agent.mode === 'runtime-default'
            ? '将沿用 Runtime 的默认认证与模型配置'
            : agent.model.authentication === 'none'
              ? '本机无认证模型已更新，不会创建 Keychain 条目'
            : agent.model.apiKeyConfigured
              ? '自定义模型已更新，Key 保存在 macOS 钥匙串'
              : '自定义模型已更新，尚未配置 Key'
        )
      } else pushToast('error', '应用配置未保存', result.error.message)
    } catch (error) {
      pushToast('error', '应用配置未保存', errorText(error))
    } finally {
      endBusy('save-agent-config')
    }
  }, [beginBusy, endBusy, pushToast])

  const probeAgentRuntime = useCallback(async (runtime: AgentRuntimeKind): Promise<void> => {
    beginBusy('probe-agent-runtime')
    try {
      const result = await window.luckyTag.probeAgentRuntime(runtime)
      if (result.ok) {
        setAgentRuntimeStatuses((current) => ({ ...current, [result.data.runtime]: result.data }))
        setSnapshot((current) => current ? { ...current, agentRuntime: result.data } : current)
        pushToast(result.data.available ? 'success' : 'error', result.data.available ? 'Agent Runtime 已就绪' : 'Agent Runtime 不可用', result.data.version || result.data.detail)
      } else pushToast('error', 'Runtime 检测失败', result.error.message)
    } catch (error) {
      pushToast('error', 'Runtime 检测失败', errorText(error))
    } finally {
      endBusy('probe-agent-runtime')
    }
  }, [beginBusy, endBusy, pushToast])

  const testAgentConfiguration = useCallback(async (): Promise<void> => {
    beginBusy('test-agent-config')
    setAgentTestResult(null)
    setAgentTestError(null)
    try {
      const result = await window.luckyTag.testAgentConfiguration()
      if (result.ok) {
        setAgentTestResult(result.data)
        pushToast('success', '模型配置测试通过', `${result.data.detail} · ${result.data.durationMs} ms`)
      } else {
        setAgentTestError(result.error.message)
        pushToast('error', '模型配置测试失败', result.error.message)
      }
    } catch (error) {
      const message = errorText(error)
      setAgentTestError(message)
      pushToast('error', '模型配置测试失败', message)
    } finally {
      endBusy('test-agent-config')
    }
  }, [beginBusy, endBusy, pushToast])

  const changePolicy = (patch: Partial<ReplyPolicy>): void => {
    if (!snapshot) return
    if (patch.dryRun === false) {
      setConfirmLive(true)
      return
    }
    void saveConfig({ ...snapshot.config, replyPolicy: { ...snapshot.config.replyPolicy, ...patch } })
  }

  const confirmLiveSending = (): void => {
    if (!snapshot) return
    setConfirmLive(false)
    void saveConfig(
      { ...snapshot.config, replyPolicy: { ...snapshot.config.replyPolicy, dryRun: false } },
      '已开启真实发送'
    )
  }

  const chooseLocalFolder = async (): Promise<void> => {
    if (!snapshot) return
    beginBusy('choose-folder')
    try {
      const result = await window.luckyTag.chooseLocalFolder()
      if (!result.ok) {
        pushToast('error', '无法选择文件夹', result.error.message)
        return
      }
      if (!result.data) return
      const path = result.data
      if (snapshot.config.knowledgeSources.some((source) => source.type === 'local-directory' && source.path === path)) {
        pushToast('info', '这个文件夹已经添加过了')
        return
      }
      const label = path.split('/').filter(Boolean).at(-1) || '本地资料'
      const source: KnowledgeSource = { id: createId('local'), type: 'local-directory', label, path, enabled: true }
      await saveConfig({ ...snapshot.config, knowledgeSources: [...snapshot.config.knowledgeSources, source] }, '已添加本地知识源')
    } catch (error) {
      pushToast('error', '无法选择文件夹', errorText(error))
    } finally {
      endBusy('choose-folder')
    }
  }

  const addRemoteSource = (input: RemoteSourceInput): void => {
    if (!snapshot) return
    const source: KnowledgeSource = input.type === 'sampleLibrary-doc'
      ? { id: createId('sampleLibrary-doc'), type: input.type, label: input.label, routeOrUrl: input.routeOrUrl, enabled: true }
      : { id: createId('sampleLibrary-book'), type: input.type, label: input.label, namespace: input.namespace, enabled: true }
    void saveConfig({ ...snapshot.config, knowledgeSources: [...snapshot.config.knowledgeSources, source] }, '已添加示例知识库知识源')
  }

  const toggleSource = (sourceId: string, enabled: boolean): void => {
    if (!snapshot) return
    const sources = snapshot.config.knowledgeSources.map((source) => source.id === sourceId ? { ...source, enabled } : source)
    void saveConfig({ ...snapshot.config, knowledgeSources: sources })
  }

  const removeSource = (sourceId: string): void => {
    if (!snapshot) return
    const sources = snapshot.config.knowledgeSources.filter((source) => source.id !== sourceId)
    void saveConfig({ ...snapshot.config, knowledgeSources: sources }, '知识源已移除')
  }

  const addGroup = (group: Omit<AllowlistedGroup, 'enabled'>): void => {
    if (!snapshot) return
    if (snapshot.config.groups.some((item) => item.id === group.id)) {
      pushToast('info', '这个群聊已经在白名单中')
      return
    }
    void saveConfig({ ...snapshot.config, groups: [...snapshot.config.groups, { ...group, enabled: true }] }, '群聊已加入白名单')
  }

  const toggleGroup = (groupId: string, enabled: boolean): void => {
    if (!snapshot) return
    const groups = snapshot.config.groups.map((group) => group.id === groupId ? { ...group, enabled } : group)
    void saveConfig({ ...snapshot.config, groups })
  }

  const removeGroup = (groupId: string): void => {
    if (!snapshot) return
    void saveConfig({ ...snapshot.config, groups: snapshot.config.groups.filter((group) => group.id !== groupId) }, '群聊已移出白名单')
  }

  const probeConnections = async (): Promise<void> => {
    if (!snapshot) return
    beginBusy('probe')
    try {
      const result = await window.luckyTag.probeConnections()
      if (result.ok) {
        setSnapshot((current) => current ? { ...current, connections: result.data } : current)
        const available = result.data.filter((connection) => connection.kind !== 'sample-device')
        const connected = available.filter((connection) => connection.state === 'connected').length
        pushToast('success', '连接检测完成', `${connected} / ${available.length} 项可用；示例设备 为后续能力`)
      } else pushToast('error', '连接检测失败', result.error.message)
    } catch (error) {
      pushToast('error', '连接检测失败', errorText(error))
    } finally {
      endBusy('probe')
    }
  }

  const authenticate = async (kind: 'sampleMessaging' | 'sampleLibrary' | 'sampleauth'): Promise<void> => {
    const action = `auth-${kind}`
    beginBusy(action)
    if (kind === 'sampleLibrary') {
      pushToast(
        'info',
        '正在连接示例知识库',
        'LuckyTag 会优先复用现有会话；如浏览器打开，请完成授权后返回'
      )
    } else if (kind === 'sampleauth') {
      pushToast('info', '正在打开 SampleAuth 登录页', '请在浏览器中完成统一身份登录，LuckyTag 会等待登录结果')
    }
    try {
      const result = await window.luckyTag.authenticate(kind)
      if (result.ok) {
        setSnapshot((current) => current ? { ...current, connections: upsertConnection(current.connections, result.data) } : current)
        pushToast(result.data.state === 'connected' ? 'success' : 'info', result.data.label, result.data.detail)
      } else pushToast('error', '连接失败', result.error.message)
    } catch (error) {
      pushToast('error', '连接失败', errorText(error))
    } finally {
      endBusy(action)
    }
  }

  const disconnectSampleAuth = async (): Promise<void> => {
    setConfirmSampleAuthDisconnect(false)
    beginBusy('disconnect-sampleauth')
    try {
      const result = await window.luckyTag.disconnectSampleAuth()
      if (result.ok) {
        setSnapshot(result.data)
        pushToast('success', 'SampleAuth 身份已断开', '本机 SampleAuth 会话已安全退出')
      } else pushToast('error', '无法断开 SampleAuth 身份', result.error.message)
    } catch (error) {
      pushToast('error', '无法断开 SampleAuth 身份', errorText(error))
    } finally {
      endBusy('disconnect-sampleauth')
    }
  }

  const syncKnowledge = async (): Promise<void> => {
    beginBusy('sync')
    try {
      const result = await window.luckyTag.syncKnowledge()
      if (result.ok) {
        const errorCount = result.data.sourceErrors.length
        pushToast(
          errorCount > 0 ? 'error' : 'success',
          errorCount > 0 ? '知识库部分来源同步失败' : '知识库同步完成',
          `${result.data.documentCount} 篇文档 · ${result.data.chunkCount} 个片段${errorCount > 0 ? ` · ${errorCount} 个来源失败` : ''}`
        )
        const latest = await window.luckyTag.getSnapshot()
        if (latest.ok) setSnapshot(latest.data)
      } else pushToast('error', '知识库同步失败', result.error.message)
    } catch (error) {
      pushToast('error', '知识库同步失败', errorText(error))
    } finally {
      endBusy('sync')
    }
  }

  const setWorkerState = async (command: 'start' | 'stop'): Promise<void> => {
    const action = `worker-${command}`
    beginBusy(action)
    try {
      const result = command === 'start' ? await window.luckyTag.startWorker() : await window.luckyTag.stopWorker()
      if (result.ok) {
        setSnapshot((current) => current ? { ...current, runtime: result.data } : current)
        pushToast('success', command === 'start' ? '自动回复服务已启动' : '自动回复服务已停止')
      } else pushToast('error', command === 'start' ? '无法启动服务' : '无法停止服务', result.error.message)
    } catch (error) {
      pushToast('error', command === 'start' ? '无法启动服务' : '无法停止服务', errorText(error))
    } finally {
      endBusy(action)
    }
  }

  const runOnce = async (): Promise<void> => {
    beginBusy('run-once')
    try {
      const result = await window.luckyTag.runOnce()
      if (result.ok) {
        const summary = result.data
        pushToast(
          summary.failed > 0 ? 'error' : 'success',
          summary.failed > 0 ? '本轮处理完成，但存在异常' : '本轮处理完成',
          `发现 ${summary.discovered} 条 · 发送 ${summary.sent} 条 · 预演 ${summary.previews} 条 · 异常 ${summary.failed} 条${summary.note ? `；${summary.note}` : ''}`
        )
        const latest = await window.luckyTag.getSnapshot()
        if (latest.ok) setSnapshot(latest.data)
      } else pushToast('error', '运行失败', result.error.message)
    } catch (error) {
      pushToast('error', '运行失败', errorText(error))
    } finally {
      endBusy('run-once')
    }
  }

  const revealRuntimeFolder = async (): Promise<void> => {
    beginBusy('reveal')
    try {
      const result = await window.luckyTag.revealRuntimeFolder()
      if (!result.ok) pushToast('error', '无法打开数据目录', result.error.message)
    } catch (error) {
      pushToast('error', '无法打开数据目录', errorText(error))
    } finally {
      endBusy('reveal')
    }
  }

  const previewDemoWorkflowRequirement = async (input: DemoWorkflowRequirementInput): Promise<void> => {
    beginBusy('demoWorkflow-preview')
    setDemoWorkflowPreview(null)
    setDemoWorkflowResult(null)
    try {
      const result = await window.luckyTag.previewDemoWorkflowRequirement(input)
      if (result.ok) {
        setDemoWorkflowPreview(result.data)
        pushToast('success', '需求草稿已生成', `读取 ${result.data.messageCount} 条群消息，请检查后确认创建`)
      } else {
        pushToast('error', '无法生成 DemoWorkflow 需求草稿', result.error.message)
      }
    } catch (error) {
      pushToast('error', '无法生成 DemoWorkflow 需求草稿', errorText(error))
    } finally {
      endBusy('demoWorkflow-preview')
    }
  }

  const createDemoWorkflowRequirement = async (input: DemoWorkflowRequirementCreateInput): Promise<void> => {
    beginBusy('demoWorkflow-create')
    try {
      const result = await window.luckyTag.createDemoWorkflowRequirement(input)
      if (result.ok) {
        setDemoWorkflowResult(result.data)
        pushToast('success', 'DemoWorkflow 需求创建成功', result.data.url)
      } else {
        pushToast('error', 'DemoWorkflow 需求未创建', result.error.message)
      }
    } catch (error) {
      pushToast('error', 'DemoWorkflow 需求未创建', errorText(error))
    } finally {
      endBusy('demoWorkflow-create')
    }
  }

  const openDemoWorkflowRequirement = async (url: string): Promise<void> => {
    try {
      const result = await window.luckyTag.openDemoWorkflowRequirement(url)
      if (!result.ok) pushToast('error', '无法打开 DemoWorkflow 需求', result.error.message)
    } catch (error) {
      pushToast('error', '无法打开 DemoWorkflow 需求', errorText(error))
    }
  }

  if (loading) return <LoadingScreen />
  if (loadError || !snapshot) return <ErrorScreen message={loadError || '无法读取应用状态'} onRetry={() => void loadSnapshot()} />

  const meta = sectionMeta[section]
  const isBusy = (action: string): boolean => hasBusyAction(busyActions, action)
  const connectionBusy = isBusy('probe') || Object.keys(busyActions).some((action) => action.startsWith('auth-')) || isBusy('disconnect-sampleauth')
  const workerBusy = isBusy('worker-start') || isBusy('worker-stop') || isBusy('run-once') || isBusy('save-config')
  const knowledgeBusy = isBusy('choose-folder') || isBusy('sync') || isBusy('save-config')
  const demoWorkflowBusyAction = isBusy('demoWorkflow-preview') ? 'demoWorkflow-preview' : isBusy('demoWorkflow-create') ? 'demoWorkflow-create' : null
  const enabledGroups = snapshot.config.groups.filter((group) => group.enabled).length
  const connectableConnections = snapshot.connections.filter((connection) => connection.kind !== 'sample-device')
  const connectedCount = connectableConnections.filter((connection) => connection.state === 'connected').length

  return (
    <div className="app-shell">
      <Sidebar active={section} onNavigate={setSection} workerRunning={snapshot.runtime.running} />
      <main className="main-content">
        <header className="topbar">
          <div><span className="page-eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
          {section === 'demoWorkflow' ? (
            <div className="mode-indicator preview"><Icon name="shield" size={15} />确认后创建</div>
          ) : section === 'app-config' ? (
            <div className={`mode-indicator ${snapshot.daemon?.connected ? 'preview' : 'live'}`}><Icon name="terminal" size={15} />{snapshot.daemon?.connected ? '本机 Daemon 已连接' : 'Daemon 未连接'}</div>
          ) : (
            <div className={`mode-indicator ${snapshot.config.replyPolicy.dryRun ? 'preview' : 'live'}`}>
              <Icon name={snapshot.config.replyPolicy.dryRun ? 'shield' : 'send'} size={15} />
              {snapshot.config.replyPolicy.dryRun ? '预演模式' : '真实发送'}
            </div>
          )}
        </header>
        <div className="page-content">
          {section === 'overview' && (
            <div className="content-stack">
              <section className="panel security-note" role="alert"><Icon name="shield" size={20} /><div><strong>Protected public build</strong><p>For security reasons, related integration code has been hidden. If you are interested in the project architecture, contact the author at <a href="mailto:yxlphobe@gmail.com">yxlphobe@gmail.com</a>.</p></div></section>
              <section className="welcome-strip">
                <div><span className="welcome-spark"><Icon name="sparkle" size={18} /></span><div><h2>{getGreeting()}，Lucky</h2><p>{getOverviewSummary(snapshot)}</p></div></div>
                <span className={`system-state${snapshot.runtime.running ? ' active' : ''}`}><span />{snapshot.runtime.running ? '分身在线' : '待机中'}</span>
              </section>
              <section className="metric-grid" aria-label="运行概览">
                <MetricCard icon="database" label="知识文档" value={snapshot.knowledge.documentCount.toLocaleString('zh-CN')} detail={`${snapshot.knowledge.chunkCount.toLocaleString('zh-CN')} 个片段`} tone="violet" />
                <MetricCard icon="users" label="已授权群聊" value={String(enabledGroups)} detail={`共配置 ${snapshot.config.groups.length} 个`} tone="blue" />
                <MetricCard icon="shield" label="可用连接" value={`${connectedCount} / ${connectableConnections.length}`} detail={connectedCount === connectableConnections.length ? '一期连接全部就绪' : '仍有连接待配置；SampleDevice 为后续能力'} tone="green" />
                <MetricCard icon="clock" label="最近运行" value={formatRelativeTime(snapshot.runtime.lastRunAt)} detail={snapshot.runtime.lastRunAt ? formatDateTime(snapshot.runtime.lastRunAt) : '尚未执行'} tone="amber" />
              </section>
              <ConnectionGrid busy={connectionBusy} connections={snapshot.connections} onAuthenticate={(kind) => void authenticate(kind)} onDisconnectSampleAuth={() => setConfirmSampleAuthDisconnect(true)} onProbe={() => void probeConnections()} />
              <WorkerControls busy={workerBusy} onRunOnce={() => void runOnce()} onSetEnabled={(enabled) => changePolicy({ enabled })} onStart={() => void setWorkerState('start')} onStop={() => void setWorkerState('stop')} policy={snapshot.config.replyPolicy} runtime={snapshot.runtime} />
              <AuditTable limit={5} onViewAll={() => setSection('reply')} records={snapshot.recentReplies} />
            </div>
          )}

          {section === 'knowledge' && (
            <KnowledgePanel busy={knowledgeBusy} onAddRemote={addRemoteSource} onChooseLocal={() => void chooseLocalFolder()} onRemove={removeSource} onSync={() => void syncKnowledge()} onToggle={toggleSource} sources={snapshot.config.knowledgeSources} stats={snapshot.knowledge} />
          )}

          {section === 'reply' && (
            <div className="content-stack">
              <WorkerControls busy={workerBusy} onRunOnce={() => void runOnce()} onSetEnabled={(enabled) => changePolicy({ enabled })} onStart={() => void setWorkerState('start')} onStop={() => void setWorkerState('stop')} policy={snapshot.config.replyPolicy} runtime={snapshot.runtime} />
              <div className="reply-layout">
                <ReplyPolicyPanel busy={workerBusy} onChange={changePolicy} policy={snapshot.config.replyPolicy} />
                <GroupWhitelist busy={isBusy('save-config')} groups={snapshot.config.groups} onAdd={addGroup} onRemove={removeGroup} onToggle={toggleGroup} />
              </div>
              <AuditTable records={snapshot.recentReplies} />
            </div>
          )}

          {section === 'demoWorkflow' && (
            <DemoWorkflowRequirementPanel
              busyAction={demoWorkflowBusyAction}
              onAnalyze={(input) => void previewDemoWorkflowRequirement(input)}
              onCreate={(input) => void createDemoWorkflowRequirement(input)}
              onOpen={(url) => void openDemoWorkflowRequirement(url)}
              onReset={() => {
                setDemoWorkflowPreview(null)
                setDemoWorkflowResult(null)
              }}
              preview={demoWorkflowPreview}
              result={demoWorkflowResult}
            />
          )}

          {section === 'app-config' && (
            <ApplicationConfigurationPanel
              agentTestError={agentTestError}
              agentTestResult={agentTestResult}
              busy={isBusy('save-agent-config')}
              configuration={snapshot.config.agent}
              daemon={snapshot.daemon}
              onProbe={(runtime) => void probeAgentRuntime(runtime)}
              onSave={(input) => void saveAgentConfiguration(input)}
              onTest={() => void testAgentConfiguration()}
              probing={isBusy('probe-agent-runtime')}
              runtimeStatuses={agentRuntimeStatuses}
              testing={isBusy('test-agent-config')}
            />
          )}

          {section === 'settings' && (
            <div className="content-stack">
              <ConnectionGrid busy={connectionBusy} compact connections={snapshot.connections} onAuthenticate={(kind) => void authenticate(kind)} onDisconnectSampleAuth={() => setConfirmSampleAuthDisconnect(true)} onProbe={() => void probeConnections()} />
              <div className="settings-grid">
                <section className="panel settings-card">
                  <div className="settings-icon safe"><Icon name="shield" size={21} /></div>
                  <div><span className="section-kicker">隐私与数据</span><h2>本地运行目录</h2><p>包含配置、知识索引和回复审计记录。认证会话由官方 CLI 管理，LuckyTag 不展示或复制凭据。</p></div>
                  <button className="button secondary" disabled={isBusy('reveal')} onClick={() => void revealRuntimeFolder()} type="button"><Icon name="folder" size={15} /> 在访达中显示</button>
                </section>
                <section className="panel settings-card">
                  <div className="settings-icon app"><BrandLogo /></div>
                  <div><span className="section-kicker">关于</span><h2>LuckyTag 2.0</h2><p>macOS 本地个人分身助理。公开版本使用离线示例连接器展示整体架构。</p></div>
                  <span className="version-chip">Public · 2.0.0</span>
                </section>
              </div>
              <section className="panel security-note">
                <Icon name="shield" size={20} /><div><strong>默认安全基线</strong><p>预演优先、群聊白名单、知识置信度阈值、小时级限流，以及完整的本地审计记录。任何真实发送都需要你主动开启。</p></div>
              </section>
            </div>
          )}
        </div>
      </main>

      {confirmLive && (
        <div className="modal-backdrop" role="presentation">
          <section aria-describedby="live-warning-description" aria-labelledby="live-warning-title" aria-modal="true" className="confirm-dialog" role="dialog">
            <span className="dialog-icon"><Icon name="warning" size={26} /></span>
            <h2 id="live-warning-title">开启真实发送？</h2>
            <p id="live-warning-description">LuckyTag 将以你的身份向已启用的白名单群聊发送消息。请先确认知识命中质量、群聊范围与限流策略。</p>
            <div className="dialog-checks"><span><Icon name="check" size={14} /> 仅白名单群聊</span><span><Icon name="check" size={14} /> 保留完整审计</span><span><Icon name="check" size={14} /> 受每小时上限保护</span></div>
            <div className="dialog-actions"><button autoFocus className="button ghost" onClick={() => setConfirmLive(false)} type="button">保持预演</button><button className="button danger" onClick={confirmLiveSending} type="button">确认真实发送</button></div>
          </section>
        </div>
      )}
      {confirmSampleAuthDisconnect && (
        <div className="modal-backdrop" role="presentation">
          <section aria-describedby="sampleauth-disconnect-description" aria-labelledby="sampleauth-disconnect-title" aria-modal="true" className="confirm-dialog" role="dialog">
            <span className="dialog-icon"><Icon name="warning" size={26} /></span>
            <h2 id="sampleauth-disconnect-title">断开 SampleAuth 身份？</h2>
            <p id="sampleauth-disconnect-description">这会退出本机全部 SampleAuth skill 会话，其他依赖 SampleAuth 的本地工具可能也需要重新登录。示例消息 DEMO_MESSAGE 与示例知识库 CLI 的独立登录态不会被清除。</p>
            <div className="dialog-actions"><button autoFocus className="button ghost" onClick={() => setConfirmSampleAuthDisconnect(false)} type="button">保持连接</button><button className="button danger" onClick={() => void disconnectSampleAuth()} type="button">确认断开</button></div>
          </section>
        </div>
      )}
      <ToastRegion onDismiss={dismissToast} toasts={toasts} />
    </div>
  )
}

function upsertConnection(connections: ConnectionStatus[], next: ConnectionStatus): ConnectionStatus[] {
  return connections.some((connection) => connection.kind === next.kind)
    ? connections.map((connection) => connection.kind === next.kind ? next : connection)
    : [...connections, next]
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

function getOverviewSummary(snapshot: DashboardSnapshot): string {
  if (snapshot.runtime.processing) return '正在检查新消息并检索可信知识，请稍候。'
  if (snapshot.runtime.running) return snapshot.config.replyPolicy.dryRun ? '分身正在预演模式中运行，不会真实发送消息。' : '分身在线，正在按安全策略处理白名单群聊。'
  if (snapshot.config.knowledgeSources.length === 0) return '先添加一个知识源，让我了解你希望如何回答。'
  return '一切就绪。你可以运行一次验证，或启动自动回复服务。'
}

function LoadingScreen(): React.JSX.Element {
  return (
    <div className="boot-screen">
      <div className="boot-card"><div className="brand-mark large"><BrandLogo /></div><h1>LuckyTag</h1><p>正在唤醒你的本地分身…</p><span className="loading-track"><span /></span></div>
    </div>
  )
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="boot-screen">
      <div className="error-card"><span className="dialog-icon"><Icon name="warning" size={26} /></span><h1>暂时无法启动</h1><p>{message}</p><button className="button primary" onClick={onRetry} type="button"><Icon name="refresh" size={15} />重新尝试</button></div>
    </div>
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '桌面端连接意外中断，请重试'
}
