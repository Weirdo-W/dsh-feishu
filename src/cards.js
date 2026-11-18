'use strict'
/** 飞书互动卡片构造（卡片 2.0 schema）。 */

function btn (text, type, value) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }]
  }
}

/** 审批卡片：允许 / 拒绝。 */
function approvalCard ({ approvalId, toolName, reason, sessionId }) {
  const lines = [
    '**DSH 请求审批**',
    `工具：\`${toolName || '未知'}\``
  ]
  if (reason) lines.push(`原因：${reason}`)
  lines.push(`会话：\`${shortId(sessionId)}\``)
  return {
    schema: '2.0',
    config: { update_multi: true, wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '需要你审批一个操作' },
      template: 'orange'
    },
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        btn('✅ 允许（仅这一次）', 'primary', { t: 'approval', id: approvalId, d: 'allow' }),
        btn('⛔ 拒绝', 'danger', { t: 'approval', id: approvalId, d: 'reject' })
      ]
    }
  }
}

/** 审批结果卡片（覆盖原卡片）。 */
function approvalDecidedCard ({ toolName, decision, by }) {
  const map = { allow: ['✅ 已允许', 'green'], reject: ['⛔ 已拒绝', 'red'], cancel: ['⌛ 已取消', 'grey'] }
  const [label, template] = map[decision] || ['已处理', 'grey']
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: label }, template },
    body: {
      elements: [
        { tag: 'markdown', content: `工具：\`${toolName || '未知'}\`\n处理人：${by || '—'}` }
      ]
    }
  }
}

/** 单个询问的按钮卡片。 */
function questionCard ({ requestId, question, index }) {
  const elements = [
    { tag: 'markdown', content: `**DSH 需要你确认**（第 ${index + 1} 题）\n${question.text || ''}` }
  ]
  const options = Array.isArray(question.options) ? question.options : []
  options.slice(0, 8).forEach((opt, i) => {
    const label = typeof opt === 'string' ? opt : (opt.label || opt.value || `选项 ${i + 1}`)
    const value = typeof opt === 'string' ? opt : (opt.value || opt.label || String(i))
    elements.push(btn(label, i === 0 ? 'primary' : 'default', {
      t: 'question', rid: requestId, qid: question.id, v: value
    }))
  })
  if (!options.length) {
    elements.push({ tag: 'markdown', content: '_（这道题没有可选项，请在电脑上回答）_' })
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '需要你回答' }, template: 'blue' },
    body: { elements }
  }
}

function shortId (s) {
  if (!s) return '—'
  return s.length > 12 ? s.slice(0, 8) + '…' : s
}

module.exports = { approvalCard, approvalDecidedCard, questionCard }
