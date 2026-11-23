/*
 * The part of @kumbatio/energy-system that the MCP server and the terminal dial
 * use, kept inside this folder so the server runs with no dependencies and
 * loads nothing from outside it.
 *
 * Ported from @kumbatio/energy-system 3.0.0 (commit dfd5cbb, MIT). Each section
 * names the source file and lines it was taken from. Values, messages and the
 * order of checks are unchanged; TypeScript types became JSDoc.
 *
 * Reduced on purpose, compared with the library:
 *
 * - `createEnergyStore` replaces `createEnergyEngine`. It keeps the engine's
 *   state rules (the default state, the future-skew check, when a stored state
 *   replaces the one in memory, how a new level is stamped) and drops what a
 *   request/response process does not use: the persistence queue with retry and
 *   backoff, subscribers and `onChange`, the injectable clock, and the
 *   `fs.watch` observer. The server reads the file before every request, so it
 *   sees another app's write without watching for it.
 * - `setLevel` writes the file before it changes the state in memory and
 *   rejects when the write fails. The engine kept the new level in memory and
 *   retried the write in the background, which left a caller waiting on
 *   `flush()` for as long as the write kept failing.
 * - Only the strategies and the strategy methods this folder calls are here.
 *
 * When energy-system changes any of these rules, change them here too.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * @typedef {0 | 25 | 50 | 75 | 100} EnergyLevel
 * @typedef {'manual' | 'scheduled' | 'inferred'} EnergySource
 * @typedef {{ readonly level: EnergyLevel, readonly timestamp: number, readonly source: EnergySource, readonly revision: number, readonly origin: string }} EnergyState
 */

// ── Levels (src/types.ts:37-43, src/levels.ts:36-158) ──

const ENERGY_LEVEL_VALUES = new Set([0, 25, 50, 75, 100])
const ENERGY_SOURCE_VALUES = new Set(['manual', 'scheduled', 'inferred'])

/*
 * Markers for a state nobody has produced: the default a store starts with, as
 * opposed to a level someone chose. Both sort below any real value, so a stored
 * state always replaces it.
 */
const UNPRODUCED_ORIGIN = '0-initial'
const UNPRODUCED_TIMESTAMP = 0

/** True for the untouched default state: its age and identity mean nothing. */
function isUnproducedState(state) {
  return state.timestamp === UNPRODUCED_TIMESTAMP && state.origin === UNPRODUCED_ORIGIN
}

const LEVELS = Object.freeze([
  Object.freeze({
    value: 100,
    key: 'peak',
    label: 'Peak',
    description: 'Full capacity for planning, tough decisions, and deep creative work.',
    cognitiveProfile: Object.freeze({
      decisionCapacity: 'high',
      focusDuration: 'extended',
      taskComplexity: 'complex',
      interruptionTolerance: 'high',
    }),
  }),
  Object.freeze({
    value: 75,
    key: 'active',
    label: 'Active',
    description: 'Good capacity for focused work and problem-solving.',
    cognitiveProfile: Object.freeze({
      decisionCapacity: 'moderate',
      focusDuration: 'moderate',
      taskComplexity: 'moderate',
      interruptionTolerance: 'moderate',
    }),
  }),
  Object.freeze({
    value: 50,
    key: 'steady',
    label: 'Steady',
    description: 'Moderate capacity for steady, familiar, routine work.',
    cognitiveProfile: Object.freeze({
      decisionCapacity: 'low',
      focusDuration: 'short',
      taskComplexity: 'routine',
      interruptionTolerance: 'low',
    }),
  }),
  Object.freeze({
    value: 25,
    key: 'low',
    label: 'Low',
    description: 'Limited capacity for light review and simple steps.',
    cognitiveProfile: Object.freeze({
      decisionCapacity: 'minimal',
      focusDuration: 'minimal',
      taskComplexity: 'simple',
      interruptionTolerance: 'minimal',
    }),
  }),
  Object.freeze({
    value: 0,
    key: 'rest',
    label: 'Rest',
    description: 'Recovery mode for quiet reading and resting — no work expected.',
    cognitiveProfile: Object.freeze({
      decisionCapacity: 'none',
      focusDuration: 'none',
      taskComplexity: 'consumption',
      interruptionTolerance: 'none',
    }),
  }),
])

