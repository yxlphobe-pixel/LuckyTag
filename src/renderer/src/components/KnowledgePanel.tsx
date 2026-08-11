import { useState, type FormEvent } from 'react'
import type { KnowledgeSource, KnowledgeStats } from '@shared/contracts'
import { formatRelativeTime } from '../format'
import { Icon } from './Icon'

export type RemoteSourceInput =
  | { type: 'yuque-doc'; label: string; routeOrUrl: string }
  | { type: 'yuque-book'; label: string; namespace: string }

interface KnowledgePanelProps {
  sources: KnowledgeSource[]
  stats: KnowledgeStats
  busy: boolean
  onChooseLocal: () => void
  onAddRemote: (source: RemoteSourceInput) => void
  onToggle: (sourceId: string, enabled: boolean) => void
  onRemove: (sourceId: string) => void
  onSync: () => void
}

export function KnowledgePanel({ sources, stats, busy, onChooseLocal, onAddRemote, onToggle, onRemove, onSync }: KnowledgePanelProps): React.JSX.Element {
  const [remoteType, setRemoteType] = useState<'yuque-doc' | 'yuque-book'>('yuque-doc')
  const [remoteValue, setRemoteValue] = useState('')
  const [label, setLabel] = useState('')

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const value = remoteValue.trim()
    if (!value) return
    const sourceLabel = label.trim() || (remoteType === 'yuque-doc' ? '语雀文档' : '语雀知识库')
    if (remoteType === 'yuque-doc') onAddRemote({ type: remoteType, label: sourceLabel, routeOrUrl: value })
    else onAddRemote({ type: remoteType, label: sourceLabel, namespace: value })
    setRemoteValue('')
    setLabel('')
  }

  return (
    <div className="content-stack">
      <section className="knowledge-hero panel">
        <div>
          <span className="section-kicker">本地知识引擎</span>
          <h2>让回复有据可查</h2>
          <p>添加本地资料或语雀内容。同步后，LuckyTag 只会基于已索引的知识生成回复。</p>
        </div>
        <div className="knowledge-metrics">
          <div><strong>{stats.documentCount.toLocaleString('zh-CN')}</strong><span>篇文档</span></div>
          <div><strong>{stats.chunkCount.toLocaleString('zh-CN')}</strong><span>个知识片段</span></div>
          <div><strong>{formatRelativeTime(stats.lastSyncedAt)}</strong><span>上次同步</span></div>
        </div>
        <button className="button primary" disabled={busy || sources.length === 0} onClick={onSync} type="button">
          <Icon className={busy ? 'spin' : ''} name="refresh" size={16} /> {busy ? '同步中…' : '立即同步'}
        </button>
      </section>

      <div className="knowledge-layout">
        <section className="panel source-add-panel">
          <div className="panel-heading simple">
            <div><span className="section-kicker">知识来源</span><h2>添加内容</h2></div>
          </div>

          <button className="source-option" disabled={busy} onClick={onChooseLocal} type="button">
            <span className="source-option-icon local"><Icon name="folder" size={20} /></span>
            <span><strong>本地文件夹</strong><small>支持 Markdown、MDX、TXT 与 HTML</small></span>
            <Icon name="plus" size={17} />
          </button>

          <div className="source-divider"><span>或连接语雀</span></div>
          <div className="segmented" role="tablist" aria-label="语雀来源类型">
            <button aria-selected={remoteType === 'yuque-doc'} className={remoteType === 'yuque-doc' ? 'active' : ''} disabled={busy} onClick={() => setRemoteType('yuque-doc')} role="tab" type="button">单篇文档</button>
            <button aria-selected={remoteType === 'yuque-book'} className={remoteType === 'yuque-book' ? 'active' : ''} disabled={busy} onClick={() => setRemoteType('yuque-book')} role="tab" type="button">知识库</button>
          </div>
          <form className="remote-source-form" onSubmit={handleSubmit}>
            <label>
              <span>显示名称 <small>可选</small></span>
              <input disabled={busy} maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder={remoteType === 'yuque-doc' ? '如：产品 FAQ' : '如：团队知识库'} value={label} />
            </label>
            <label>
              <span>{remoteType === 'yuque-doc' ? '文档链接或路径' : '知识库 Namespace'}</span>
              <input disabled={busy} onChange={(event) => setRemoteValue(event.target.value)} placeholder={remoteType === 'yuque-doc' ? 'https://yuque.antfin.com/…' : 'team/book'} required value={remoteValue} />
            </label>
            <button className="button secondary full" disabled={busy || !remoteValue.trim()} type="submit"><Icon name="plus" size={15} /> 添加语雀来源</button>
          </form>
        </section>

        <section className="panel source-list-panel">
          <div className="panel-heading simple">
            <div><span className="section-kicker">已配置</span><h2>知识源</h2></div>
            <span className="count-badge">{sources.length}</span>
          </div>
          {sources.length === 0 ? (
            <div className="empty-state compact-empty">
              <div className="empty-icon"><Icon name="database" size={23} /></div>
              <h3>还没有知识源</h3>
              <p>从左侧添加一个本地文件夹或语雀内容。</p>
            </div>
          ) : (
            <div className="source-list">
              {sources.map((source) => {
                const description = source.type === 'local-directory' ? source.path : source.type === 'yuque-doc' ? source.routeOrUrl : source.namespace
                const icon = source.type === 'local-directory' ? 'folder' : source.type === 'yuque-doc' ? 'link' : 'library'
                return (
                  <article className={`source-row${source.enabled ? '' : ' disabled'}`} key={source.id}>
                    <span className={`source-kind ${source.type}`}><Icon name={icon} size={18} /></span>
                    <div className="source-copy"><strong>{source.label}</strong><span title={description}>{description}</span></div>
                    <label className="switch" title={source.enabled ? '停用来源' : '启用来源'}>
                      <input aria-label={`${source.enabled ? '停用' : '启用'}知识源 ${source.label}`} checked={source.enabled} disabled={busy} onChange={(event) => onToggle(source.id, event.target.checked)} type="checkbox" />
                      <span />
                    </label>
                    <button aria-label={`删除 ${source.label}`} className="icon-button danger-hover" disabled={busy} onClick={() => onRemove(source.id)} type="button"><Icon name="trash" size={16} /></button>
                  </article>
                )
              })}
            </div>
          )}
          {stats.sourceErrors.length > 0 && (
            <div className="inline-alert danger"><Icon name="warning" size={17} /><div><strong>部分来源同步失败</strong><p>{stats.sourceErrors.map((error) => error.message).join('；')}</p></div></div>
          )}
        </section>
      </div>
    </div>
  )
}
