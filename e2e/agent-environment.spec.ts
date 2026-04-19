import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'

let electronApp: ElectronApplication

test.afterEach(async () => {
  await electronApp?.close()
})

test('launches the agent environment and completes a fake Codex turn', async () => {
  electronApp = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      GENCODE_FAKE_PROVIDER: '1'
    }
  })

  const window = await electronApp.firstWindow()
  await window.evaluate(() => {
    localStorage.setItem(
      'gencode.workspace.v1',
      JSON.stringify({
        projects: [
          {
            id: 'e2e-project',
            name: 'e2e-project',
            path: '/tmp/e2e-project',
            open: true,
            chats: [
              {
                id: 'project:e2e-project:chat:main',
                label: 'Smoke chat',
                createdAt: '2026-04-19T00:00:00.000Z'
              }
            ]
          }
        ],
        activeProjectId: 'e2e-project',
        activeChatId: 'project:e2e-project:chat:main'
      })
    )
  })
  await window.reload()

  await expect(window.getByRole('heading', { name: /smoke chat/i })).toBeVisible()
  await expect(window.getByText(/fake provider for deterministic tests/i)).toBeVisible()

  await window.getByRole('textbox', { name: /ask codex/i }).fill('Run the e2e smoke path')
  await window.getByRole('button', { name: /send/i }).click()

  await expect(window.getByText(/this fake provider proves the ui stream/i)).toBeVisible()
  await expect(window.getByText(/terminal/i).first()).toBeVisible()
})
