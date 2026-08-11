import { useState } from 'react'
import type { ReplyRecord } from '@shared/contracts'
import { formatDateTime, replyStatusMeta } from '../format'
import { Icon } from './Icon'

interface AuditTableProps {
  records: ReplyRecord[]
  limit?: number
  onViewAll?: () => void
}

export function AuditTable({ records, limit, onViewAll }: AuditTableProps): React.JSX.Element {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const visibleRecords = typeof limit === 'number' ? records.slice(0, limit) : records

  return (
    <section className="panel audit-panel">
      <div className="panel-heading">
        <div><span className="section-kicker">可追溯</span><h2>最近回复</h2></div>
        {onViewAll && records.length > 0 && <button className="text-button" onClick={onViewAll} type="button">查看全部 <Icon name="chevron" size={13} /></button>}
      </div>
      {visibleRecords.length === 0 ? (
        <div className="empty-state audit-empty">
          <div className="empty-icon"><Icon name="message" size={23} /></div>
          <h3>还没有回复记录</h3>
          <p>服务运行后，每次命中、预演、发送或转人工都会记录在这里。</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="audit-table">
            <thead><tr><th>时间</th><th>群聊 / 提问者</th><th>问题</th><th>依据</th><th>状态</th><th><span className="sr-only">详情</span></th></tr></thead>
            <tbody>
              {visibleRecords.map((record) => {
                const meta = replyStatusMeta[record.status]
                const expanded = expandedId === record.id
                return (
                  <tr className={expanded ? 'expanded' : ''} key={record.id}>
                    <td><time dateTime={record.createdAt}>{formatDateTime(record.createdAt)}</time></td>
                    <td><strong>{record.groupLabel}</strong><small>{record.senderLabel || '未知成员'}</small></td>
                    <td className="question-cell"><span title={record.question}>{record.question}</span>{expanded && <div className="record-detail"><p className="detail-label">生成回复</p><p>{record.reply || record.reason || '暂无回复内容'}</p>{record.evidence.length > 0 && <div className="evidence-list">{record.evidence.map((item) => <span key={`${record.id}-${item.documentId}`}>{item.title} · {Math.round(item.score * 100)}%</span>)}</div>}</div>}</td>
                    <td>{record.evidence.length > 0 ? <span className="evidence-count"><Icon name="book" size={13} /> {record.evidence.length} 条</span> : <span className="muted-dash">—</span>}</td>
                    <td><span className={`record-status ${meta.tone}`}><span />{meta.label}</span></td>
                    <td><button aria-expanded={expanded} aria-label={expanded ? '收起详情' : '展开详情'} className={`icon-button chevron-button${expanded ? ' open' : ''}`} onClick={() => setExpandedId(expanded ? null : record.id)} type="button"><Icon name="chevron" size={15} /></button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