/** Cycle order: 100 -> 75 -> 50 -> 25 -> 0 -> 100 */
const CYCLE_ORDER = [100, 75, 50, 25, 0]

/** Get the definition for one energy level. */
export function getEnergyLevel(level) {
  const def = LEVELS.find((l) => l.value === level)
  if (!def) throw new Error(`Invalid energy level: ${level}`)
  return def
}

/** The next level in the cycle: 100 -> 75 -> 50 -> 25 -> 0 -> 100 */
export function cycleEnergyLevel(current) {
  const fallback = 100
  const idx = CYCLE_ORDER.indexOf(current)
  if (idx === -1) return fallback
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length] ?? fallback
}

/** True when the value is one of the five levels, as a number. */
export function isEnergyLevel(value) {
  return typeof value === 'number' && ENERGY_LEVEL_VALUES.has(value)
}

function isEnergySource(value) {
  return typeof value === 'string' && ENERGY_SOURCE_VALUES.has(value)
}

// ── State (src/levels.ts:166-265) ──

/**
 * Build a validated, frozen state. Every field is required here: the library's
 * defaults for `revision` and `origin` belong to callers this folder does not
 * have.
 *
 * @returns {EnergyState}
 */
function createEnergyState(level, source, timestamp, revision, origin) {
  if (!isEnergyLevel(level)) {
    throw new Error(`Invalid energy level: ${String(level)}`)
  }

  if (!isEnergySource(source)) {
    throw new Error(`Invalid energy source: ${String(source)}`)
  }

  // Integer, matching energy-system's `spec/energy-state.schema.json`. A
  // fractional timestamp cannot be written in the interchange format.
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`Invalid energy timestamp: ${String(timestamp)}`)
  }

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`Invalid energy revision: ${String(revision)}`)
  }

  if (typeof origin !== 'string' || origin.trim().length === 0) {
    throw new Error(`Invalid energy origin: ${String(origin)}`)
  }

  return Object.freeze({ level, timestamp, source, revision, origin })
}

/** The exact key set `spec/energy-state.schema.json` permits. */
const ENERGY_STATE_KEYS = ['level', 'timestamp', 'source', 'revision', 'origin']

/**
 * Parse a value that came from the state file into a state. The file is shared
 * with other apps, so the published schema is enforced exactly: an object with
 * an unknown key is not a state, and the key is not silently dropped.
 *
 * Throws with a specific reason.
 *
 * @param {unknown} value
 * @returns {EnergyState}
 */
