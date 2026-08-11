import type { ReplyPolicy } from '@shared/contracts'
import { Icon } from './Icon'

interface ReplyPolicyPanelProps {
  policy: ReplyPolicy
  busy: boolean
  onChange: (patch: Partial<ReplyPolicy>) => void
}

const numberValue = (value: string): number => Number.parseFloat(value)

export function ReplyPolicyPanel({ policy, busy, onChange }: ReplyPolicyPanelProps): React.JSX.Element {
  return (
    <section className="panel policy-panel">
      <div className="panel-heading simple">
        <div><span className="section-kicker">安全策略</span><h2>回复边界</h2></div>
        <Icon name="shield" size={20} />
      </div>

      <div className={`mode-card ${policy.dryRun ? 'preview' : 'live'}`}>
        <div className="mode-icon"><Icon name={policy.dryRun ? 'sparkle' : 'warning'} size={21} /></div>
        <div>
          <strong>{policy.dryRun ? '预演模式 · 不会真实发送' : '真实发送已开启'}</strong>
          <p>{policy.dryRun ? 'LuckyTag 会生成回复并写入审计记录，适合先验证命中质量。' : '满足策略的回复将直接发到钉钉群，请确认白名单和限流设置。'}</p>
        </div>
        <label className="switch large" title="切换预演模式">
          <input aria-label="启用真实消息发送" checked={!policy.dryRun} disabled={busy} onChange={(event) => onChange({ dryRun: !event.target.checked })} type="checkbox" />
          <span />
        </label>
      </div>
      {!policy.dryRun && (
        <div className="inline-alert warning prominent"><Icon name="warning" size={18} /><div><strong>真实消息会以你的身份发出</strong><p>建议先在预演模式检查审计记录，再小范围启用。</p></div></div>
      )}

      <div className="policy-grid">
        <label className="field">
          <span>轮询间隔<small>检查新消息的频率</small></span>
          <select disabled={busy} onChange={(event) => onChange({ pollIntervalSeconds: numberValue(event.target.value) })} value={policy.pollIntervalSeconds}>
            <option value={60}>1 分钟</option><option value={180}>3 分钟</option><option value={300}>5 分钟</option><option value={600}>10 分钟</option><option value={1800}>30 分钟</option>
          </select>
        </label>
        <label className="field">
          <span>回看窗口<small>只读取最近的新消息</small></span>
          <select disabled={busy} onChange={(event) => onChange({ lookbackMinutes: numberValue(event.target.value) })} value={policy.lookbackMinutes}>
            <option value={5}>5 分钟</option><option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时</option><option value={240}>4 小时</option>
          </select>
        </label>
        <label className="field">
          <span>知识置信度<small>低于阈值转人工</small></span>
          <select disabled={busy} onChange={(event) => onChange({ confidenceThreshold: numberValue(event.target.value) })} value={policy.confidenceThreshold}>
            <option value={0.1}>宽松 · 10%</option><option value={0.2}>推荐 · 20%</option><option value={0.35}>稳妥 · 35%</option><option value={0.5}>严格 · 50%</option><option value={0.7}>非常严格 · 70%</option>
          </select>
        </label>
        <label className="field">
          <span>每小时上限<small>防止集中发送</small></span>
          <select disabled={busy} onChange={(event) => onChange({ maxRepliesPerHour: numberValue(event.target.value) })} value={policy.maxRepliesPerHour}>
            <option value={3}>3 条</option><option value={5}>5 条</option><option value={8}>8 条</option><option value={15}>15 条</option><option value={30}>30 条</option>
          </select>
        </label>
        <label className="field">
          <span>回复长度<small>超长内容将安全截断</small></span>
          <select disabled={busy} onChange={(event) => onChange({ maxReplyLength: numberValue(event.target.value) })} value={policy.maxReplyLength}>
            <option value={300}>300 字</option><option value={600}>600 字</option><option value={900}>900 字</option><option value={1500}>1500 字</option><option value={3000}>3000 字</option>
          </select>
        </label>
        <label className="field">
          <span>追问窗口<small>识别同一发送者的后续提问</small></span>
          <select disabled={busy} onChange={(event) => onChange({ followUpHours: numberValue(event.target.value) })} value={policy.followUpHours}>
            <option value={1}>1 小时</option><option value={3}>3 小时</option><option value={6}>6 小时</option><option value={12}>12 小时</option><option value={24}>24 小时</option>
          </select>
        </label>
      </div>

      <label className="checkbox-row">
        <input checked={policy.markExistingIgnored} disabled={busy} onChange={(event) => onChange({ markExistingIgnored: event.target.checked })} type="checkbox" />
        <span><strong>首次运行时忽略已有消息</strong><small>避免安装后误回复历史内容，推荐保持开启。</small></span>
      </label>
    </section>
  )
}
