import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createEnergyMcpHandler } from '../src/server.mjs'

void test('MCP server initializes, reads guidance, checks autonomy, and updates shared local state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kumbatio-mcp-'))
  const filePath = join(dir, 'energy-state.json')
  const server = createEnergyMcpHandler({ filePath, originId: 'mcp-test' })

  try {
    const init = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    assert.equal(init.result.serverInfo.name, '@kumbatio/energy-mcp')

    const setRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'set_energy_level', arguments: { level: 25 } },
    })
    assert.match(setRes.result.content[0].text, /25% \(Low\)/)
    assert.match(setRes.result.content[0].text, /ONE concrete next step/)

    const checkDenied = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'check_autonomy_action',
        arguments: { confidence: 0.8, requiresGeneratedContent: true, plannedSteps: 3 },
      },
    })
    const deniedPayload = JSON.parse(checkDenied.result.content[0].text)
    assert.equal(deniedPayload.allowed, false)
    assert.equal(deniedPayload.reasons.length, 3)

    const checkAllowed = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'check_autonomy_action',
        arguments: { confidence: 0.95, requiresGeneratedContent: false, plannedSteps: 1 },
      },
    })
    assert.equal(JSON.parse(checkAllowed.result.content[0].text).allowed, true)

    const guidanceRes = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/read',
      params: { uri: 'energy://guidance' },
    })
    assert.match(guidanceRes.result.contents[0].text, /Low energy \(25%\)/)
  } finally {
    server.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
