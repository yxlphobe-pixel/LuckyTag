import { useEffect, useState } from 'react'
import type {
  DimaChatWindow,
  DimaRequirementCreateInput,
  DimaRequirementInput,
  DimaRequirementPreview,
  DimaRequirementResult
} from '@shared/contracts'
import { Icon } from './Icon'

interface DimaRequirementPanelProps {
  busyAction: string | null
  preview: DimaRequirementPreview | null
  result: DimaRequirementResult | null
  onAnalyze: (input: DimaRequirementInput) => void
  onCreate: (input: DimaRequirementCreateInput) => void
  onOpen: (url: string) => void
  onReset: () => void
}

const initialInput: DimaRequirementInput = {
  groupName: '',
  chatWindow: '24h',
  dimaSpace: '',
  iteration: '',
  templateUrl: ''
}

export function DimaRequirementPanel({
  busyAction,
  preview,
  result,
  onAnalyze,
  onCreate,
  onOpen,
  onReset
}: DimaRequirementPanelProps): React.JSX.Element {
  const [input, setInput] = useState<DimaRequirementInput>(initialInput)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const analyzing = busyAction === 'dima-preview'
  const creating = busyAction === 'dima-create'

  useEffect(() => {
    if (!preview) return
    setTitle(preview.title)
    setDescription(preview.description)
  }, [preview])

  const update = <K extends keyof DimaRequirementInput>(
    key: K,
    value: DimaRequirementInput[K]
  ): void => {
    setInput((current) => ({ ...current, [key]: value }))
    if (preview || result) onReset()
  }

  const submitAnalysis = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onAnalyze({
      ...input,
      groupName: input.groupName.trim(),
      dimaSpace: input.dimaSpace.trim(),
      iteration: input.iteration.trim(),
      templateUrl: input.templateUrl.trim()
    })
  }

  const canAnalyze =
    input.groupName.trim().length > 0 &&
    input.dimaSpace.trim().length > 0 &&
    input.templateUrl.trim().length > 0 &&
    !busyAction
  const canCreate = Boolean(preview && title.trim() && description.trim() && !busyAction && !result)

  return (
    <div className="content-stack dima-stack">
      <section className="panel dima-intro">
        <span className="dima-intro-icon"><Icon name="clipboard" size={22} /></span>
        <div>
          <span className="section-kicker">CHAT → REQUIREMENT</span>
          <h2>从群聊提炼可执行需求</h2>
          <p>LuckyTag 只读取你指定窗口内的群消息。先生成并展示草稿，只有点击确认后才会写入 Dima。</p>
        </div>
        <div className="dima-flow" aria-label="处理流程">
          <span><b>1</b> 读取群聊</span><i /><span><b>2</b> 检查草稿</span><i /><span><b>3</b> 确认创建</span>
        </div>
      </section>

      <section className="panel dima-form-panel">
        <div className="panel-heading simple">
          <div><span className="section-kicker">输入范围</span><h2>需求来源与落点</h2></div>
          <span className="dima-readonly-badge"><Icon name="shield" size={13} /> 分析阶段只读</span>
        </div>
        <form className="dima-form" onSubmit={submitAnalysis}>
          <label className="field dima-field-wide">
            <span>钉钉群名称 <small>精确群名</small></span>
            <input
              autoComplete="off"
              maxLength={120}
              onChange={(event) => update('groupName', event.target.value)}
              placeholder="例如：项目联调群"
              value={input.groupName}
            />
          </label>
          <label className="field">
            <span>群聊天周期窗口</span>
            <select
              onChange={(event) => update('chatWindow', event.target.value as DimaChatWindow)}
              value={input.chatWindow}
            >
              <option value="24h">最近 24 小时</option>
              <option value="3d">3 天内</option>
              <option value="7d">7 天内</option>
            </select>
          </label>
          <label className="field">
            <span>Dima 需求空间 <small>空间名 / W ID / 链接</small></span>
            <input
              autoComplete="off"
              maxLength={1_024}
              onChange={(event) => update('dimaSpace', event.target.value)}
              placeholder="例如：项目空间或 W2600…"
              value={input.dimaSpace}
            />
          </label>
          <label className="field">
            <span>迭代窗口 <small>非必填</small></span>
            <input
              autoComplete="off"
              maxLength={256}
              onChange={(event) => update('iteration', event.target.value)}
              placeholder="例如：0806内核版"
              value={input.iteration}
            />
          </label>
          <label className="field dima-field-full">
            <span>Dima 需求模板 <small>含 openWorkItemId 的 project.alipay.com 链接</small></span>
            <input
              autoComplete="off"
              maxLength={2_048}
              onChange={(event) => update('templateUrl', event.target.value)}
              placeholder="https://project.alipay.com/space/…?openWorkItemId=…"
              type="url"
              value={input.templateUrl}
            />
          </label>
          <div className="dima-form-action">
            <p><Icon name="shield" size={14} /> 不会自动扩大群聊权限；权限不足时会直接提示。</p>
            <button className="button primary" disabled={!canAnalyze} type="submit">
              <Icon className={analyzing ? 'spin' : undefined} name={analyzing ? 'refresh' : 'sparkle'} size={15} />
              {analyzing ? '正在读取并分析…' : preview ? '重新分析群聊' : '读取群聊并生成草稿'}
            </button>
          </div>
        </form>
      </section>

      {preview && (
        <section className="dima-preview-layout" aria-label="Dima 需求草稿">
          <div className="panel dima-draft-panel">
            <div className="panel-heading simple">
              <div><span className="section-kicker">自动草稿</span><h2>创建前检查并编辑</h2></div>
              <span className="count-badge">{preview.messageCount} 条消息</span>
            </div>
            <label className="field">
              <span>需求标题 <small>{title.length} / 200</small></span>
              <input maxLength={200} onChange={(event) => setTitle(event.target.value)} value={title} />
            </label>
            <label className="field dima-description-field">
              <span>需求描述 <small>Markdown</small></span>
              <textarea
                maxLength={20_000}
                onChange={(event) => setDescription(event.target.value)}
                spellCheck={false}
                value={description}
              />
            </label>
            <div className="dima-create-bar">
              <div><Icon name="warning" size={15} /><p><strong>下一步会真实创建工作项</strong><span>确认标题、描述、空间与迭代无误后再继续。</span></p></div>
              <button
                className="button primary"
                disabled={!canCreate}
                onClick={() => preview && onCreate({ draftId: preview.draftId, title: title.trim(), description: description.trim() })}
                type="button"
              >
                <Icon className={creating ? 'spin' : undefined} name={creating ? 'refresh' : 'send'} size={15} />
                {creating ? '正在创建…' : result ? '已创建' : '确认并创建 Dima 需求'}
              </button>
            </div>
          </div>

          <aside className="panel dima-context-panel">
            <div className="panel-heading simple"><div><span className="section-kicker">创建上下文</span><h2>模板与依据</h2></div></div>
            <dl className="dima-meta-list">
              <div><dt>目标空间</dt><dd>{preview.spaceName}<small>{preview.spaceId}</small></dd></div>
              <div><dt>目标迭代</dt><dd>{preview.sprintName ?? '不加入迭代'}{preview.sprintId && <small>{preview.sprintId}</small>}</dd></div>
              <div><dt>需求模板</dt><dd>{preview.templateTitle}<small>{preview.templateWorkItemId}</small></dd></div>
              <div><dt>处理人</dt><dd>{preview.processor ?? '使用模板默认值'}</dd></div>
              <div><dt>参与人</dt><dd>{preview.members.length > 0 ? preview.members.join('、') : '使用模板默认值'}</dd></div>
            </dl>
            <div className="dima-evidence-heading"><strong>命中依据</strong><span>{preview.evidence.length} 条</span></div>
            <div className="dima-evidence-list">
              {preview.evidence.slice(0, 6).map((item, index) => (
                <article key={`${item.sentAt}-${index}`}>
                  <div><strong>{item.sender}</strong><time>{formatEvidenceTime(item.sentAt)}</time></div>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </aside>
        </section>
      )}

      {result && (
        <section className="panel dima-result" aria-live="polite">
          <span className="dima-result-icon"><Icon name="check" size={24} /></span>
          <div><span className="section-kicker">创建成功</span><h2>{result.title}</h2><p>{result.url}</p></div>
          <button className="button secondary" onClick={() => onOpen(result.url)} type="button"><Icon name="external" size={15} /> 打开 Dima 需求</button>
        </section>
      )}
    </div>
  )
}

const formatEvidenceTime = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}
