# 飞书 ⇄ DeepSeek Harness 桥

在**飞书里像聊天一样使用家里的/公司的 DeepSeek Harness**：发指令、看它干活、**点卡片按钮完成审批**。不需要公网 IP、不需要反向代理，家里电脑主动用**飞书长连接（WebSocket）**连出去即可。

## 功能

- **收消息**：飞书里给机器人发文字，自动作为指令交给 DSH 会话执行
- **回结果**：DSH 的助手回复、工具调用，实时转发回飞书
- **审批**：DSH 需要授权时，飞书弹出**允许 / 拒绝**按钮卡片，点一下即完成审批
- **问答**：DSH 需要确认时，飞书弹出选项卡片（单题单选）
- **多会话**：每个飞书聊天对应一个独立的 DSH 会话，可长期续聊
- **多机**：每台电脑各跑一套，飞书建个群把两个机器人都拉进去，`@谁` 就是谁
- **离线兜底**：启动自检、长连接自动重连、审批超时按取消处理（fail-closed）

## 架构

```
飞书 App（手机/电脑）
      ▲  长连接（出站，免公网 IP）
      │
本机：node 桥程序 ──stdio JSON-RPC──► dsh --profile sdk（真正干活的 agent）
      │                                  │
      └──── 助手回复 / 工具动作 ◄──────────┘
      └──── 审批卡片按钮 ◄── approval/request
```

审批用的是 DSH SDK 协议原生的 `approval/request`：初始化时声明 `approvalRequests: true`，服务端把审批原样抛给客户端，客户端返回 `allowed-once` / `rejected` 即完成授权。

## 目录结构

```
src/index.js        主程序：飞书收发 + 会话映射 + 审批/问答卡片
src/dsh.js          DSH SDK JSON-RPC 客户端（stdio，按换行分帧）
src/cards.js        飞书卡片 JSON（审批卡、结果卡、询问卡）
src/config.js       读取 config.json，推导 bin.js 路径
test/selftest.js    自测：不起真模型，验证传输/通知/审批往返
test/mock-dsh.js    假 DSH 服务端（mock 模式用）
run.ps1             启动桥
stop.ps1            停止桥
install-autostart.ps1   注册/卸载“登录时自启”计划任务
config.example.json     配置模板（复制为 config.json 使用）
config.home.example.json 家里电脑配置模板
```

## 快速开始

### 1. 准备飞书应用（两台电脑各建一个）

1. 装飞书，用手机号登录并**创建一个团队**（个人也能建，建完你是管理员）
2. 打开 <https://open.feishu.cn/app> → **创建企业自建应用**
3. 左侧 **应用能力 → 机器人 → 添加**
4. 左侧 **权限管理**，搜索并开通：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:chat`（可选）
   - `im:resource`（可选）
   - `im:message.group_msg.include_bot:read`（可选）
5. 左侧 **事件与回调**：
   - 事件配置：订阅方式 **使用长连接接收事件**，添加事件 `im.message.receive_v1`
   - 回调配置：订阅方式 **使用长连接**，添加回调 `card.action.trigger`
6. **版本管理与发布** → 创建版本（可用范围选自己）→ 申请发布 → 管理后台通过
7. 左侧 **凭证与基础信息** → 复制 **App ID / App Secret**

> ⚠️ 一个 App ID **同一时间只能在一台电脑上跑**（飞书长连接是多连接抢同一条事件）。要控两台，就建两个应用。

### 2. 配置

复制 `config.example.json` 为 `config.json`，至少填：

| 字段 | 说明 |
|---|---|
| `feishu.appId` / `appSecret` | 飞书应用凭证 |
| `dsh.dshHome` | DSH 数据目录，一般为 `C:\Users\<用户名>\.dsh`（复用你的 DeepSeek 登录） |
| `dsh.cwd` | agent 的工作目录 |
| `dsh.runtimeExe` | 桌面版 `DeepSeek Harness.exe` 路径 |
| `dsh.model` / `modelCandidates` | 模型名；可填多个，桥会依次尝试直到初始化成功 |

完整字段说明见 `config.js`。**`config.json` 已在 `.gitignore` 中，不会提交。**

### 3. 启动

```powershell
cd dsh-feishu
npm install --no-audit --no-fund --ignore-scripts
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

看到 `飞书长连接已建立，机器人：xxx` 后，在飞书里搜机器人名字，发消息即可。

停止：`.\stop.ps1`；开机自启：`.\install-autostart.ps1`；卸载自启：`.\install-autostart.ps1 -Uninstall`。

## 先不接真 DSH（mock 验证）

`config.json` 里设 `"mockMode": true`，启动后发消息会收到"模拟回复"并弹一张审批卡片。
**用它先验证飞书后台配得对不对**（长连接、事件、回调、权限、发布），通过后再改回 `false` 接真 DSH。

## 发给机器人的指令

| 发送 | 作用 |
|---|---|
| 任意文字 | 交给 DSH 处理（同一聊天持续同一会话） |
| `/new`、`重置`、`新会话` | 开新会话 |
| `/permission <preset>` | 切换权限预设 |
| `/compact` | 压缩历史 |

## 安全

- 机器人凭证等于**这台机器的控制权**，只发给你自己。
- 收窄访问：`dmMode: "allowlist"` + `dmAllowlist`；审批权限用 `approvalAllowlist`（填你的 open_id）。
- 撤销全部会话：删除 `%USERPROFILE%\.dsh\.credentials.yaml` 里的 `client-connection/browser-session` 记录并重启。
- 审核建议：审批超时 30 分钟按取消处理，不会被静默执行。

## 排错

| 现象 | 处理 |
|---|---|
| 日志报 `网络自检：DNS 解析 … 失败` | 检查代理/网络；确认能解析 `open.feishu.cn` |
| `21001 Access denied due to platform policy` | 豆包账号被平台策略限制，改用手机号注册的账号并重建应用 |
| 发消息不回 | 看日志；确认后台事件订阅=长连接、加了 `im.message.receive_v1`、应用已发布 |
| 审批卡片点了没反应 | 确认后台加了回调 `card.action.trigger` |
| 群里机器人不回 | 默认要 @机器人；或把 `feishu.requireMention` 设 `false` |
| push 报 `SEC_E_NO_CREDENTIALS` | 执行 `git config --local http.sslBackend openssl` |

## 已知限制

- 只转发文字，图片/文件双向暂不支持
- 一次问多个问题暂不支持，会提示在电脑端处理
- 审批 30 分钟无人处理按取消（操作不会执行）

## 验证

```powershell
node test\selftest.js   # 期望 SELFTEST PASS
```
