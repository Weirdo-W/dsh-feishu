'use strict'
/**
 * 飞书 ⇄ DSH 桥主程序。
 *
 *  飞书长连接(WebSocket) ──► 收到消息 ──► DSH SDK 会话(session/query)
 *  飞书 ◄── 助手输出/工具动作/审批卡片 ◄── DSH 的 session.event / approval/request
 *
 * 用法：node src/index.js
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { loadConfig } = require('./config')
const { DshClient } = require('./dsh')
const { approvalCard, approvalDecidedCard, questionCard } = require('./cards')

let lark
try {
  lark = require('@larksuiteoapi/node-sdk')
} catch (e) {
  console.error('缺少依赖 @larksuiteoapi/node-sdk，请先在 dsh-feishu 目录执行: npm install --ignore-scripts')
  throw e
}

// ── 配置与日志 ───────────────────────────────────────────────────────────
const { cfg, file: configFile, root } = loadConfig()
fs.mkdirSync(cfg.bridge.logDir, { recursive: true })
const logFile = path.join(cfg.bridge.logDir, 'bridge.log')

function log (level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  const out = level === 'error' || level === 'warn' ? console.error : console.log
  out(line)
  try { fs.appendFileSync(logFile, line + '\n') } catch {}
}

// ── 状态：chatId ⇄ sessionId ─────────────────────────────────────────────
const state = { chats: {} }
try {
  if (fs.existsSync(cfg.bridge.stateFile)) {
    Object.assign(state, JSON.parse(fs.readFileSync(cfg.bridge.stateFile, 'utf8')))
  }
} catch (e) { log('warn', '读取 state.json 失败，使用空状态: ' + e.message) }

function saveState () {
  try { fs.writeFileSync(cfg.bridge.stateFile, JSON.stringify(state, null, 2)) } catch (e) {
    log('warn', '保存 state.json 失败: ' + e.message)
  }
}

function sessionFor (chatId) {
  const rec = state.chats[chatId]
  if (cfg.bridge.persistSessions && rec && rec.sessionId) return rec.sessionId
  const sessionId = 'fs-' + chatId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) + '-' + Date.now().toString(36)
  state.chats[chatId] = { sessionId, createdAt: new Date().toISOString() }
  saveState()
  return sessionId
}

const sessionToChat = new Map()

// ── DSH 客户端 ───────────────────────────────────────────────────────────
const resumed = new Set()
const pendingApprovals = new Map() // approvalId -> {resolve, chatId, toolName, cardMessageId, timer}
const pendingQuestions = new Map() // requestId -> {resolve, chatId, questions, answers}

let dsh = null

function createDsh () {
  const mock = !!cfg.dsh.mockMode
  const c = new DshClient({
    runtimeExe: mock ? process.execPath : cfg.dsh.runtimeExe,
    dshBin: mock ? path.join(__dirname, '..', 'test', 'mock-dsh.js') : cfg.dsh.dshBin,
    useNode: mock ? false : cfg.dsh.useNode,
    profile: cfg.dsh.profile,
    dshHome: cfg.dsh.dshHome,
    cwd: cfg.dsh.cwd,
    requestTimeoutMs: cfg.dsh.requestTimeoutMs,
    log
  })
  c.on('fatal', (err) => { log('error', err.stack || String(err)); process.exit(1) })
  c.on('exit', ({ code, signal, stderr }) => {
    if (c !== dsh) return
    log('error', `DSH 进程退出 code=${code} signal=${signal}\n${stderr || ''}`)
    process.exit(1)
  })
  c.on('notification', (method, params) => {
    try {
      if (method === 'session.event') handleSessionEvent(params)
      else if (method === 'session.status') handleStatus(params)
    } catch (e) {
      log('error', `处理通知 ${method} 异常: ${e.stack || e}`)
    }
  })
  c.on('server-request', (req) => {
    if (req.kind === 'approval') handleApprovalRequest(req)
    else if (req.kind === 'question') handleQuestionRequest(req)
    else req.resolve(undefined)
  })
  return c
}

async function handleSessionEvent (params) {
  const { sessionId, event } = params || {}
  if (!sessionId || !event) return
  // DSH 的 SessionEvent 是 { type, seq, time, data: {...} }，字段都在 data 里
  const data = event.data || {}
  if (event.type !== 'assistant/attempt') log('info', `[事件] ${event.type} (${String(sessionId).slice(-8)})`)
  const chatId = sessionToChat.get(sessionId)
  if (!chatId) return

  switch (event.type) {
    case 'assistant/message': {
      const text = extractText(data.message && data.message.content)
      if (text) await sendText(chatId, text)
      break
    }
    case 'tool/call': {
      if (cfg.bridge.showToolCalls) {
        await sendText(chatId, `🔧 调用工具：${data.name}`)
      }
      break
    }
    case 'assistant/attempt': {
      // 失败了但没有产出的模型请求；把 stream 里的线索捞出来
      log('warn', `模型请求未产出内容：${JSON.stringify(event).slice(0, 500)}`)
      break
    }
    case 'turn/end': {
      const kind = data.reason && data.reason.kind
      if (kind === 'error' || kind === 'aborted') {
        const reason = JSON.stringify(data.reason).slice(0, 500)
        log('error', `本轮异常结束：${reason}`)
        await sendText(chatId, `⚠️ 本轮没能完成（${kind}）：\n${reason}`)
      } else if (cfg.bridge.announceTurnEnd) {
        await sendText(chatId, `— 本轮结束（${kind || 'done'}）`)
      }
      break
    }
    default:
      break
  }
}

function handleStatus (params) {
  // 只用于日志，必要时可在这里做“正在思考…”提示
  if (!params) return
  const chatId = sessionToChat.get(params.sessionId)
  if (chatId && params.status === 'running') log('info', `会话 ${params.sessionId} 开始运行`)
}

function extractText (content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

// ── 审批 ─────────────────────────────────────────────────────────────────
async function handleApprovalRequest (req) {
  const { params, resolve } = req
  const sessionId = params && params.sessionId
  const chatId = sessionToChat.get(sessionId) || findChatBySession(sessionId)
  if (!chatId) {
    log('warn', `审批请求来自未知会话 ${sessionId}，按取消处理`)
    return resolve('cancelled')
  }
  const approvalId = crypto.randomBytes(8).toString('hex')
  let cardMessageId = ''
  try {
    const card = approvalCard({
      approvalId,
      toolName: params.toolName,
      reason: params.reason,
      sessionId
    })
    const sent = await sendCard(chatId, card)
    cardMessageId = sent && sent.messageId
  } catch (e) {
    log('error', '发送审批卡片失败: ' + e.message)
    return resolve('cancelled')
  }

  const timer = setTimeout(() => {
    if (!pendingApprovals.has(approvalId)) return
    pendingApprovals.delete(approvalId)
    log('warn', `审批 ${approvalId} 超时，按取消处理`)
    resolve('cancelled')
    updateCardSafe(cardMessageId, approvalDecidedCard({ toolName: params.toolName, decision: 'cancel', by: '超时' }))
  }, 30 * 60 * 1000)

  pendingApprovals.set(approvalId, {
    resolve, chatId, toolName: params.toolName, cardMessageId, timer
  })
  log('info', `审批请求 ${approvalId}: ${params.toolName}`)
}

// ── 用户询问 ─────────────────────────────────────────────────────────────
async function handleQuestionRequest (req) {
  const { params, resolve } = req
  const sessionId = params && params.sessionId
  const chatId = sessionToChat.get(sessionId) || findChatBySession(sessionId)
  if (!chatId) return resolve({ cancelled: true })

  const questions = (params && params.questions) || []
  if (questions.length !== 1 || !Array.isArray(questions[0].options) || !questions[0].options.length) {
    await sendText(chatId, 'DSH 有一个需要你回答的问题（多选/无选项），请在电脑端处理；本次已取消。')
    return resolve({ cancelled: true })
  }
  const q = questions[0]
  pendingQuestions.set(params.requestId, { resolve, chatId, question: q })
  try {
    await sendCard(chatId, questionCard({ requestId: params.requestId, question: q, index: 0 }))
  } catch (e) {
    log('error', '发送询问卡片失败: ' + e.message)
    pendingQuestions.delete(params.requestId)
    resolve({ cancelled: true })
  }
}

function findChatBySession (sessionId) {
  for (const [chatId, rec] of Object.entries(state.chats)) {
    if (rec.sessionId === sessionId) return chatId
  }
  return null
}

// ── 飞书出口 ─────────────────────────────────────────────────────────────
let channel = null

async function sendText (chatId, text) {
  let body = text
  if (cfg.bridge.maxReplyChars > 0 && body.length > cfg.bridge.maxReplyChars) {
    body = body.slice(0, cfg.bridge.maxReplyChars) + '\n…（内容过长，已截断）'
  }
  try {
    await channel.send(chatId, { text: body })
  } catch (e) {
    log('error', '发送飞书消息失败: ' + e.message)
  }
}

async function sendCard (chatId, card) {
  return channel.send(chatId, { card })
}

async function updateCardSafe (messageId, card) {
  if (!messageId) return
  try { await channel.updateCard(messageId, card) } catch (e) {
    log('warn', '更新卡片失败: ' + e.message)
  }
}

function operatorAllowed (openId) {
  const list = cfg.feishu.approvalAllowlist || []
  return !list.length || list.includes(openId)
}

// ── 飞书入口 ─────────────────────────────────────────────────────────────
async function handleMessage (msg) {
  try {
    if (!msg || !msg.chatId) return
    log('info', `[收到消息] chat=${msg.chatId} type=${msg.rawContentType || '?'} sender=${(msg.senderId || '').slice(0, 12)}…`)
    // 忽略机器人自己
    const senderType = msg.raw && msg.raw.sender && msg.raw.sender.sender_type
    if (senderType === 'app') return

    let text = (msg.content || '').replace(/@_user_\d+/g, '').trim()
    if (!text) {
      await sendText(msg.chatId, '发文字指令给我就行，例如：“看一下 E:\\workspace 里有哪些文件”。')
      return
    }
    if (/^\/new$|^重置$|^新会话$/.test(text)) {
      const old = state.chats[msg.chatId]
      if (old) delete state.chats[msg.chatId]
      const sid = sessionFor(msg.chatId)
      sessionToChat.set(sid, msg.chatId)
      await sendText(msg.chatId, '已开一个新会话。')
      return
    }

    const sessionId = sessionFor(msg.chatId)
    sessionToChat.set(sessionId, msg.chatId)

    // 进程重启后第一次用到该会话，先尝试恢复历史（失败则当作新会话继续）
    if (!resumed.has(sessionId)) {
      resumed.add(sessionId)
      try {
        await dsh.resume(sessionId)
        log('info', `已恢复会话 ${sessionId}`)
      } catch (e) {
        log('info', `恢复会话 ${sessionId} 失败（按新会话处理）: ${e.message}`)
      }
    }

    log('info', `收到 ${msg.chatId} 指令: ${text.slice(0, 80)}`)
    await dsh.query(sessionId, text)
  } catch (e) {
    log('error', '处理消息失败: ' + (e.stack || e))
    try { await sendText(msg.chatId, '处理失败：' + e.message) } catch {}
  }
}

async function handleCardAction (evt) {
  const value = evt && evt.action && evt.action.value
  const openId = evt && evt.operator && evt.operator.openId
  const by = (evt.operator && evt.operator.name) || openId || '—'
  log('info', `[收到卡片回调] value=${JSON.stringify(value)} by=${by}`)

  if (!value || typeof value !== 'object') return { toast: { type: 'info', content: '已收到' } }
  if (!operatorAllowed(openId)) return { toast: { type: 'error', content: '你没有权限操作' } }

  if (value.t === 'approval') {
    const p = pendingApprovals.get(value.id)
    if (!p) return { toast: { type: 'info', content: '这条审批已处理或已过期' } }
    pendingApprovals.delete(value.id)
    clearTimeout(p.timer)
    const decision = value.d === 'allow' ? 'allow' : 'reject'
    p.resolve(decision === 'allow' ? 'allowed-once' : 'rejected')
    await updateCardSafe(p.cardMessageId, approvalDecidedCard({ toolName: p.toolName, decision, by }))
    await sendText(p.chatId, decision === 'allow' ? '✅ 已允许（仅这一次）' : '⛔ 已拒绝')
    return { toast: { type: 'success', content: decision === 'allow' ? '已允许' : '已拒绝' } }
  }

  if (value.t === 'question') {
    const p = pendingQuestions.get(value.rid)
    if (!p) return { toast: { type: 'info', content: '这个问题已处理或已过期' } }
    pendingQuestions.delete(value.rid)
    p.resolve({ answers: [{ id: value.qid, selected: [value.v] }] })
    await sendText(p.chatId, `已提交答案：${value.v}`)
    return { toast: { type: 'success', content: '已提交' } }
  }

  return { toast: { type: 'info', content: '已收到' } }
}

// ── 启动前网络自检（DNS + HTTPS），出错时给出明确提示 ─────────────────────
async function preflight () {
  const dns = require('node:dns')
  const host = String(cfg.feishu.domain).replace(/^https?:\/\//, '').split('/')[0]
  try {
    const a = await dns.promises.lookup(host)
    log('info', `网络自检：DNS 正常（${host} → ${a.address}）`)
  } catch (e) {
    log('error', `网络自检：DNS 解析 ${host} 失败（${e.code}）。请检查代理是否开启 / DNS 是否可用。`)
  }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const r = await fetch(`https://${host}/open-apis/bot/v3/info`, { signal: ctl.signal })
    clearTimeout(timer)
    log('info', `网络自检：HTTPS 可达（HTTP ${r.status}；400/401 是正常的，说明网络通了）`)
  } catch (e) {
    const code = (e.cause && e.cause.code) || e.name
    log('error', `网络自检：HTTPS 连不上（${code} ${e.message}）。请检查代理 / 防火墙 / 是否需要用公司代理。`)
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────
async function main () {
  log('info', '启动飞书-DSH 桥，配置：' + configFile)
  log('info', `DSH profile=${cfg.dsh.profile} home=${cfg.dsh.dshHome} cwd=${cfg.dsh.cwd}`)

  // 允许配置多个候选模型名：依次尝试，直到 initialize 成功（模型名不支持时换下一个）。
  const candidates = (cfg.dsh.modelCandidates && cfg.dsh.modelCandidates.length)
    ? cfg.dsh.modelCandidates
    : [cfg.dsh.model]

  let init = null
  for (const model of candidates) {
    dsh = createDsh()
    dsh.start()
    const initParams = {
      cwd: cfg.dsh.cwd,
      approvalRequests: true,
      capabilities: { userQuestions: true },
      provider: cfg.dsh.provider,
      model
    }
    if (cfg.dsh.maxTokens) initParams.maxTokens = cfg.dsh.maxTokens
    if (cfg.dsh.reasoningEffort) initParams.reasoningEffort = cfg.dsh.reasoningEffort
    try {
      init = await dsh.initialize(initParams)
      log('info', `DSH 就绪（model=${model}）：${init && init.serverInfo && init.serverInfo.name} v${init && init.serverInfo && init.serverInfo.version}`)
      break
    } catch (e) {
      log('warn', `模型 ${model} 初始化失败：${e.message}`)
      try { await dsh.shutdown() } catch {}
      dsh = null
    }
  }
  if (!dsh || !init) {
    throw new Error('所有候选模型都初始化失败。请把 config.json 的 dsh.model / dsh.modelCandidates 改成你桌面版实际在用的模型名。')
  }

  await preflight()

  channel = lark.createLarkChannel({
    appId: cfg.feishu.appId,
    appSecret: cfg.feishu.appSecret,
    transport: 'websocket',
    domain: cfg.feishu.domain,
    includeRawEvent: true,
    policy: {
      dmMode: cfg.feishu.dmMode,
      dmAllowlist: cfg.feishu.dmAllowlist,
      requireMention: !!cfg.feishu.requireMention
    },
    loggerLevel: lark.LoggerLevel.info
  })

  channel.on({
    message: handleMessage,
    cardAction: handleCardAction,
    error: (err) => log('error', '飞书通道错误: ' + (err && err.message ? err.message : JSON.stringify(err))),
    reconnecting: () => log('warn', '飞书长连接断开，正在重连…'),
    reconnected: () => log('info', '飞书长连接已恢复')
  })

  await channel.connect().catch(async (e) => {
    const detail = [
      e && e.message,
      e && e.code ? `code=${e.code}` : '',
      e && e.cause && (e.cause.code || e.cause.message) ? `cause=${e.cause.code || ''} ${e.cause.message || ''}` : ''
    ].filter(Boolean).join(' | ')
    // 网络抖动/DNS 瞬时失败时不要直接退出，重试几次
    for (let i = 1; i <= 5; i++) {
      log('warn', `飞书连接失败（第 ${i} 次）：${detail}；5 秒后重试…`)
      await new Promise(r => setTimeout(r, 5000))
      try { await channel.connect(); return } catch (e2) { e = e2 }
    }
    throw e
  })
  log('info', `飞书长连接已建立，机器人：${(channel.botIdentity && channel.botIdentity.name) || '未获取到名称'}`)
  log('info', '就绪：在飞书里给机器人发消息即可。')
  // 每分钟心跳，方便确认进程还活着
  setInterval(() => log('info', '心跳：桥在线'), 60 * 1000)
}

async function shutdown (signal) {
  log('info', `收到 ${signal}，正在退出…`)
  try { if (dsh) await dsh.shutdown() } catch {}
  try { channel && await channel.disconnect() } catch {}
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch((e) => {
  log('error', '启动失败: ' + (e.stack || e))
  console.error('\n常见原因：AppID/AppSecret 不对、没开长连接、没加机器人能力、model 名字不支持、DSH 没登录。详见 README.md')
  process.exit(1)
})
