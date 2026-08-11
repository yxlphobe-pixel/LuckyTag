import type { ReplyStatus } from '@shared/contracts'

export const formatDateTime = (value?: string): string => {
  if (!value) return '尚无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export const formatRelativeTime = (value?: string): string => {
  if (!value) return '从未'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}

export const replyStatusMeta: Record<ReplyStatus, { label: string; tone: string }> = {
  pending: { label: '待处理', tone: 'pending' },
  sending: { label: '发送中', tone: 'pending' },
  sent: { label: '已发送', tone: 'success' },
  ignored: { label: '已忽略', tone: 'muted' },
  needs_manual: { label: '待人工', tone: 'warning' },
  recalled: { label: '已撤回', tone: 'warning' },
  dry_run: { label: '仅预览', tone: 'preview' },
  failed: { label: '失败', tone: 'danger' }
}
