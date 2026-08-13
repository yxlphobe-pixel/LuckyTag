import { Icon, type IconName } from './Icon'
import { BrandLogo } from './BrandLogo'

export type SectionId = 'overview' | 'knowledge' | 'reply' | 'demoWorkflow' | 'app-config' | 'settings'

interface SidebarProps {
  active: SectionId
  workerRunning: boolean
  onNavigate: (section: SectionId) => void
}

const items: Array<{ id: SectionId; label: string; icon: IconName }> = [
  { id: 'overview', label: '总览', icon: 'home' },
  { id: 'knowledge', label: '知识库', icon: 'book' },
  { id: 'reply', label: '自动回复', icon: 'message' },
  { id: 'demoWorkflow', label: 'DemoWorkflow需求', icon: 'clipboard' },
  { id: 'app-config', label: '应用配置', icon: 'terminal' },
  { id: 'settings', label: '设置', icon: 'settings' }
]

export function Sidebar({ active, workerRunning, onNavigate }: SidebarProps): React.JSX.Element {
  return (
    <aside className="sidebar">
      <div className="titlebar-spacer" aria-hidden="true" />

      <div className="brand-block">
        <div className="brand-mark"><BrandLogo /></div>
        <div>
          <p className="brand-name">LuckyTag 2.0</p>
          <p className="brand-subtitle">个人分身助理</p>
        </div>
      </div>

      <nav className="side-nav" aria-label="主导航">
        {items.map((item) => (
          <button
            className={`nav-item${active === item.id ? ' active' : ''}`}
            key={item.id}
            onClick={() => onNavigate(item.id)}
            type="button"
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
            {item.id === 'reply' && workerRunning && <span className="nav-live-dot" aria-label="服务运行中" />}
          </button>
        ))}
      </nav>

      <div className="sidebar-spacer" />
      <div className="local-card">
        <div className="local-card-title"><Icon name="shield" size={16} /> 本地优先</div>
        <p>知识索引、回复记录与策略均保存在这台 Mac，不上传第三方。</p>
        <div className="local-status"><span /> 数据留在本机</div>
      </div>
      <p className="build-label">LuckyTag · Public 2.0</p>
    </aside>
  )
}
