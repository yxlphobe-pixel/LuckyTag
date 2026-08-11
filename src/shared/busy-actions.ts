export type BusyActionCounts = Readonly<Record<string, number>>

export const addBusyAction = (current: BusyActionCounts, action: string): BusyActionCounts => ({
  ...current,
  [action]: (current[action] || 0) + 1
})

export const removeBusyAction = (current: BusyActionCounts, action: string): BusyActionCounts => {
  const count = current[action] || 0
  if (count > 1) return { ...current, [action]: count - 1 }
  if (count === 0) return current
  const next = { ...current }
  delete next[action]
  return next
}

export const hasBusyAction = (current: BusyActionCounts, action: string): boolean => Boolean(current[action])
