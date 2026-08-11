const { app, BrowserWindow } = require('electron')

const htmlPath = process.argv[2]
const scenarios = JSON.parse(process.argv[3] || '[]')

async function measure(window, scenario) {
  window.setContentSize(scenario.width, 820)
  window.webContents.setZoomFactor(scenario.zoom)
  await new Promise((resolve) => setTimeout(resolve, 80))

  return window.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('.metric-card'))
    const card = cards[2]
    const body = card.querySelector('.metric-card-body')
    const value = card.querySelector('.metric-card-value')
    const detail = card.querySelector('.metric-card-detail')
    const originalValue = value.textContent

    const inspect = () => {
      const range = document.createRange()
      range.selectNodeContents(value)
      const lineTops = new Set(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => Math.round(rect.top))
      )
      return {
        bodyOverflow: body.scrollWidth > body.clientWidth + 1,
        cardOverflow: card.scrollWidth > card.clientWidth + 1,
        detailTextOverflow: getComputedStyle(detail).textOverflow,
        lineCount: lineTops.size,
        valueOverflow: value.scrollWidth > value.clientWidth + 1,
        valueTextOverflow: getComputedStyle(value).textOverflow,
        valueWhiteSpace: getComputedStyle(value).whiteSpace
      }
    }

    const ratio = inspect()
    value.textContent = '1234567890'.repeat(20)
    const longValue = inspect()
    value.textContent = originalValue
    return { longValue, ratio }
  })()`)
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1260,
    height: 820,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    await window.loadFile(htmlPath)
    await window.webContents.executeJavaScript('document.fonts.ready')
    const results = []
    for (const scenario of scenarios) {
      results.push({ ...scenario, measurement: await measure(window, scenario) })
    }
    process.stdout.write(`LUCKYTAG_METRIC_RESULT=${JSON.stringify(results)}\n`)
    app.exit(0)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    app.exit(1)
  }
})
