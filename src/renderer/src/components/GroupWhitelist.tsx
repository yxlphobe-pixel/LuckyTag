import { useState, type FormEvent } from 'react'
import type { AllowlistedGroup } from '@shared/contracts'
import { Icon } from './Icon'

interface GroupWhitelistProps {
  groups: AllowlistedGroup[]
  busy: boolean
  onAdd: (group: Omit<AllowlistedGroup, 'enabled'>) => void
  onToggle: (groupId: string, enabled: boolean) => void
  onRemove: (groupId: string) => void
}

export function GroupWhitelist({ groups, busy, onAdd, onToggle, onRemove }: GroupWhitelistProps): React.JSX.Element {
  const [showForm, setShowForm] = useState(false)
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const isSafeId = id.trim().length > 0 && !/[\s\u0000-\u001F\u007F]/.test(id.trim())

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!id.trim() || !label.trim() || !isSafeId) return
    onAdd({ id: id.trim(), label: label.trim() })
    setId('')
    setLabel('')
    setShowForm(false)
  }

  return (
    <section className="panel group-panel">
      <div className="panel-heading simple">
        <div><span className="section-kicker">最小授权</span><h2>群聊白名单</h2></div>
        <button className="button ghost small" disabled={busy} onClick={() => setShowForm((value) => !value)} type="button"><Icon name={showForm ? 'close' : 'plus'} size={15} />{showForm ? '取消' : '添加群聊'}</button>
      </div>
      <p className="panel-description">仅处理明确加入白名单且已启用的群聊；其他会话不会被读取。</p>

      {showForm && (
        <form className="group-form" onSubmit={handleSubmit}>
          <label><span>群名称</span><input maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="如：LuckyTag 内测群" required value={label} /></label>
          <label><span>群 ID</span><input aria-invalid={id.length > 0 && !isSafeId} maxLength={256} onChange={(event) => setId(event.target.value)} placeholder="channelId / channelId" required value={id} /></label>
          {id.length > 0 && !isSafeId && <p className="field-error">群 ID 不能包含空格或控制字符</p>}
          <button className="button primary" disabled={!label.trim() || !id.trim() || !isSafeId || busy} type="submit">加入白名单</button>
        </form>
      )}

      {groups.length === 0 ? (
        <div className="empty-state compact-empty"><div className="empty-icon"><Icon name="users" size={23} /></div><h3>尚未授权任何群聊</h3><p>自动回复不会读取或发送任何群消息。</p></div>
      ) : (
        <div className="group-list">
          {groups.map((group) => (
            <article className={`group-row${group.enabled ? '' : ' disabled'}`} key={group.id}>
              <span className="avatar-mark">{group.label.slice(0, 1).toUpperCase()}</span>
              <div><strong>{group.label}</strong><span title={group.id}>{group.id}</span></div>
              <span className={`small-state ${group.enabled ? 'on' : 'off'}`}>{group.enabled ? '已启用' : '已停用'}</span>
              <label className="switch"><input aria-label={`${group.enabled ? '停用' : '启用'}群聊 ${group.label}`} checked={group.enabled} disabled={busy} onChange={(event) => onToggle(group.id, event.target.checked)} type="checkbox" /><span /></label>
              <button aria-label={`移除 ${group.label}`} className="icon-button danger-hover" disabled={busy} onClick={() => onRemove(group.id)} type="button"><Icon name="trash" size={16} /></button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
