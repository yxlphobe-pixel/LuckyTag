import type { BrowserWindowConstructorOptions } from 'electron'

export const createMainWindowOptions = (
  preloadPath: string
): BrowserWindowConstructorOptions => ({
  width: 1260,
  height: 820,
  minWidth: 980,
  minHeight: 680,
  show: false,
  title: 'LuckyTag',
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 18 },
  backgroundColor: '#f5f2ea',
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false
  }
})