function parseExternalEnergyState(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Energy state must be an object, received: ${String(value)}`)
  }

  const keys = Object.keys(value)
  const unknownKeys = keys.filter((key) => !ENERGY_STATE_KEYS.includes(key))
  if (unknownKeys.length > 0) {
    throw new Error(`Energy state has unknown properties: ${unknownKeys.join(', ')}`)
  }

  const missingKeys = ENERGY_STATE_KEYS.filter((key) => !keys.includes(key))
  if (missingKeys.length > 0) {
    throw new Error(`Energy state is missing properties: ${missingKeys.join(', ')}`)
  }

  if (!isEnergyLevel(value.level)) {
    throw new Error(`Invalid energy level: ${String(value.level)}`)
  }
  if (!isEnergySource(value.source)) {
    throw new Error(`Invalid energy source: ${String(value.source)}`)
  }
  if (typeof value.timestamp !== 'number') {
    throw new TypeError(`Invalid energy timestamp: ${String(value.timestamp)}`)
  }
  if (typeof value.revision !== 'number') {
    throw new TypeError(`Invalid energy revision: ${String(value.revision)}`)
  }
  if (typeof value.origin !== 'string') {
    throw new TypeError(`Invalid energy origin: ${String(value.origin)}`)
  }

  // Integer, range and blank-origin checks belong to the one constructor.
  return createEnergyState(value.level, value.source, value.timestamp, value.revision, value.origin)
}

// ── Reconciliation (src/reconcile.ts:27-83) ──

/**
 * How much authority each source carries when everything else ties: a level set
 * by hand outranks one a schedule applied, which outranks one inferred from
 * behaviour.
 */
function sourcePriority(source) {
  switch (source) {
    case 'manual':
      return 3
    case 'scheduled':
      return 2
    case 'inferred':
      return 1
  }
}

/**
 * Should `candidate` replace `current`? The comparison walks the keys in order
 * and stops at the first that differs: later `timestamp`, higher `revision`,
 * `manual` > `scheduled` > `inferred`, higher `origin` string, higher `level`.
 * Equal on every key means no change.
 *
 * Every app sharing the file computes this the same way, which is what makes
 * them agree on one current state.
 */
function isPreferredEnergyState(candidate, current) {
  if (candidate.timestamp !== current.timestamp) {
    return candidate.timestamp > current.timestamp
  }

  if (candidate.revision !== current.revision) {
    return candidate.revision > current.revision
  }

  if (candidate.source !== current.source) {
    return sourcePriority(candidate.source) > sourcePriority(current.source)
  }

  if (candidate.origin !== current.origin) {
    return candidate.origin > current.origin
  }

  if (candidate.level !== current.level) {
    return candidate.level > current.level
  }

  return false
}

// ── Strategies (src/strategies.ts) ──

// src/strategies.ts:116-173. Only `describe` is used here (the terminal dial).
const NOTIFICATION_CONFIGS = Object.freeze({
  100: Object.freeze({
    allowVisual: true,
    allowSound: true,
    allowVibration: true,
    batchInterval: 0,
    priorityThreshold: 'all',
  }),
  75: Object.freeze({
    allowVisual: true,
    allowSound: true,
    allowVibration: false,
    batchInterval: 0,
    priorityThreshold: 'all',
  }),
  50: Object.freeze({
    allowVisual: true,
    allowSound: false,
    allowVibration: false,
    batchInterval: 5 * 60 * 1000, // 5 minutes
    priorityThreshold: 'high',
  }),
  25: Object.freeze({
    allowVisual: true,
    allowSound: false,
    allowVibration: false,
    batchInterval: 15 * 60 * 1000, // 15 minutes
    priorityThreshold: 'critical',
  }),
  0: Object.freeze({
    allowVisual: false,
    allowSound: false,
    allowVibration: false,
    batchInterval: 0,
    priorityThreshold: 'none',
  }),
})

export const notificationStrategy = {
  describe(level) {
    const def = getEnergyLevel(level)
    const config = NOTIFICATION_CONFIGS[def.value]
    if (config.priorityThreshold === 'none') {
      return `${def.label}: all alerts held quietly until you're ready`
    }
    if (config.priorityThreshold === 'all') {
      return config.allowVibration
        ? `${def.label}: visual, sound, and haptic alerts arrive right away`
        : `${def.label}: visual and sound alerts arrive right away, no haptics`
    }
    const label = config.priorityThreshold === 'critical' ? 'urgent' : 'important'
    return `${def.label}: ${label} alerts only, grouped every ${config.batchInterval / 60_000} minutes`
  },
}

