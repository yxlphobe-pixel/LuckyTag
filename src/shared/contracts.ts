export const IPC_CHANNELS = {
  getSnapshot: 'luckytag:get-snapshot',
  saveConfig: 'luckytag:save-config',
  saveAgentConfiguration: 'luckytag:save-agent-configuration',
  probeAgentRuntime: 'luckytag:probe-agent-runtime',
  testAgentConfiguration: 'luckytag:test-agent-configuration',
  chooseLocalFolder: 'luckytag:choose-local-folder',
  syncKnowledge: 'luckytag:sync-knowledge',
  probeConnections: 'luckytag:probe-connections',
  authenticate: 'luckytag:authenticate',
  disconnectSampleAuth: 'luckytag:disconnect-sampleauth',
  startWorker: 'luckytag:start-worker',
  stopWorker: 'luckytag:stop-worker',
  runOnce: 'luckytag:run-once',
  previewDemoWorkflowRequirement: 'luckytag:preview-demoWorkflow-requirement',
  createDemoWorkflowRequirement: 'luckytag:create-demoWorkflow-requirement',
  openDemoWorkflowRequirement: 'luckytag:open-demoWorkflow-requirement',
  revealRuntimeFolder: 'luckytag:reveal-runtime-folder',
  snapshotUpdated: 'luckytag:snapshot-updated'
} as const

export type ConnectionKind = 'sampleMessaging' | 'sampleLibrary' | 'sampleauth' | 'sample-device'
export type ConnectionState = 'connected' | 'disconnected' | 'unavailable' | 'checking'
export type ReplyStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'ignored'
  | 'needs_manual'
  | 'recalled'
  | 'dry_run'
  | 'failed'

export interface AllowlistedGroup {
  id: string
  label: string
  enabled: boolean
}

export type KnowledgeSource =
  | {
      id: string
      type: 'local-directory'
      label: string
      path: string
      enabled: boolean
    }
  | {
      id: string
      type: 'sampleLibrary-doc'
      label: string
      routeOrUrl: string
      enabled: boolean
    }
  | {
      id: string
      type: 'sampleLibrary-book'
      label: string
      namespace: string
      enabled: boolean
    }

export interface ReplyPolicy {
  enabled: boolean
  dryRun: boolean
  pollIntervalSeconds: number
  lookbackMinutes: number
  confidenceThreshold: number
  maxReplyLength: number
  maxRepliesPerHour: number
  followUpHours: number
  markExistingIgnored: boolean
}

export type AgentRuntimeKind = 'codex' | 'claude-code'
export type AgentConfigurationMode = 'runtime-default' | 'custom-model'
export type AgentModelProtocol = 'openai-responses' | 'anthropic-messages'
export type AgentProviderId =
  | 'openai'
  | 'anthropic'
  | 'sample-cloud'
  | 'openrouter'
  | 'azure-openai'
  | 'aws-bedrock'
  | 'ollama'
  | 'custom'
export type AgentAuthenticationKind = 'api-key' | 'none'

export interface AgentModelConfiguration {
  provider: AgentProviderId
  protocol: AgentModelProtocol
  authentication: AgentAuthenticationKind
  name: string
  baseUrl: string
  apiKeyConfigured: boolean
}

export interface AgentConfiguration {
  enabled: boolean
  runtime: AgentRuntimeKind
  mode: AgentConfigurationMode
  model: AgentModelConfiguration
}

