import { Icon, type IconName } from './Icon'

interface MetricCardProps {
  detail: string
  icon: Extract<IconName, 'clock' | 'database' | 'shield' | 'users'>
  label: string
  tone: 'amber' | 'blue' | 'green' | 'violet'
  value: string
}

export function MetricCard({ detail, icon, label, tone, value }: MetricCardProps): React.JSX.Element {
  return (
    <article className="metric-card">
      <span className={`metric-icon ${tone}`}><Icon name={icon} size={18} /></span>
      <div className="metric-card-body">
        <span className="metric-card-label">{label}</span>
        <strong className="metric-card-value">{value}</strong>
        <small className="metric-card-detail" title={detail}>{detail}</small>
      </div>
    </article>
  )
}
