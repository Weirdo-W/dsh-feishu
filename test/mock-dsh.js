'use strict'
/**
 * 假的 DSH JSON-RPC 服务端，仅用于本地自测桥的传输/通知/审批流程（不连模型）。
 */
const readline = require('node:readline')

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let approvalId = 9001

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try { msg = JSON.parse(t) } catch { return }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')
  const hasMethod = typeof msg.method === 'string'

  if (hasMethod && hasId) {
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })
      return
    }
    if (msg.method === 'session/query' || msg.method === 'session/prompt') {
      const sessionId = msg.params.sessionId
      send({ jsonrpc: '2.0', id: msg.id, result: { kind: 'prompt', messageId: 'm-1' } })
      setTimeout(() => {
        send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
        send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是模拟的助手回复' }] } } } } })
        send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', data: { name: 'bash', arguments: '{}' } } } })
        const id = approvalId++
        send({ jsonrpc: '2.0', id, method: 'approval/request', params: { sessionId, toolName: 'bash', reason: '模拟审批' } })
      }, 100)
      return
    }
    if (msg.method === 'session/resume') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return }
    if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); setTimeout(() => process.exit(0), 50); return }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown' } })
    return
  }

  if (!hasMethod && hasId) {
    // 客户端对我们 approval/request 的响应
    const sessionId = 'x'
    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } })
  }
})

