import type { LuckyTagApi } from '@shared/contracts'

declare global {
  interface Window {
    luckyTag: LuckyTagApi
  }
}

export {}
