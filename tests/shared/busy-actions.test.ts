import { describe, expect, it } from 'vitest'
import { addBusyAction, hasBusyAction, removeBusyAction } from '../../src/shared/busy-actions'

describe('并发 busy action 计数', () => {
  it('较早结束的动作不会清除仍在运行的另一个动作', () => {
    let state = addBusyAction({}, 'runtime-probe')
    state = addBusyAction(state, 'connection-probe')
    state = removeBusyAction(state, 'runtime-probe')

    expect(hasBusyAction(state, 'runtime-probe')).toBe(false)
    expect(hasBusyAction(state, 'connection-probe')).toBe(true)
  })

  it('相同动作并发时按引用计数释放', () => {
    let state = addBusyAction({}, 'save-config')
    state = addBusyAction(state, 'save-config')
    state = removeBusyAction(state, 'save-config')

    expect(hasBusyAction(state, 'save-config')).toBe(true)
    expect(removeBusyAction(state, 'save-config')).toEqual({})
  })
})
