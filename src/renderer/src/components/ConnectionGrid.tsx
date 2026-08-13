import type { ConnectionKind, ConnectionStatus } from '@shared/contracts'
import { Icon, type IconName } from './Icon'

interface ConnectionGridProps {
  connections: ConnectionStatus[]
  busy: boolean
  compact?: boolean
  onAuthenticate: (kind: 'sampleMessaging' | 'sampleLibrary' | 'sampleauth') => void
  onDisconnectSampleAuth: () => void
  onProbe: () => void
}

type AuthenticatableConnectionKind = Exclude<ConnectionKind, 'sample-device'>

const connectionMeta: Record<ConnectionKind, { name: string; eyebrow: string; icon: IconName }> = {
  sampleMessaging: { name: 'DEMO_MESSAGE / 示例消息', eyebrow: '消息入口', icon: 'message' },
  sampleLibrary: { name: '示例知识库', eyebrow: '知识来源', icon: 'book' },
  sampleauth: { name: 'SampleAuth', eyebrow: '统一身份', icon: 'shield' },
  'sample-device': { name: '示例设备', eyebrow: '本地硬件', icon: 'pulse' }
}

const stateLabels: Record<ConnectionStatus['state'], string> = {
  connected: '已连接',
  disconnected: '未连接',
  unavailable: '暂不可用',
  checking: '检测中'
}

function ConnectionCard({
  connection,
  busy,
  onAuthenticate,
  onDisconnectSampleAuth
}: {
  connection: ConnectionStatus
  busy: boolean
  onAuthenticate: (kind: AuthenticatableConnectionKind) => void
  onDisconnectSampleAuth: () => void
}): React.JSX.Element {
  const meta = connectionMeta[connection.kind]
  const canAuthenticate = connection.kind !== 'sample-device'
  const needsAuth = connection.state === 'disconnected' && canAuthenticate
  const canDisconnectSampleAuth = connection.kind === 'sampleauth' && connection.state === 'connected'

  return (
    <article className="connection-card">
      <div className={`connection-icon ${connection.kind}`}><Icon name={meta.icon} size={19} /></div>
      <div className="connection-copy">
        <span className="connection-eyebrow">{meta.eyebrow}</span>
        <strong>{meta.name}</strong>
        <p title={connection.detail}>{connection.detail || '等待状态检测'}</p>
      </div>
      <div className="connection-action">
        <span className={`status-pill ${connection.state}`}><span />{stateLabels[connection.state]}</span>
        {needsAuth && (
          <button className="text-button" disabled={busy} onClick={() => onAuthenticate(connection.kind as AuthenticatableConnectionKind)} type="button">
            去连接 <Icon name="chevron" size={13} />
          </button>
        )}
        {canDisconnectSampleAuth && (
          <button className="text-button" disabled={busy} onClick={onDisconnectSampleAuth} type="button">
            断开身份
          </button>
        )}
      </div>
    </article>
  )
}

export function ConnectionGrid({ connections, busy, compact = false, onAuthenticate, onDisconnectSampleAuth, onProbe }: ConnectionGridProps): React.JSX.Element {
  const normalized = (Object.keys(connectionMeta) as ConnectionKind[]).map((kind) =>
    connections.find((item) => item.kind === kind) ?? {
      kind,
      state: 'disconnected' as const,
      label: connectionMeta[kind].name,
      detail: '尚未完成检测'
    }
  )

  return (
    <section className={`panel connection-panel${compact ? ' compact' : ''}`}>
      <div className="panel-heading">
        <div>
          <span className="section-kicker">身份与设备</span>
          <h2>连接状态</h2>
        </div>
        <button className="button ghost small" disabled={busy} onClick={onProbe} type="button">
          <Icon className={busy ? 'spin' : ''} name="refresh" size={15} />
          {busy ? '检测中' : '重新检测'}
        </button>
      </div>
      <div className="connection-grid">
        {normalized.map((connection) => (
          <ConnectionCard busy={busy} connection={connection} key={connection.kind} onAuthenticate={onAuthenticate} onDisconnectSampleAuth={onDisconnectSampleAuth} />
        ))}
      </div>
    </section>
  )
}
