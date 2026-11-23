import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/*
 * These tests start the server the way an MCP host does: `node <server file>`,
 * one JSON-RPC message per line on stdin, replies on stdout. The state file is
 * always a temporary one named by KUMBATIO_ENERGY_FILE, so the person's own
 * file is never read or written.
 */

const SERVER = fileURLToPath(new URL('../src/server.mjs', import.meta.url))

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kumbatio-stdio-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Start the server on a temporary state file and return `request(method, params)`,
 * which resolves with the reply that carries the same id.
 */
function startServer(t, { serverPath = SERVER, stateFile } = {}) {
  const filePath = stateFile ?? join(tempDir(t), 'energy-state.json')
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, KUMBATIO_ENERGY_FILE: filePath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => child.kill())

  // Kept for the failure message; the server reports contained errors there.
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let end = buffer.indexOf('\n')
    while (end !== -1) {
      const message = JSON.parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      end = buffer.indexOf('\n')
    }
  })

  let nextId = 0
  function request(method, params) {
    nextId += 1
    const id = nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No reply to ${method} within 5 seconds. stderr: ${stderr || '(empty)'}`))
      }, 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return { filePath, request }
}

void test('set_energy_level reports a state file it cannot write and leaves the level alone', async (t) => {
  const dir = tempDir(t)
  // The state file's folder is a regular file, so no write can succeed.
  writeFileSync(join(dir, 'blocker'), 'x')
  const stateFile = join(dir, 'blocker', 'energy-state.json')
  const server = startServer(t, { stateFile })

  const set = await server.request('tools/call', {
    name: 'set_energy_level',
    arguments: { level: 25 },
  })
  assert.equal(set.result.isError, true)
  assert.match(set.result.content[0].text, /^The energy level was not changed: could not write /)
  assert.ok(set.result.content[0].text.includes(stateFile))

  const state = await server.request('resources/read', { uri: 'energy://state' })
  assert.equal(JSON.parse(state.result.contents[0].text).origin, '0-initial')
})
