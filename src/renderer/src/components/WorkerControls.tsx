import type { ReplyPolicy, RuntimeStatus } from '@shared/contracts'
import { formatDateTime } from '../format'
import { Icon } from './Icon'

interface WorkerControlsProps {
  policy: ReplyPolicy
  runtime: RuntimeStatus
  busy: boolean
  onStart: () => void
  onStop: () => void
  onRunOnce: () => void
  onSetEnabled: (enabled: boolean) => void
}

export function WorkerControls({ policy, runtime, busy, onStart, onStop, onRunOnce, onSetEnabled }: WorkerControlsProps): React.JSX.Element {
  return (
    <section className="panel worker-panel">
      <div className="worker-main">
        <div className={`worker-orb${runtime.running ? ' running' : ''}${runtime.processing ? ' processing' : ''}`}>
          <Icon name={runtime.running ? 'pulse' : 'stop'} size={23} />
          {runtime.running && <span className="orb-wave" />}
        </div>
        <div className="worker-copy">
          <span className="section-kicker">自动回复服务</span>
          <div className="worker-title-row">
            <h2>{runtime.processing ? '正在处理新消息' : runtime.running ? '服务运行中' : '服务已停止'}</h2>
            <span className={`status-pill ${runtime.running ? 'connected' : 'disconnected'}`}><span />{runtime.running ? '运行中' : '已停止'}</span>
          </div>
          <p>
            {runtime.running
              ? `每 ${Math.round(policy.pollIntervalSeconds / 60)} 分钟检查一次白名单群聊${runtime.nextRunAt ? `，下次 ${formatDateTime(runtime.nextRunAt)}` : ''}`
              : '启动后才会轮询白名单群聊；你也可以只运行一次进行验证。'}
          </p>
        </div>
      </div>
      <div className="worker-actions">
        <label className="enable-control">
          <span><strong>允许自动回复</strong><small>策略总开关</small></span>
          <span className="switch large"><input checked={policy.enabled} disabled={busy} onChange={(event) => onSetEnabled(event.target.checked)} type="checkbox" /><span /></span>
        </label>
        <div className="button-row">
          {runtime.running ? (
            <button className="button stop-button" disabled={busy} onClick={onStop} type="button"><Icon name="stop" size={15} /> 停止服务</button>
          ) : (
            <button className="button primary" disabled={busy || !policy.enabled} onClick={onStart} type="button"><Icon name="play" size={15} /> 启动服务</button>
          )}
          <button className="button secondary" disabled={busy || runtime.processing} onClick={onRunOnce} type="button"><Icon className={runtime.processing ? 'spin' : ''} name="refresh" size={15} /> 运行一次</button>
        </div>
      </div>
      {runtime.lastError && <div className="worker-error"><Icon name="warning" size={16} /><span>{runtime.lastError}</span></div>}
    </section>
  )
}
