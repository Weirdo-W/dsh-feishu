'use strict'
/**
 * 配置加载 + 校验。
 * 读取根目录 config.json（可用环境变量 DSH_FEISHU_CONFIG 指定其他路径）。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

function loadConfig () {
  const file = process.env.DSH_FEISHU_CONFIG || path.join(ROOT, 'config.json')
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件：${file}\n请先复制 config.example.json 为 config.json 并填写。`)
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))

  const cfg = {
    feishu: Object.assign({
      appId: '',
      appSecret: '',
      // 单聊：open 允许任何人给机器人发消息；allowlist 只允许 dmAllowlist 里的 open_id
      dmMode: 'open',
      dmAllowlist: [],
      // 群里是否必须 @机器人 才响应
      requireMention: true,
      // 允许点审批按钮的 open_id；留空表示“有权限看到卡片的人都能点”
      approvalAllowlist: [],
      domain: 'https://open.feishu.cn'
    }, raw.feishu),
    dsh: Object.assign({
      // Windows 桌面版的运行时；若用独立 CLI，把 useNode 设为 false、runtimeExe 指向 dsh
      runtimeExe: 'D:\\software\\DeepSeek Harness\\DeepSeek Harness.exe',
      dshBin: '',                 // 留空则由 runtimeExe 推导 app.asar 内的 lib/bin.js
      useNode: true,              // true = 以 node 模式运行 Electron；runtimeExe 为 node 时设 false
      dshHome: 'C:\\Users\\' + (process.env.USERNAME || '') + '\\.dsh',
      profile: 'sdk',
      cwd: ROOT,
      // 仅验证飞书链路时设为 true：用 test/mock-dsh.js 假装 DSH，不消耗模型额度
      mockMode: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      // 可选：多个候选模型名，依次尝试直到初始化成功
      modelCandidates: [],
      maxTokens: 49152,
      reasoningEffort: '',
      requestTimeoutMs: 300000
    }, raw.dsh),
    bridge: Object.assign({
      stateFile: path.join(ROOT, 'state.json'),
      logDir: path.join(ROOT, 'logs'),
      showToolCalls: true,
      announceTurnEnd: false,
      // 回复里最多回传多少字符（防超长）；0 表示不限
      maxReplyChars: 12000,
      // 每条飞书消息对应的 DSH 会话是否复用（true=同一 chat 持续同一会话）
      persistSessions: true
    }, raw.bridge)
  }

  if (!cfg.feishu.appId || !cfg.feishu.appSecret) {
    throw new Error('config.json 里 feishu.appId / feishu.appSecret 未填写。')
  }
  if (!cfg.dsh.useNode && !cfg.dsh.runtimeExe) {
    throw new Error('config.json 里 dsh.runtimeExe 未填写。')
  }
  // 推导 bin.js
  if (cfg.dsh.useNode && !cfg.dsh.dshBin) {
    const root = path.dirname(cfg.dsh.runtimeExe)
    cfg.dsh.dshBin = path.join(root, 'resources', 'app.asar', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
  return { cfg, file, root: ROOT }
}

module.exports = { loadConfig, ROOT }
