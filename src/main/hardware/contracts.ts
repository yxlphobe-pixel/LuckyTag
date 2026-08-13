export interface HardwareDeviceView {
  id: string
  model: string
  name: string
  connected: boolean
  capabilities: string[]
}

export interface HardwareEvent {
  deviceId: string
  type: string
  occurredAt: string
  payload: unknown
}

/** Future sample-device integration boundary; no private protocol is guessed here. */
export interface HardwareBridge {
  discover(): Promise<HardwareDeviceView[]>
  connect(deviceId: string): Promise<HardwareDeviceView>
  disconnect(deviceId: string): Promise<void>
  subscribe(listener: (event: HardwareEvent) => void): () => void
}
