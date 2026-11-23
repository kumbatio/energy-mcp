import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

void test('the server starts from a copy of src/ alone, in a folder with a space in its name', async (t) => {
  // A plugin is installed wherever the host keeps plugins, so the server must
  // not depend on its own path or on anything outside its folder.
  const copy = join(tempDir(t), 'plugin cache', 'src')
  cpSync(dirname(SERVER), copy, { recursive: true })
  const server = startServer(t, { serverPath: join(copy, 'server.mjs') })

  const init = await server.request('initialize', { protocolVersion: '2024-11-05' })
  assert.equal(init.result.serverInfo.name, '@kumbatio/energy-mcp')
})

void test('the server starts through a symbolic link to its folder', async (t) => {
  const link = join(tempDir(t), 'linked')
  symlinkSync(dirname(SERVER), link, 'dir')
  const server = startServer(t, { serverPath: join(link, 'server.mjs') })

  const init = await server.request('initialize', { protocolVersion: '2024-11-05' })
  assert.equal(init.result.serverInfo.name, '@kumbatio/energy-mcp')
})

void test('initialize answers with the requested protocol version when the server supports it', async (t) => {
  const server = startServer(t)
  const supported = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
  for (const protocolVersion of supported) {
    const init = await server.request('initialize', { protocolVersion })
    assert.equal(init.result.protocolVersion, protocolVersion)
  }
  // Anything else gets the newest version the server supports.
  for (const protocolVersion of ['2024-10-07', '2099-01-01', 'latest', undefined, 20251125]) {
    const init = await server.request('initialize', { protocolVersion })
    assert.equal(init.result.protocolVersion, '2025-11-25', `requested ${String(protocolVersion)}`)
  }
})

void test('tools/list gives every tool a title and annotations', async (t) => {
  const server = startServer(t)
  const { tools } = (await server.request('tools/list')).result
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['get_energy_guidance', 'check_autonomy_action', 'set_energy_level'],
  )

  for (const tool of tools) {
    assert.ok(tool.name.length <= 64, `${tool.name} is longer than 64 characters`)
    assert.equal(typeof tool.title, 'string', `${tool.name} has no title`)
    assert.ok(tool.title.trim().length > 0, `${tool.name} has an empty title`)
    assert.equal(typeof tool.annotations, 'object', `${tool.name} has no annotations`)
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `${tool.name} has no readOnlyHint`)
    // Descriptions say what a tool does and returns; directions belong in the skills.
    assert.doesNotMatch(tool.description, /\b(only call|never|always|must|should|your)\b/i, tool.name)
  }

  const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]))
  assert.equal(annotations.get_energy_guidance.readOnlyHint, true)
  assert.equal(annotations.check_autonomy_action.readOnlyHint, true)
  assert.deepEqual(annotations.set_energy_level, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  })
})

void test('resources/list gives every resource a title', async (t) => {
  const server = startServer(t)
  const { resources } = (await server.request('resources/list')).result
  assert.equal(resources.length, 4)
  for (const resource of resources) {
    assert.equal(typeof resource.title, 'string', `${resource.uri} has no title`)
    assert.ok(resource.title.trim().length > 0, `${resource.uri} has an empty title`)
  }
})

void test('check_autonomy_action refuses bad input with a message that names the field', async (t) => {
  const server = startServer(t)
  const check = (args) => server.request('tools/call', { name: 'check_autonomy_action', arguments: args })

  const bad = [
    // [arguments, what the message must mention]
    [{}, /confidence is required/],
    [{ plannedSteps: 2 }, /confidence is required/],
    [{ confidence: '0.9' }, /confidence .*number from 0 to 1 \(received "0.9"\)/],
    [{ confidence: null }, /confidence .*\(received null\)/],
    [{ confidence: 1.5 }, /confidence .*\(received 1.5\)/],
    [{ confidence: -0.1 }, /confidence .*\(received -0.1\)/],
    [{ confidence: 0.9, plannedSteps: 0 }, /plannedSteps .*whole number of 1 or more \(received 0\)/],
    [{ confidence: 0.9, plannedSteps: 2.5 }, /plannedSteps .*\(received 2.5\)/],
    [{ confidence: 0.9, plannedSteps: '3' }, /plannedSteps .*\(received "3"\)/],
    [{ confidence: 0.9, requiresGeneratedContent: 'yes' }, /requiresGeneratedContent .*true or false \(received "yes"\)/],
    [{ confidence: 0.9, steps: 3 }, /unknown argument: steps/],
    ['high', /arguments must be an object/],
    [[0.9], /arguments must be an object/],
  ]
  for (const [args, expected] of bad) {
    const reply = await check(args)
    assert.equal(reply.result?.isError, true, `accepted ${JSON.stringify(args)}`)
    assert.match(reply.result.content[0].text, /^Invalid arguments for check_autonomy_action: /)
    assert.match(reply.result.content[0].text, expected)
  }

  // Every problem is reported at once.
  const both = await check({ confidence: 2, plannedSteps: 0 })
  assert.match(both.result.content[0].text, /confidence .*plannedSteps /)

  // Valid input is still answered, with the documented defaults.
  const ok = await check({ confidence: 0.6 })
  assert.equal(ok.result.isError, undefined)
  assert.equal(JSON.parse(ok.result.content[0].text).allowed, true)
})

void test('set_energy_level accepts only one of the five levels, as a number', async (t) => {
  const server = startServer(t)
  for (const level of [null, '25', '', true, 30, 25.5, undefined]) {
    const reply = await server.request('tools/call', { name: 'set_energy_level', arguments: { level } })
    assert.equal(reply.result?.isError, true, `accepted ${JSON.stringify(level)}`)
    assert.match(reply.result.content[0].text, /^Level must be one of the numbers 0, 25, 50, 75, or 100/)
  }
  assert.equal(existsSync(server.filePath), false, 'nothing was written')

  const reply = await server.request('tools/call', { name: 'set_energy_level', arguments: { level: 0 } })
  assert.match(reply.result.content[0].text, /^Energy updated to 0% \(Rest\)/)
})

void test('the plugin starts the server with the command in .mcp.json, at one version everywhere', async (t) => {
  const root = dirname(dirname(SERVER))
  const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'))

  // The host replaces ${CLAUDE_PLUGIN_ROOT} with the folder the plugin is installed in.
  const entry = readJson('.mcp.json').mcpServers['kumbatio-energy']
  assert.equal(entry.command, 'node')
  assert.deepEqual(entry.args, ['${CLAUDE_PLUGIN_ROOT}/src/server.mjs'])
  const [serverPath] = entry.args.map((arg) => arg.replace('${CLAUDE_PLUGIN_ROOT}', root))
  const server = startServer(t, { serverPath })

  const init = await server.request('initialize', { protocolVersion: '2025-11-25' })
  const { version } = init.result.serverInfo
  assert.equal(version, readJson('package.json').version)
  assert.equal(version, readJson('.claude-plugin/plugin.json').version)
})
