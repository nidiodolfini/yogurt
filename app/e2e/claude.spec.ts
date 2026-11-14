import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const main = join(import.meta.dirname, '../out/main/index.js')

async function launch(userData = mkdtempSync(join(tmpdir(), 'yogurt-e2e-'))) {
  const app = await electron.launch({ args: [main], env: { ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: userData } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('home')).toBeVisible()
  return { app, page, userData }
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))

// the key is only ever saved encrypted by the computer; a Linux runner without a keyring has nothing to encrypt it with
test.skip(process.platform === 'linux', 'needs the computer\'s own encryption')

test('Claude: off until picked, the key saved encrypted and never shown again, the choice kept after relaunch', async () => {
  const a = await launch()
  try {
    const { page } = a
    await page.getByTestId('settings-open').click()
    const via = page.getByTestId('settings-claude-via')
    const stays = page.locator('.settings-privacy')
    await expect(via).toHaveValue('off')
    await expect(stays).toBeVisible()

    // an API key picked with none saved: the local model still writes the notes, so everything still stays here
    await via.selectOption('api')
    await expect(page.getByTestId('settings-claude-key-status')).toHaveAttribute('data-has-key', 'false')
    await expect(stays).toBeVisible()

    const key = page.getByTestId('settings-claude-key')
    await key.fill('sk-ant-e2e-secret')
    await key.press('Enter')
    await expect(page.getByTestId('settings-claude-key-status')).toHaveAttribute('data-has-key', 'true')
    await expect(key).toHaveValue('')
    // Claude writes the notes now: Settings no longer says everything stays on this computer
    await expect(stays).toHaveCount(0)

    const file = saved(a.userData)
    expect(file.claude).toBe('api')
    expect(file.claudeKey).toBeTruthy()
    expect(JSON.stringify(file)).not.toContain('sk-ant-e2e-secret')
    // the page learns only that a key is saved
    const got = await page.evaluate(() => window.yogurt.settings.get())
    expect(got.claudeHasKey).toBe(true)
    expect(JSON.stringify(got)).not.toContain('sk-ant')
    expect(got).not.toHaveProperty('claudeKey')
  } finally { await a.app.close() }

  const b = await launch(a.userData)
  try {
    const { page } = b
    await page.getByTestId('settings-open').click()
    await expect(page.getByTestId('settings-claude-via')).toHaveValue('api')
    await expect(page.getByTestId('settings-claude-key-status')).toHaveAttribute('data-has-key', 'true')

    await page.getByTestId('settings-claude-forget').click()
    await expect(page.getByTestId('settings-claude-key-status')).toHaveAttribute('data-has-key', 'false')
    await expect.poll(() => saved(b.userData).claudeKey).toBeUndefined()
    await expect(page.locator('.settings-privacy')).toBeVisible()

    await page.getByTestId('settings-claude-via').selectOption('cli')
    await expect.poll(() => saved(b.userData).claude).toBe('cli')
    await expect(page.locator('.settings-privacy')).toHaveCount(0)

    await page.getByTestId('settings-claude-via').selectOption('off')
    await expect.poll(() => saved(b.userData).claude).toBeUndefined()
    await expect(page.locator('.settings-privacy')).toBeVisible()
  } finally { await b.app.close() }
})