// src/strategies.ts:186-214, 233-235
const TASK_CONFIGS = Object.freeze({
  100: Object.freeze({
    maxComplexity: 'complex',
    suggestBreaks: false,
    breakIntervalMinutes: 0,
  }),
  75: Object.freeze({
    maxComplexity: 'moderate',
    suggestBreaks: false,
    breakIntervalMinutes: 0,
  }),
  50: Object.freeze({
    maxComplexity: 'routine',
    suggestBreaks: true,
    breakIntervalMinutes: 45,
  }),
  25: Object.freeze({
    maxComplexity: 'simple',
    suggestBreaks: true,
    breakIntervalMinutes: 25,
  }),
  // Rest is already a break, so break suggestions are off.
  0: Object.freeze({
    maxComplexity: 'consumption',
    suggestBreaks: false,
    breakIntervalMinutes: 0,
  }),
})

export const taskComplexityStrategy = {
  resolve(level) {
    return TASK_CONFIGS[getEnergyLevel(level).value]
  },
}

/*
 * src/strategies.ts:326-376. How much the system may decide on its own.
 *
 * - confidenceThreshold: minimum confidence (0–1) an automated decision needs
 *   before acting unattended. 1 admits only certainty.
 * - allowGeneratedContent: whether automation may compose new wording, or only
 *   fill fixed templates.
 * - maxUnattendedSteps: how many automated steps may chain before control
 *   returns to the person.
 */
const AUTONOMY_CONFIGS = Object.freeze({
  100: Object.freeze({
    confidenceThreshold: 0.6,
    allowGeneratedContent: true,
    maxUnattendedSteps: 8,
  }),
  75: Object.freeze({
    confidenceThreshold: 0.7,
    allowGeneratedContent: true,
    maxUnattendedSteps: 5,
  }),
  50: Object.freeze({
    confidenceThreshold: 0.8,
    allowGeneratedContent: true,
    maxUnattendedSteps: 3,
  }),
  25: Object.freeze({
    confidenceThreshold: 0.9,
    allowGeneratedContent: false,
    maxUnattendedSteps: 1,
  }),
  // Rest: one certain, templated step at most. Not zero: an automated action
  // the person has standing consent for, such as an out-of-office reply, is
  // safest at rest because it stops improvising.
  0: Object.freeze({
    confidenceThreshold: 1,
    allowGeneratedContent: false,
    maxUnattendedSteps: 1,
  }),
})

export const autonomyStrategy = {
  describe(level) {
    const def = getEnergyLevel(level)
    const config = AUTONOMY_CONFIGS[def.value]
    const content = config.allowGeneratedContent ? 'drafts allowed' : 'fixed templates only'
    const steps =
      config.maxUnattendedSteps === 1
        ? '1 step at a time'
        : `up to ${config.maxUnattendedSteps} chained steps`
    const certainty =
      config.confidenceThreshold === 1
        ? 'certainty only'
        : `${Math.round(config.confidenceThreshold * 100)}% confidence`
    return `${def.label}: automation acts on ${certainty}, ${content}, ${steps}`
  },
  resolve(level) {
    return AUTONOMY_CONFIGS[getEnergyLevel(level).value]
  },
}

// src/strategies.ts:400-436, 452-454
const SENSORY_CONFIGS = Object.freeze({
  100: Object.freeze({
    motionScale: 1,
    allowDecorativeMotion: true,
    allowAmbientAudio: true,
    displayWeightScale: 1,
    allowCallsToAction: true,
  }),
  75: Object.freeze({
    motionScale: 0.75,
    allowDecorativeMotion: true,
    allowAmbientAudio: true,
    displayWeightScale: 0.85,
    allowCallsToAction: true,
  }),
  50: Object.freeze({
    motionScale: 0.5,
    allowDecorativeMotion: false,
    allowAmbientAudio: true,
    displayWeightScale: 0.7,
    allowCallsToAction: true,
  }),
  25: Object.freeze({
    motionScale: 0.25,
    allowDecorativeMotion: false,
    allowAmbientAudio: false,
    displayWeightScale: 0.55,
    allowCallsToAction: false,
  }),
  0: Object.freeze({
    motionScale: 0,
    allowDecorativeMotion: false,
    allowAmbientAudio: false,
    displayWeightScale: 0.45,
    allowCallsToAction: false,
  }),
})