export interface AgentConfigurationInput {
  enabled: boolean
  runtime: AgentRuntimeKind
  mode: AgentConfigurationMode
  provider: AgentProviderId
  protocol: AgentModelProtocol
  authentication: AgentAuthenticationKind
  modelName: string
  baseUrl: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AppConfig {
  version: 3
  onboardingComplete: boolean
  groups: AllowlistedGroup[]
  knowledgeSources: KnowledgeSource[]
  replyPolicy: ReplyPolicy
  agent: AgentConfiguration
}

export interface ConnectionStatus {
  kind: ConnectionKind
  state: ConnectionState
  label: string
  detail: string
  checkedAt?: string
  version?: string
}

export interface KnowledgeStats {
  documentCount: number
  chunkCount: number
  lastSyncedAt?: string
  sourceErrors: Array<{ sourceId: string; message: string }>
}

export interface ReplyEvidence {
  documentId: string
  title: string
  sourceLabel: string
  excerpt: string
  score: number
}

export interface ReplyRecord {
  id: string
  messageId: string
  groupId: string
  groupLabel: string
  senderLabel?: string
  question: string
  reply?: string
  status: ReplyStatus
  reason?: string
  createdAt: string
  updatedAt: string
  evidence: ReplyEvidence[]
  leaseExpiresAt?: string
  platformTaskId?: string
}

export interface RuntimeStatus {
  running: boolean
  processing: boolean
  lastRunAt?: string
  nextRunAt?: string
  lastError?: string
  instanceId: string
}

export interface AgentRuntimeStatus {
  runtime: AgentRuntimeKind
  available: boolean
  detail: string
  checkedAt: string
  version?: string
}

export interface AgentConfigurationTestResult {
  runtime: AgentRuntimeKind
  mode: AgentConfigurationMode
  status: 'succeeded'
  testedAt: string
  durationMs: number
  detail: string
  runtimeVersion?: string
}

export interface DaemonStatus {
  connected: true
  pid: number
  startedAt: string
  transport: 'unix-socket'
  endpoint: string
}

export interface DashboardSnapshot {
  config: AppConfig
  connections: ConnectionStatus[]
  knowledge: KnowledgeStats
  runtime: RuntimeStatus
  recentReplies: ReplyRecord[]
  agentRuntime?: AgentRuntimeStatus
  daemon?: DaemonStatus
}

export interface RunSummary {
  startedAt: string
  finishedAt: string
  discovered: number
  sent: number
  previews: number
  ignored: number
  needsManual: number
  recalled: number
  failed: number
  note?: string
}

export interface SyncSummary {
  startedAt: string
  finishedAt: string
  documentCount: number
  chunkCount: number
  changedDocuments: number
  sourceErrors: Array<{ sourceId: string; message: string }>
}

export type DemoWorkflowChatWindow = '24h' | '3d' | '7d'

export interface DemoWorkflowRequirementInput {
  groupName: string
  chatWindow: DemoWorkflowChatWindow
  demoProject: string
  iteration: string
  templateUrl: string
}

export interface DemoWorkflowRequirementEvidence {
  sentAt: string
  sender: string
  text: string
}

export interface DemoWorkflowRequirementPreview {
  draftId: string
  title: string
  description: string
  groupName: string
  windowStart: string
  windowEnd: string
  messageCount: number
  evidence: DemoWorkflowRequirementEvidence[]
  projectId: string
  projectName: string
  templateRecordId: string
  templateTitle: string
  processor?: string
  members: string[]
  cycleId?: string
  cycleName?: string
  expiresAt: string
}

export interface DemoWorkflowRequirementCreateInput {
  draftId: string
  title: string
  description: string
}

export interface DemoWorkflowRequirementResult {
  recordId: string
  title: string
  url: string
  projectId: string
  cycleId?: string
  createdAt: string
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; detail?: string } }

export interface LuckyTagApi {
  getSnapshot(): Promise<ApiResult<DashboardSnapshot>>
  saveConfig(config: AppConfig): Promise<ApiResult<DashboardSnapshot>>
  saveAgentConfiguration(input: AgentConfigurationInput): Promise<ApiResult<DashboardSnapshot>>
  probeAgentRuntime(runtime: AgentRuntimeKind): Promise<ApiResult<AgentRuntimeStatus>>
  testAgentConfiguration(): Promise<ApiResult<AgentConfigurationTestResult>>
  chooseLocalFolder(): Promise<ApiResult<string | null>>
  syncKnowledge(): Promise<ApiResult<SyncSummary>>
  probeConnections(): Promise<ApiResult<ConnectionStatus[]>>
  authenticate(kind: 'sampleMessaging' | 'sampleLibrary' | 'sampleauth'): Promise<ApiResult<ConnectionStatus>>
  disconnectSampleAuth(): Promise<ApiResult<DashboardSnapshot>>
  startWorker(): Promise<ApiResult<RuntimeStatus>>
  stopWorker(): Promise<ApiResult<RuntimeStatus>>
  runOnce(): Promise<ApiResult<RunSummary>>
  previewDemoWorkflowRequirement(input: DemoWorkflowRequirementInput): Promise<ApiResult<DemoWorkflowRequirementPreview>>
  createDemoWorkflowRequirement(input: DemoWorkflowRequirementCreateInput): Promise<ApiResult<DemoWorkflowRequirementResult>>
  openDemoWorkflowRequirement(url: string): Promise<ApiResult<null>>
  revealRuntimeFolder(): Promise<ApiResult<null>>
  onSnapshotUpdated(callback: (snapshot: DashboardSnapshot) => void): () => void
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 3,
  onboardingComplete: false,
  groups: [],
  knowledgeSources: [],
  agent: {
    enabled: false,
    runtime: 'codex',
    mode: 'runtime-default',
    model: {
      provider: 'openai',
      protocol: 'openai-responses',
      authentication: 'api-key',
      name: '',
      baseUrl: '',
      apiKeyConfigured: false
    }
  },
  replyPolicy: {
    enabled: false,
    dryRun: true,
    pollIntervalSeconds: 300,
    lookbackMinutes: 15,
    confidenceThreshold: 0.2,
    maxReplyLength: 900,
    maxRepliesPerHour: 8,
    followUpHours: 6,
    markExistingIgnored: true
  }
}
