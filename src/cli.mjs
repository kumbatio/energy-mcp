#!/usr/bin/env node
import {
  autonomyStrategy,
  choiceBudgetStrategy,
  createEnergyEngine,
  getEnergyLevel,
  isEnergyLevel,
  notificationStrategy,
} from '../../energy-system/dist/index.js'
import { filePersistence, resolveEnergyStatePath } from '../../energy-system/dist/node.js'
import { startStdioServer } from './server.mjs'

/*
 * energy-dial — Set your cognitive energy once from any terminal.
 * Every local app watching ~/.config/kumbatio/energy-state.json adapts immediately.
 *
 * Usage:
 *   energy-dial             Show current energy and active adaptations
 *   energy-dial 25          Set energy to 25% (Low)
 *   energy-dial cycle       Step down one level (100 -> 75 -> 50 -> 25 -> 0 -> 100)
 *   energy-dial --mcp       Start the stdio MCP server for AI assistants
 */

const args = process.argv.slice(2)

if (args.includes('--mcp')) {
  startStdioServer()
} else {
  const filePath = resolveEnergyStatePath()
  const engine = createEnergyEngine({
    initialLevel: 100,
    persistence: filePersistence(filePath),
    originId: 'kumbatio-energy-cli',
  })

  await engine.hydrate()

  const cmd = args[0]
  if (cmd === 'cycle') {
    engine.cycleLevel()
    await engine.flush()
  } else if (cmd && cmd !== 'status') {
    const parsed = Number(cmd)
    if (!isEnergyLevel(parsed)) {
      console.error('Please pick one of: 100 (Peak), 75 (Active), 50 (Steady), 25 (Low), 0 (Rest).')
      engine.dispose()
      process.exit(1)
    }
    engine.setLevel(parsed, 'manual')
    await engine.flush()
  }

  const state = engine.getState()
  const def = getEnergyLevel(state.level)
  console.log(`\n  Energy: ${String(def.value)}% · ${def.label}`)
  console.log(`  ${def.description}\n`)
  console.log(`  Alerts:   ${notificationStrategy.describe(def.value)}`)
  console.log(`  Choices:  ${choiceBudgetStrategy.describe(def.value)}`)
  console.log(`  Autonomy: ${autonomyStrategy.describe(def.value)}`)
  console.log(`  File:     ${filePath}\n`)

  engine.dispose()
}