export const sensoryStrategy = {
  resolve(level) {
    return SENSORY_CONFIGS[getEnergyLevel(level).value]
  },
}

/*
 * src/strategies.ts:479-525. How many choices and how much text to present at
 * once. `maxChoices: null` means unbounded.
 */
const CHOICE_BUDGET_CONFIGS = Object.freeze({
  100: Object.freeze({
    maxChoices: null,
    responseDensity: 'detailed',
    allowProactiveSuggestions: true,
  }),
  75: Object.freeze({
    maxChoices: 5,
    responseDensity: 'balanced',
    allowProactiveSuggestions: true,
  }),
  50: Object.freeze({
    maxChoices: 3,
    responseDensity: 'concise',
    allowProactiveSuggestions: false,
  }),
  25: Object.freeze({
    maxChoices: 1,
    responseDensity: 'single-step',
    allowProactiveSuggestions: false,
  }),
  0: Object.freeze({
    maxChoices: 0,
    responseDensity: 'quiet',
    allowProactiveSuggestions: false,
  }),
})

export const choiceBudgetStrategy = {
  describe(level) {
    const def = getEnergyLevel(level)
    const config = CHOICE_BUDGET_CONFIGS[def.value]
    if (config.maxChoices === null) {
      return `${def.label}: full options and detailed responses`
    }
    if (config.maxChoices === 0) {
      return `${def.label}: no decisions asked, quiet reading only`
    }
    const choices =
      config.maxChoices === 1 ? 'one clear next step' : `up to ${config.maxChoices} options`
    return `${def.label}: ${choices}, ${config.responseDensity} responses`
  },
  resolve(level) {
    return CHOICE_BUDGET_CONFIGS[getEnergyLevel(level).value]
  },
}

// ── State file (src/node.ts:34-119, src/runtime.ts:10-12) ──

/** Report a failure that was contained instead of thrown. Goes to stderr. */
function logContainedError(message, err) {
  console.error(`[energy-mcp] ${message}`, err)
}

/**
 * The per-user energy state file:
 * - `$KUMBATIO_ENERGY_FILE` if set
 * - `$XDG_STATE_HOME/kumbatio/energy-state.json` when `XDG_STATE_HOME` is set
 * - `%LOCALAPPDATA%/kumbatio/energy-state.json` on Windows
 * - `~/.config/kumbatio/energy-state.json` otherwise
 */
export function resolveEnergyStatePath(env = process.env, platform = process.platform) {
  const explicit = env['KUMBATIO_ENERGY_FILE']?.trim()
  if (explicit) return explicit

  const xdgState = env['XDG_STATE_HOME']?.trim()
  if (xdgState) {
    return join(xdgState, 'kumbatio', 'energy-state.json')
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim()
    if (localAppData) {
      return join(localAppData, 'kumbatio', 'energy-state.json')
    }
  }

  return join(homedir(), '.config', 'kumbatio', 'energy-state.json')
}

/**
 * Read the state file. A missing or empty file is `null`. A file that is not
 * JSON, or not a valid state, is reported on stderr and treated as `null`, so
 * another app's bad write does not take the server down. Any other read failure
 * is thrown.
 *
 * @returns {Promise<EnergyState | null>}
 */
async function readStateFile(filePath) {
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }

  if (raw.trim().length === 0) return null

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logContainedError(`Discarding unparseable energy state file (${filePath})`, err)
    return null
  }

  try {
    return parseExternalEnergyState(parsed)
  } catch (err) {
    logContainedError(`Discarding malformed energy state file (${filePath})`, err)
    return null
  }
}

/**
 * Write the state file. The JSON goes to a temporary file beside it, which is
 * then renamed into place, so another app reading at the same moment never
 * sees half a file.
 *
 * @param {string} filePath
 * @param {EnergyState} state
 */
