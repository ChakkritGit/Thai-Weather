import { expect, test } from 'bun:test'
import { includeVolume, gitHead } from './backup'

test('which volumes go into a bundle', () => {
  for (const v of ['thai-weather_npm-data', 'thai-weather_npm-letsencrypt', 'thai-weather_portainer-data', 'thai-weather_thwx-data', 'apps_media-data', 'apps_sync-data']) expect(includeVolume(v)).toBe(true)
  // caches, anonymous volumes and the raw database files (dumped logically instead) stay out
  for (const v of ['apps_portfolio-cache', 'b6a7a2b8f1a7b736037da4a109f714dbd69f7bc10f85515ea266cf56c9bbcb4b', 'apps_db-data', 'metadata.db']) expect(includeVolume(v)).toBe(false)
})

test('reads the checked-out commit of this repo without git', async () => {
  const head = await gitHead(`${import.meta.dir}/../../../..`)
  expect(head?.commit).toMatch(/^[0-9a-f]{40}$/)
  expect(head?.url).toContain('Thai-Weather')
  const real = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: import.meta.dir }).stdout.toString().trim()
  expect(head?.commit).toBe(real)
})
