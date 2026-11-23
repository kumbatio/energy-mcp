import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  autonomyStrategy,
  choiceBudgetStrategy,
  createEnergyStore,
  cycleEnergyLevel,
  getEnergyLevel,
  isEnergyLevel,
  notificationStrategy,
  resolveEnergyStatePath,
  sensoryStrategy,
  taskComplexityStrategy,
} from '../src/energy-levels.mjs'

/** A store on a state file in a fresh temporary folder, removed after the test. */
function tempStore(t, originId = 'test') {
  const dir = mkdtempSync(join(tmpdir(), 'kumbatio-levels-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const filePath = join(dir, 'energy-state.json')
  return { dir, filePath, store: createEnergyStore({ filePath, originId }) }
}

function seed(filePath, state) {
  writeFileSync(
    filePath,
    JSON.stringify({ source: 'manual', revision: 0, origin: 'other-app', ...state }),
  )
}

void test('a store with no state file reports the unproduced default', async (t) => {
  const { store } = tempStore(t)
  await store.hydrate()
  assert.deepEqual(store.getState(), {
    level: 100,
    timestamp: 0,
    source: 'manual',
    revision: 0,
    origin: '0-initial',
  })
})

void test('hydrate adopts a valid state another app wrote', async (t) => {
  const { store, filePath } = tempStore(t)
  seed(filePath, { level: 50, timestamp: 1_700_000_000_000, source: 'scheduled', revision: 4 })
  await store.hydrate()
  assert.deepEqual(store.getState(), {
    level: 50,
    timestamp: 1_700_000_000_000,
    source: 'scheduled',
    revision: 4,
    origin: 'other-app',
  })
})

void test('hydrate discards a file that is not a valid state', async (t) => {
  // Each discard is reported on stderr; keep the test output quiet.
  t.mock.method(console, 'error', () => {})
  const invalid = [
    '{not json',
    '[1,2]',
    JSON.stringify({ level: 25, timestamp: 1, source: 'manual', revision: 0 }),
    JSON.stringify({ level: 25, timestamp: 1, source: 'manual', revision: 0, origin: 'a', mood: 'x' }),
    JSON.stringify({ level: 30, timestamp: 1, source: 'manual', revision: 0, origin: 'a' }),
    JSON.stringify({ level: '25', timestamp: 1, source: 'manual', revision: 0, origin: 'a' }),
    JSON.stringify({ level: 25, timestamp: 1.5, source: 'manual', revision: 0, origin: 'a' }),
    JSON.stringify({ level: 25, timestamp: 1, source: 'guessed', revision: 0, origin: 'a' }),
    JSON.stringify({ level: 25, timestamp: 1, source: 'manual', revision: -1, origin: 'a' }),
    JSON.stringify({ level: 25, timestamp: 1, source: 'manual', revision: 0, origin: '  ' }),
  ]
  for (const content of invalid) {
    const { store, filePath } = tempStore(t)
    writeFileSync(filePath, content)
    await store.hydrate()
    assert.equal(store.getState().origin, '0-initial', `adopted: ${content}`)
  }
  assert.equal(console.error.mock.callCount(), invalid.length)
})

void test('hydrate refuses a state stamped more than five minutes ahead', async (t) => {
  t.mock.method(console, 'error', () => {})
  const ahead = tempStore(t)
  seed(ahead.filePath, { level: 25, timestamp: Date.now() + 10 * 60_000 })
  await ahead.store.hydrate()
  assert.equal(ahead.store.getState().origin, '0-initial')

  const near = tempStore(t)
  seed(near.filePath, { level: 25, timestamp: Date.now() + 60_000 })
  await near.store.hydrate()
  assert.equal(near.store.getState().level, 25)
})

void test('a stored state replaces the current one only when it is preferred', async (t) => {
  const { store, filePath } = tempStore(t)
  const timestamp = 1_700_000_000_000
  const steps = [
    // [state written to the file, level expected afterwards]
    [{ level: 25, timestamp, source: 'inferred', origin: 'a' }, 25],
    [{ level: 50, timestamp: timestamp - 1, source: 'manual', origin: 'z' }, 25], // older
    [{ level: 50, timestamp, source: 'scheduled', origin: 'a' }, 50], // higher source
    [{ level: 75, timestamp, source: 'inferred', origin: 'z' }, 50], // lower source
    [{ level: 0, timestamp, source: 'scheduled', origin: 'b' }, 0], // higher origin
    [{ level: 75, timestamp, source: 'scheduled', origin: 'b' }, 75], // higher level
    [{ level: 100, timestamp, source: 'inferred', origin: 'b', revision: 1 }, 100], // higher revision
    [{ level: 25, timestamp: timestamp + 1, source: 'inferred', origin: 'a' }, 25], // newer
  ]
  for (const [state, expected] of steps) {
    seed(filePath, state)
    await store.hydrate()
    assert.equal(store.getState().level, expected, JSON.stringify(state))
  }
})

void test('setLevel writes the state file in the interchange format', async (t) => {
  const { store, filePath, dir } = tempStore(t, 'writer')
  const before = Date.now()
  await store.setLevel(25)
  const state = store.getState()

  assert.equal(state.level, 25)
  assert.equal(state.source, 'manual')
  assert.equal(state.revision, 0)
  assert.equal(state.origin, 'writer')
  assert.ok(state.timestamp >= before && state.timestamp <= Date.now())
  assert.equal(readFileSync(filePath, 'utf8'), `${JSON.stringify(state, null, 2)}\n`)
  assert.deepEqual(readdirSync(dir), ['energy-state.json'], 'the temporary file is gone')
})

void test('setLevel never stamps a state older than the one it replaces', async (t) => {
  const { store, filePath } = tempStore(t, 'writer')
  const future = Date.now() + 60_000
  seed(filePath, { level: 25, timestamp: future, revision: 7 })
  await store.hydrate()

  await store.setLevel(50)
  assert.deepEqual(store.getState(), {
    level: 50,
    timestamp: future,
    source: 'manual',
    revision: 8,
    origin: 'writer',
  })

  const capped = tempStore(t, 'writer')
  seed(capped.filePath, { level: 25, timestamp: future, revision: Number.MAX_SAFE_INTEGER })
  await capped.store.hydrate()
  await capped.store.setLevel(50)
  assert.equal(capped.store.getState().timestamp, future + 1)
  assert.equal(capped.store.getState().revision, 0)
})

void test('two setLevel calls made together are written in order', async (t) => {
  const { store, filePath } = tempStore(t)
  const first = store.setLevel(25)
  const second = store.setLevel(75)
  await Promise.all([first, second])

  const written = JSON.parse(readFileSync(filePath, 'utf8'))
  assert.equal(written.level, 75)
  assert.deepEqual(store.getState(), written)
})

void test('setLevel rejects and keeps the state when the file cannot be written', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kumbatio-levels-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // The state file's folder is a regular file, so no write can succeed.
  writeFileSync(join(dir, 'blocker'), 'x')
  const filePath = join(dir, 'blocker', 'energy-state.json')
  const store = createEnergyStore({ filePath, originId: 'test' })

  await assert.rejects(store.setLevel(25), (err) => {
    assert.match(err.message, /Failed to save energy state to/)
    assert.ok(err.cause instanceof Error)
    return true
  })
  assert.equal(store.getState().origin, '0-initial')
  await assert.rejects(store.setLevel(30), /Invalid energy level: 30/)
})

void test('resolveEnergyStatePath follows the documented order', () => {
  assert.equal(
    resolveEnergyStatePath({ KUMBATIO_ENERGY_FILE: ' /x/e.json ', XDG_STATE_HOME: '/state' }, 'linux'),
    '/x/e.json',
  )
  assert.equal(
    resolveEnergyStatePath({ XDG_STATE_HOME: '/state' }, 'linux'),
    join('/state', 'kumbatio', 'energy-state.json'),
  )
  assert.equal(
    resolveEnergyStatePath({ LOCALAPPDATA: '/local' }, 'win32'),
    join('/local', 'kumbatio', 'energy-state.json'),
  )
  assert.match(
    resolveEnergyStatePath({ LOCALAPPDATA: '/local' }, 'darwin'),
    /[\\/]\.config[\\/]kumbatio[\\/]energy-state\.json$/,
  )
})

void test('levels and strategies hold the energy-system 3.0.0 values', () => {
  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => getEnergyLevel(level).label),
    ['Peak', 'Active', 'Steady', 'Low', 'Rest'],
  )
  assert.throws(() => getEnergyLevel(30), /Invalid energy level: 30/)
  assert.equal(isEnergyLevel(25), true)
  assert.equal(isEnergyLevel('25'), false)
  assert.equal(isEnergyLevel(30), false)
  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => cycleEnergyLevel(level)),
    [75, 50, 25, 0, 100],
  )

  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => autonomyStrategy.resolve(level)),
    [
      { confidenceThreshold: 0.6, allowGeneratedContent: true, maxUnattendedSteps: 8 },
      { confidenceThreshold: 0.7, allowGeneratedContent: true, maxUnattendedSteps: 5 },
      { confidenceThreshold: 0.8, allowGeneratedContent: true, maxUnattendedSteps: 3 },
      { confidenceThreshold: 0.9, allowGeneratedContent: false, maxUnattendedSteps: 1 },
      { confidenceThreshold: 1, allowGeneratedContent: false, maxUnattendedSteps: 1 },
    ],
  )
  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => choiceBudgetStrategy.resolve(level)),
    [
      { maxChoices: null, responseDensity: 'detailed', allowProactiveSuggestions: true },
      { maxChoices: 5, responseDensity: 'balanced', allowProactiveSuggestions: true },
      { maxChoices: 3, responseDensity: 'concise', allowProactiveSuggestions: false },
      { maxChoices: 1, responseDensity: 'single-step', allowProactiveSuggestions: false },
      { maxChoices: 0, responseDensity: 'quiet', allowProactiveSuggestions: false },
    ],
  )
  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => taskComplexityStrategy.resolve(level)),
    [
      { maxComplexity: 'complex', suggestBreaks: false, breakIntervalMinutes: 0 },
      { maxComplexity: 'moderate', suggestBreaks: false, breakIntervalMinutes: 0 },
      { maxComplexity: 'routine', suggestBreaks: true, breakIntervalMinutes: 45 },
      { maxComplexity: 'simple', suggestBreaks: true, breakIntervalMinutes: 25 },
      { maxComplexity: 'consumption', suggestBreaks: false, breakIntervalMinutes: 0 },
    ],
  )
  assert.deepEqual(
    [100, 75, 50, 25, 0].map((level) => sensoryStrategy.resolve(level).motionScale),
    [1, 0.75, 0.5, 0.25, 0],
  )
  assert.equal(
    autonomyStrategy.describe(25),
    'Low: automation acts on 90% confidence, fixed templates only, 1 step at a time',
  )
  assert.equal(choiceBudgetStrategy.describe(50), 'Steady: up to 3 options, concise responses')
  assert.equal(
    notificationStrategy.describe(50),
    'Steady: important alerts only, grouped every 5 minutes',
  )
})
