import { getCurrentWindow, type Theme } from '@tauri-apps/api/window'

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'
  document.documentElement.style.colorScheme = theme === 'dark' ? 'dark' : 'light'
}

export async function watchTheme() {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  applyTheme(media.matches ? 'dark' : 'light')
  try {
    const currentWindow = getCurrentWindow()
    const theme = await currentWindow.theme()
    if (theme) applyTheme(theme)
    await currentWindow.onThemeChanged(({ payload }) => applyTheme(payload))
  } catch {
    media.addEventListener('change', (event) => applyTheme(event.matches ? 'dark' : 'light'))
  }
}
