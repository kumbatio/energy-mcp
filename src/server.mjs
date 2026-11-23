#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

import {
  autonomyStrategy,
  choiceBudgetStrategy,
  createEnergyStore,
  getEnergyLevel,
  isEnergyLevel,
  resolveEnergyStatePath,
  sensoryStrategy,
  taskComplexityStrategy,
} from './energy-levels.mjs'

/*
 * @kumbatio/energy-mcp — Local MCP server (stdio JSON-RPC 2.0)
 *
 * Reads and writes the user's shared local energy state file
 * (`~/.config/kumbatio/energy-state.json` by default) so AI assistants and
 * coding agents can adapt their depth, option count, and unattended autonomy
 * to the person's current cognitive capacity.
 *
 * Zero telemetry. Zero cloud calls. Self-report only.
 */

const SERVER_INFO = {
  name: '@kumbatio/energy-mcp',
  version: '0.1.0',
}

/** Newest first: a client that asks for anything else is answered with the first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export function buildGuidancePayload(engine) {
  const state = engine.getState()
  const definition = getEnergyLevel(state.level)
  const autonomy = engine.resolve(autonomyStrategy)
  const choiceBudget = engine.resolve(choiceBudgetStrategy)
  const tasks = engine.resolve(taskComplexityStrategy)
  const sensory = engine.resolve(sensoryStrategy)

  const instructions = {
    100: 'The person is at Peak (100%). Full depth, architectural trade-offs, and nuanced exploration are welcome.',
    75: 'The person is Active (75%). Stay focused and structured; keep options to 5 or fewer and move directly toward the goal.',
    50: 'The person is Steady (50%). Keep responses concise, suggest familiar steps, limit options to 3, and skip unsolicited ideas.',
    25: 'The person is at Low energy (25%). Keep copy short and calm. Offer ONE concrete next step instead of a menu of choices. Avoid unsolicited suggestions, use fixed templates for external messages, and ask before chaining actions.',
    0: 'The person is in Rest (0%). Do not assign work, push decisions, or add calls to action. Summarize gently if asked, capture notes quietly, and act only on explicit, certain instructions.',
  }[state.level]

  return {
    state,
    level: definition,
    autonomy,
    choiceBudget,
    taskComplexity: tasks,
    sensory,
    guidance: instructions,
  }
}

export function createEnergyMcpHandler(options = {}) {
  const filePath = options.filePath ?? resolveEnergyStatePath()
  const engine = createEnergyStore({
    filePath,
    originId: options.originId ?? 'kumbatio-energy-mcp',
  })

  const resources = [
    {
      uri: 'energy://state',
      name: 'Current Energy State',
      title: 'Energy state',
      description: 'The person’s current self-declared cognitive energy state.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://autonomy',
      name: 'Automation Autonomy Limits',
      title: 'Autonomy limits',
      description: 'Confidence floor, draft-composition permission, and unattended step cap.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://choice-budget',
      name: 'Choice & Density Budget',
      title: 'Choice budget',
      description: 'How many options and how much detail to present right now.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://guidance',
      name: 'Assistant Adaptation Guidance',
      title: 'Guidance',
      description: 'Plain-English instructions for adapting tone, pacing, and autonomy to the person right now.',
      mimeType: 'text/plain',
    },
  ]

  /*
   * A description says what the tool does and what it returns. When to call a
   * tool, and what to do with its answer, is in the plugin's skills (skills/).
   *
   * Every tool touches one local file and nothing else, hence
   * `openWorldHint: false`.
   */
  const tools = [
    {
      name: 'get_energy_guidance',
      title: 'Read energy guidance',
      description:
        'Returns the energy level the person last declared (0 Rest, 25 Low, 50 Steady, 75 Active, 100 Peak) and what it means, as JSON: the stored state (level, timestamp in epoch milliseconds, source, revision, origin), the level’s label and cognitive profile, the autonomy limits, choice budget, task complexity and sensory settings for that level, and plain-language guidance for it. When no level has been stored, the state is the default: level 100 with timestamp 0 and origin "0-initial". Reads one local file and changes nothing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'check_autonomy_action',
      title: 'Check an unattended action',
      description:
        'Compares a planned unattended action with the autonomy limits of the person’s current energy level. Returns JSON: `allowed` (true when no limit is exceeded), the current `level`, the `autonomy` limits (confidenceThreshold, allowGeneratedContent, maxUnattendedSteps) and `reasons`, one sentence for each limit the action exceeds. Reads one local file and changes nothing.',
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Estimated confidence (0–1) that this action matches the person’s intent.',
          },
          requiresGeneratedContent: {
            type: 'boolean',
            description:
              'True if the action sends or publishes newly composed wording rather than a fixed template. Defaults to false.',
          },
          plannedSteps: {
            type: 'integer',
            minimum: 1,
            description:
              'How many unattended steps the action will chain before returning control. Defaults to 1.',
          },
        },
        required: ['confidence'],
        additionalProperties: false,
      },
    },
    {
      name: 'set_energy_level',
      title: 'Set energy level',
      description:
        'Stores a new energy level in the person’s local energy state file, replacing the level stored before, and records it as declared by the person (source "manual"). Other apps that read the same file see the new level. Returns one line confirming the level, followed by the plain-language guidance for it.',
      /*
       * It writes, so it is not read-only. It is not destructive: it replaces
       * one stored value with another, the person can set the earlier level
       * again, and nothing else is removed. Repeating a call with the same
       * level leaves that level stored (only the timestamp moves), so it is
       * idempotent.
       */
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: 'object',
        properties: {
          level: {
            type: 'integer',
            enum: [0, 25, 50, 75, 100],
            description: 'One of the five discrete levels: 100 (Peak), 75 (Active), 50 (Steady), 25 (Low), 0 (Rest).',
          },
        },
        required: ['level'],
        additionalProperties: false,
      },
    },
  ]

  async function handleRequest(request) {
    const { id, method, params = {} } = request

    if (method === 'notifications/initialized') {
      return null
    }

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: {
            resources: { subscribe: false, listChanged: false },
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
        },
      }
    }

    if (method === 'resources/list') {
      return { jsonrpc: '2.0', id, result: { resources } }
    }

    if (method === 'resources/read') {
      await engine.hydrate()
      const payload = buildGuidancePayload(engine)
      const uri = params.uri

      if (uri === 'energy://state') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload.state, null, 2) }],
          },
        }
      }
      if (uri === 'energy://autonomy') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload.autonomy, null, 2) }],
          },
        }
      }
      if (uri === 'energy://choice-budget') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload.choiceBudget, null, 2) }],
          },
        }
      }
      if (uri === 'energy://guidance') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [{ uri, mimeType: 'text/plain', text: payload.guidance }],
          },
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Unknown resource URI: ${String(uri)}` },
      }
    }

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } }
    }

    if (method === 'tools/call') {
      await engine.hydrate()
      const toolName = params.name
      const args = params.arguments ?? {}

      if (toolName === 'get_energy_guidance') {
        const payload = buildGuidancePayload(engine)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          },
        }
      }

      if (toolName === 'check_autonomy_action') {
        const autonomy = engine.resolve(autonomyStrategy)
        const confidence = Number(args.confidence)
        const requiresGenerated = Boolean(args.requiresGeneratedContent)
        const plannedSteps = Number(args.plannedSteps ?? 1)
        const reasons = []

        if (!Number.isFinite(confidence) || confidence < autonomy.confidenceThreshold) {
          reasons.push(
            `Confidence ${String(confidence)} is below the current threshold (${String(autonomy.confidenceThreshold)}).`,
          )
        }
        if (requiresGenerated && !autonomy.allowGeneratedContent) {
          reasons.push('At this energy level, unattended actions may only use fixed templates.')
        }
        if (plannedSteps > autonomy.maxUnattendedSteps) {
          reasons.push(
            `${String(plannedSteps)} steps exceeds the current unattended limit (${String(autonomy.maxUnattendedSteps)}).`,
          )
        }

        const decision = {
          allowed: reasons.length === 0,
          level: engine.getState().level,
          autonomy,
          reasons,
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(decision, null, 2) }],
          },
        }
      }

      if (toolName === 'set_energy_level') {
        const nextLevel = Number(args.level)
        if (!isEnergyLevel(nextLevel)) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Level must be one of 0, 25, 50, 75, or 100.' }],
            },
          }
        }
        try {
          await engine.setLevel(nextLevel, 'manual')
        } catch (err) {
          const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `The energy level was not changed: could not write ${filePath}${cause}.`,
                },
              ],
            },
          }
        }
        const payload = buildGuidancePayload(engine)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Energy updated to ${String(nextLevel)}% (${payload.level.label}). ${payload.guidance}`,
              },
            ],
          },
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown tool: ${String(toolName)}` },
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${String(method)}` },
    }
  }

  return {
    engine,
    filePath,
    handleRequest,
  }
}

export function startStdioServer(options = {}) {
  const handler = createEnergyMcpHandler(options)
  const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    void (async () => {
      try {
        const request = JSON.parse(trimmed)
        const response = await handler.handleRequest(request)
        if (response) {
          process.stdout.write(`${JSON.stringify(response)}\n`)
        }
      } catch (err) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' },
          })}\n`,
        )
      }
    })()
  })

  return handler
}

/*
 * Start only when this file is the one `node` was asked to run (the terminal
 * dial imports it too). The comparison goes through the real path and a file
 * URL, because Node resolves links for the entry file and encodes its URL: a
 * folder reached through a symbolic link, or one with a space in its name,
 * never equals a URL built from the raw argument.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  startStdioServer()
}
