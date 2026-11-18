'use strict'
/**
 * 自测：用进程内假服务端验证 DshClient 的请求/通知/审批往返。
 * 用 PassThrough 模拟子进程管道，避免依赖真实 DSH 或 spawn。
 */
const path = require('node:path')
const readline = require('node:readline')
const { PassThrough } = require('node:stream')
const { DshClient } = require('../src/dsh')

function makeMock (toClient, fromClient) {
  const send = (obj) => toClient.write(JSON.stringify(obj) + '\n')
  let approvalId = 9001
  readline.createInterface({ input: fromClient }).on('line', (line) => {
    const t = line.trim(); if (!t) return
    let msg; try { msg = JSON.parse(t) } catch { return }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')
    const hasMethod = typeof msg.method === 'string'
    if (hasMethod && hasId) {
      if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'mock', version: '0.0.1' } } })
      if (msg.method === 'session/resume') return send({ jsonrpc: '2.0', id: msg.id, result: {} })
      if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return }
      if (msg.method === 'session/query' || msg.method === 'session/prompt') {
        const sessionId = msg.params.sessionId
        send({ jsonrpc: '2.0', id: msg.id, result: { kind: 'prompt', messageId: 'm-1' } })
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
          send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '模拟回复' }] } } } } })
          send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', data: { name: 'bash', arguments: '{}' } } } })
          send({ jsonrpc: '2.0', id: approvalId++, method: 'approval/request', params: { sessionId, toolName: 'bash', reason: '模拟审批' } })
        }, 50)
        return
      }
      return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } })
    }
    if (!hasMethod && hasId) {
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: 's1', event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } })
    }
  })
}

async function main () {
  const toClient = new PassThrough()
  const fromClient = new PassThrough()
  makeMock(toClient, fromClient)

  const log = (lv, m) => { if (lv === 'error' || lv === 'warn') console.error(`[${lv}] ${m}`) }
  const dsh = new DshClient({
    runtimeExe: process.execPath,
    dshBin: 'mock',
    useNode: false,
    profile: 'sdk',
    dshHome: path.join(__dirname, '..', '.testhome'),
    cwd: __dirname,
    requestTimeoutMs: 15000,
    log,
    childFactory: () => ({
      stdin: fromClient,
      stdout: toClient,
      stderr: new PassThrough(),
      on () {},
      kill () {}
    })
  })

  const got = { text: [], tool: null, turnEnd: false, approval: null }
  dsh.on('notification', (method, params) => {
    if (method !== 'session.event') return
    const e = params.event; const d = e.data || {}
    if (e.type === 'assistant/message') got.text.push(d.message.content.map(b => b.text).join(''))
    if (e.type === 'tool/call') got.tool = d.name
    if (e.type === 'turn/end') got.turnEnd = true
  })
  dsh.on('server-request', (req) => {
    if (req.kind === 'approval') {
      got.approval = { tool: req.params.toolName, reason: req.params.reason }
      req.resolve('allowed-once')
    }
  })

  dsh.start()
  const init = await dsh.initialize({ cwd: __dirname, approvalRequests: true, provider: 'x', model: 'y' })
  if (!init || !init.serverInfo) throw new Error('initialize 无结果')
  await dsh.query('s1', '你好')

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (got.text.length && got.tool && got.approval && got.turnEnd) break
    await new Promise(r => setTimeout(r, 50))
  }

  console.log(JSON.stringify(got, null, 2))
  const ok = got.text.length > 0 && got.tool === 'bash' && got.approval && got.approval.tool === 'bash' && got.turnEnd
  if (!ok) { console.error('SELFTEST FAIL'); process.exit(1) }
  console.log('SELFTEST PASS')
}
main().catch((e) => { console.error(e); process.exit(1) })

