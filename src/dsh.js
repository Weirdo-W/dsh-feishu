'use strict'
/**
 * DSH SDK JSON-RPC 客户端（stdio，按换行分帧）。
 *
 * 协议见 @deepseek-ai/dsh-sdk-protocol：
 *   客户端→服务端：initialize / session/prompt / session/query / session/resume /
 *                   session/wait / session/working-directory/{get,set} / shutdown
 *   服务端→客户端（需 initialize 时声明）：approval/request、user-question/ask
 *   服务端通知：session.event、session.status、session.query.completed、subagent.*
 */
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const { EventEmitter } = require('node:events')

class DshClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.runtimeExe
   * @param {string} opts.dshBin
   * @param {boolean} opts.useNode
   * @param {string} opts.profile
   * @param {string} opts.dshHome
   * @param {string} opts.cwd
   * @param {(level:string,msg:string)=>void} [opts.log]
   */
  constructor (opts) {
    super()
    this.opts = opts
    this.log = opts.log || ((lv, m) => console.log(`[dsh:${lv}] ${m}`))
    this.nextId = 1
    this.pending = new Map()
    this.child = null
    this.stopped = false
    this.stderrTail = []
  }

  start () {
    const { runtimeExe, dshBin, useNode, profile, dshHome, cwd } = this.opts
    const env = Object.assign({}, process.env)
    if (useNode) {
      env.ELECTRON_RUN_AS_NODE = '1'
    }
    env.DSH_HOME = dshHome

    const args = [dshBin, '--profile', profile]
    this.log('info', `启动 DSH: ${runtimeExe} ${args.join(' ')}`)
    if (this.opts.childFactory) {
      // 仅测试用：注入一个进程内假子进程（stdin/stdout/stderr 为流）
      this.child = this.opts.childFactory()
    } else {
      this.child = spawn(runtimeExe, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    }

    this.child.on('error', (err) => {
      this.emit('fatal', new Error(`启动 DSH 失败: ${err.message}`))
    })
    this.child.on('exit', (code, signal) => {
      const tail = this.stderrTail.slice(-20).join('\n')
      this.emit('exit', { code, signal, stderr: tail })
    })

    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this._onLine(line)
    })
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.stderrTail.push(line)
      if (this.stderrTail.length > 200) this.stderrTail.shift()
      this.log('dsh', line)
    })
    return this
  }

  _onLine (line) {
    const text = line.trim()
    if (!text) return
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      // stdout 只应有 JSON；出现杂讯就记下来，不中断
      this.log('warn', '无法解析的 stdout 行: ' + text.slice(0, 300))
      return
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id')
    const hasMethod = typeof msg.method === 'string'

    if (hasMethod && hasId) {
      // 服务端→客户端的请求
      this._handleServerRequest(msg)
    } else if (hasMethod) {
      // 通知
      this.emit('notification', msg.method, msg.params)
    } else if (hasId) {
      // 响应
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) {
        const err = new Error(msg.error.message || 'JSON-RPC error')
        err.code = msg.error.code
        err.data = msg.error.data
        p.reject(err)
      } else {
        p.resolve(msg.result)
      }
    }
  }

  async _handleServerRequest (msg) {
    const reply = (result) => this._write({ jsonrpc: '2.0', id: msg.id, result })
    const replyError = (code, message) => this._write({ jsonrpc: '2.0', id: msg.id, error: { code, message } })

    try {
      if (msg.method === 'approval/request') {
        const outcome = await this._ask('approval', msg.params, reply)
        reply({ outcome })
        return
      }
      if (msg.method === 'user-question/ask') {
        const result = await this._ask('question', msg.params, reply)
        reply(result)
        return
      }
      replyError(-32601, `未实现的服务端请求: ${msg.method}`)
    } catch (err) {
      this.log('error', `处理 ${msg.method} 失败: ${err.stack || err}`)
      replyError(-32603, String(err && err.message ? err.message : err))
    }
  }

  /** 让上层处理并把结果交回。上层可能耗时很久（等用户点按钮），所以用 Promise。 */
  _ask (kind, params, reply) {
    return new Promise((resolve) => {
      this.emit('server-request', { kind, params, resolve, rawReply: reply })
    })
  }

  _write (obj) {
    if (!this.child || !this.child.stdin.writable) return
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  request (method, params, timeoutMs) {
    const id = this.nextId++
    const timeout = timeoutMs || this.opts.requestTimeoutMs || 300000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`请求超时: ${method}`))
      }, timeout)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this._write({ jsonrpc: '2.0', id, method, params })
    })
  }

  initialize (params) { return this.request('initialize', params, 120000) }
  prompt (sessionId, text) {
    return this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }]
    })
  }
  query (sessionId, text) {
    return this.request('session/query', {
      sessionId,
      contentBlocks: [{ type: 'text', text }]
    })
  }
  resume (sessionId) { return this.request('session/resume', { sessionId }, 120000) }
  setWorkingDirectory (sessionId, p) {
    return this.request('session/working-directory/set', { sessionId, path: p })
  }

  async shutdown () {
    this.stopped = true
    try { await this.request('shutdown', undefined, 15000) } catch {}
    try { this.child && this.child.kill() } catch {}
  }
}

module.exports = { DshClient }
