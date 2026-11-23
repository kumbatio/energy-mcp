#!/usr/bin/env node
import { createInterface } from 'node:readline'

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

const PROTOCOL_VERSION = '2024-11-05'

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
      description: 'The person’s current self-declared cognitive energy state.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://autonomy',
      name: 'Automation Autonomy Limits',
      description: 'Confidence floor, draft-composition permission, and unattended step cap.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://choice-budget',
      name: 'Choice & Density Budget',
      description: 'How many options and how much detail to present right now.',
      mimeType: 'application/json',
    },
    {
      uri: 'energy://guidance',
      name: 'Assistant Adaptation Guidance',
      description: 'Plain-English instructions for adapting tone, pacing, and autonomy to the person right now.',
      mimeType: 'text/plain',
    },
  ]

  const tools = [
    {
      name: 'get_energy_guidance',
      description:
        'Read the person’s current self-declared cognitive capacity (0, 25, 50, 75, or 100) along with choice budget, autonomy limits, and plain-language guidance on how to adapt your response.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'check_autonomy_action',
      description:
        'Check whether a planned unattended automated action is permitted under the person’s current energy level and autonomyStrategy.',
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
            description: 'True if the action sends or publishes newly composed wording rather than a fixed template.',
          },
          plannedSteps: {
            type: 'integer',
            minimum: 1,
            description: 'How many unattended steps the action will chain before returning control.',
          },
        },
        required: ['confidence'],
        additionalProperties: false,
      },
    },
    {
      name: 'set_energy_level',
      description:
        'Update the person’s shared local energy state. ONLY call this when the person explicitly tells you their energy level (never infer or guess it silently).',
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
          protocolVersion: PROTOCOL_VERSION,
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

if (import.meta.url === `file://${process.argv[1]}`) {
  startStdioServer()
}