async function writeStateFile(filePath, state) {
  const dir = dirname(filePath)
  const tempPath = join(dir, `.${basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`)
  const payload = `${JSON.stringify(state, null, 2)}\n`

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(tempPath, payload, 'utf8')
    await rename(tempPath, filePath)
  } catch (err) {
    try {
      await unlink(tempPath)
    } catch {
      // Nothing to clean up when the temporary file was never created.
    }
    throw new Error(`Failed to save energy state to '${filePath}'`, { cause: err })
  }
}

// ── Store (reduced from src/engine.ts:89-121, 171-177, 373-448) ──

/** A stored state stamped further ahead of the local clock than this is refused. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000

function isSameState(a, b) {
  return (
    a.level === b.level &&
    a.timestamp === b.timestamp &&
    a.source === b.source &&
    a.revision === b.revision &&
    a.origin === b.origin
  )
}

/**
 * The current energy state, backed by the state file.
 *
 * It starts as the unproduced default (level 100, timestamp 0, origin
 * `0-initial`), which is what a reader gets until someone has set a level.
 *
 * @param {{ filePath: string, originId: string }} options `originId` is written
 *   as `origin` on every state this store produces.
 */
export function createEnergyStore({ filePath, originId }) {
  let state = createEnergyState(100, 'manual', UNPRODUCED_TIMESTAMP, 0, UNPRODUCED_ORIGIN)
  let lastWrite = Promise.resolve()

  return {
    /** @returns {EnergyState} */
    getState() {
      return state
    },

    /** Resolve a strategy against the current level. */
    resolve(strategy) {
      return strategy.resolve(state.level)
    },

    /**
     * Read the state file and adopt what it holds when that is newer than the
     * state in memory. A file that cannot be read, or holds a state stamped too
     * far in the future, is reported on stderr and the state in memory stays.
     */
    async hydrate() {
      let stored
      try {
        stored = await readStateFile(filePath)
      } catch (err) {
        logContainedError('Failed to load persisted energy state', err)
        return
      }

      if (!stored) return

      // One bad clock must not win reconciliation until its timestamp passes.
      if (stored.timestamp - Date.now() > MAX_FUTURE_SKEW_MS) {
        logContainedError(
          'Ignoring invalid persisted energy state',
          new Error(
            `Energy state timestamp ${String(stored.timestamp)} exceeds local clock by more than ${String(MAX_FUTURE_SKEW_MS)}ms`,
          ),
        )
        return
      }

      if (isSameState(stored, state)) return

      // The file replaces the untouched default unconditionally, and anything
      // else only when the reconciliation order prefers it.
      if (isUnproducedState(state) || isPreferredEnergyState(stored, state)) {
        state = stored
      }
    },

    /**
     * Set a new level and write it to the state file. Resolves once the file
     * holds it; rejects, leaving the state as it was, when the write fails.
     *
     * Writes run one at a time, so each new state is stamped against the one
     * before it even when two calls arrive together.
     *
     * @param {EnergyLevel} level
     * @param {EnergySource} [source]
     * @returns {Promise<void>}
     */
    setLevel(level, source = 'manual') {
      const write = lastWrite.then(async () => {
        const wallTime = Date.now()
        let timestamp = Math.max(wallTime, state.timestamp)
        let revision = 0

        // Never stamp a state older than the one it replaces. When the clock
        // has not moved past the current state, the revision orders the two.
        if (timestamp === state.timestamp) {
          if (state.revision === Number.MAX_SAFE_INTEGER) {
            timestamp += 1
          } else {
            revision = state.revision + 1
          }
        }

        const next = createEnergyState(level, source, timestamp, revision, originId)
        await writeStateFile(filePath, next)
        state = next
      })
      // The chain continues after a failed write; the caller still gets the rejection.
      lastWrite = write.catch(() => {})
      return write
    },
  }
}
