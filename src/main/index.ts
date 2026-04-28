import './prependCliPath'
import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icons/png/256x256.png?asset'
import { AgentBackend } from './agent/AgentBackend'
import { registerAgentIpc } from './agent/ipc/registerAgentIpc'
import { openDatabase } from './agent/persistence/Sqlite'

function getDbPath(): string {
  const userData = app.getPath('userData')
  return is.dev ? join(userData, 'dev', 'state.sqlite') : join(userData, 'state.sqlite')
}

const db = openDatabase(getDbPath())
const agentBackend = new AgentBackend({
  useFakeProvider:
    process.env.COBEL_FAKE_PROVIDER === '1' || process.env.GENCODE_FAKE_PROVIDER === '1',
  db
})

void agentBackend.initialize().catch((error) => {
  console.error('Failed to resolve provider CLIs during startup.', error)
})

registerAgentIpc(agentBackend)

let appQuitTeardownStarted = false
app.on('before-quit', (event) => {
  if (appQuitTeardownStarted) return
  appQuitTeardownStarted = true
  event.preventDefault()
  void agentBackend
    .prepareQuit()
    .catch(() => undefined)
    .finally(() => {
      app.quit()
    })
})

if (is.dev) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.COBEL_REMOTE_DEBUG_PORT ?? process.env.GENCODE_REMOTE_DEBUG_PORT ?? '9222'
  )
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 15 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  app.setName('cobel')
  electronApp.setAppUserModelId('com.cobel.app')
  Menu.setApplicationMenu(null)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}
