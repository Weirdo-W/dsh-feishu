# 飞书 ⇄ DeepSeek Harness 桥

在**飞书里像聊天一样用家里的 DSH**：发指令、看它干活、**点卡片按钮审批**。不需要公网 IP——家里电脑主动用**长连接（WebSocket）**连飞书。

```
飞书 App（手机/电脑）
      ▲ 长连接（出站，免公网 IP）
      │
家里电脑：node 桥程序 ──stdio JSON-RPC──► dsh --profile sdk（真正干活的 agent）
      │                                   │
      └──── 助手输出 / 工具动作 ◄──────────┘
      └──── 审批按钮卡片 ◄── approval/request
```

**哪台电脑装什么**（重要）：
- **被控制的那台**（比如家里的电脑）：装 DSH + Node + 本桥，开机常驻。桥必须和 DSH 在同一台机器上，它用本机 stdio 启动 `dsh`。
- **你人在哪台电脑上都行**（公司电脑、手机）：只开飞书，不需要 DSH、不需要 Node、不需要跑桥。
- 想控制两台电脑？那就两台各跑一套桥，并**各用各的飞书应用**（同一个 AppID 不能两台同时跑，事件只会推给其中一条连接）。

为什么能审批：DSH 的 SDK 协议原生支持把内部审批转成外部请求（`initialize.approvalRequests: true` → `approval/request`），客户端回 `allowed-once` 或 `rejected` 即完成——这里就做成飞书卡片上的“允许/拒绝”按钮。

---

## 一、准备飞书（自己建团队，你就是管理员）

> 两台电脑要**各建一个应用**，步骤完全一样，只是名字不同（`DSH-家里` / `DSH-公司`）。

1. 装飞书并登录，**创建一个团队**（个人也能建，建完你就是管理员）。
2. 浏览器打开 <https://open.feishu.cn/app>，点右上角 **创建企业自建应用**，填名字（如 `DSH-家里`），创建。
3. 进入应用后，左侧 **添加应用能力** → 找到 **机器人** → 点 **添加**。
4. 左侧 **权限管理** → 搜索框输 `im:message`：
   - 勾选 `im:message`（获取与发送单聊、群组消息）
   - 勾选 `im:message:send_as_bot`（以应用身份发消息）
   - 点 **批量开通**（或逐条 开通）
   - 可选再搜 `im:chat`、`im:resource`（读群信息、收发文件）
5. 左侧 **事件与回调**：
   - 顶部的 **订阅方式** 选 **使用长连接接收事件** → 保存（*不要*选"发送至开发者服务器"）
   - **事件配置** → **添加事件** → 搜 **接收消息** → 勾 `im.message.receive_v1` → 添加
   - 同一页 **回调配置** → **订阅方式** 也选 **长连接** → **添加回调** → 搜 **卡片回传交互** → 勾 `card.action.trigger` → 添加
6. 左侧 **版本管理与发布** → **创建版本** → 版本号填 `1.0.0` → 可用范围选自己（或全员）→ 保存 → **申请发布**。
   你是管理员：去 <https://feishu.cn/admin> → **应用管理 → 待审核** → 通过。
7. 左侧 **凭证与基础信息** → 复制 **App ID**（`cli_...`）和 **App Secret**，填进 `config.json`。
8. 飞书客户端左上角搜索应用名字 → 打开单聊 → 发一句话试试（没跑桥之前不会有回复，正常）。

> 想一次管两台：第 3 步做完后，飞书里 **+ → 发起群聊** 建个群，进 **群设置 → 群机器人 → 添加机器人**，把两个应用都加进去。之后在群里 `@DSH-家里` / `@DSH-公司` 即可。

> 找不到入口或名字对不上，多半是飞书后台改版，按"机器人 / 长连接 / 接收消息 / 卡片回传"这几个关键词找。

## 二、先用 mock 模式验证飞书链路（可选，但强烈建议）

不用启动真 DSH、不花模型额度，先把"飞书能不能收到消息、卡片按钮能不能回调"验证掉：

1. `config.json` 里设 `"dsh": { "mockMode": true, ... }`；
2. 启动 `run.ps1`，看到"飞书长连接已建立"；
3. 在飞书给机器人发任意一句话 → 它会回"模拟回复"并弹一张审批卡片；
4. 点「允许 / 拒绝」→ 卡片变成"已允许/已拒绝"，并回一句话。

这四步通了，说明飞书后台配置（长连接、事件、回调、权限、发布）全部正确。然后把 `mockMode` 改回 `false`，接真 DSH。

## 三、接真 DSH 并启动

1. 确认这台电脑已装 Node.js（`node -v` 有输出即可）。
2. 把 `config.example.json` 复制成 `config.json`，填两处：
   - `feishu.appId` / `feishu.appSecret`：第 7 步拿到的值。
   - `dsh.dshHome`：一般就是 `C:\Users\<你的用户名>\.dsh`（和桌面版同一个，才能复用你的 DeepSeek 登录）。
   - `dsh.cwd`：agent 的工作目录，比如 `E:\workspace`。
   - `dsh.model`：默认 `deepseek-v4-flash`；如果你桌面版用的是别的模型，改成同一个名字。也可以把 `dsh.modelCandidates` 填成多个名字（数组），桥会依次尝试直到初始化成功。
3. 首次安装依赖并启动（前台看日志）：
   ```powershell
   cd E:\workspace\dsh-feishu
   npm install --no-audit --no-fund --ignore-scripts
   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
   ```
   看到 `飞书长连接已建立` 就成功了。
4. 在飞书里搜索你刚建的机器人名字 → 单聊 → 直接发指令，例如：
   `帮我看下 E:\workspace 下有哪些项目，列出最近改过的三个文件`
5. 它要执行敏感操作时（比如跑命令），会发**审批卡片**，点“允许”或“拒绝”即可。

## 四、设成开机自动跑

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-autostart.ps1
```
停止：`.\stop.ps1`；卸载自启：`.\install-autostart.ps1 -Uninstall`。

## 五、常用命令（发给机器人）

| 发送 | 作用 |
|---|---|
| 任意文字 | 作为指令交给 DSH（同一个聊天持续同一会话） |
| `/new` 或 `重置` 或 `新会话` | 开一个新会话（丢掉上下文） |
| `/permission <preset>` | 切换权限预设（DSH 原生命令） |
| `/compact` | 压缩历史（DSH 原生命令） |

群聊里需要 **@机器人** 才响应（`feishu.requireMention` 控制）。

## 六、安全提醒

- 机器人只认 `config.json` 里的应用凭证；**能给你机器人发消息的人就能驱动你家的电脑**。团队里只留你自己；或把 `feishu.dmMode` 设成 `allowlist`、`dmAllowlist` 填你的 open_id。
- 审批按钮默认“看到卡片的人都能点”。要把审批权收窄，把 `feishu.approvalAllowlist` 填成你的 open_id（`config.json` 里 `operatorAllowed` 用）。
- 桥进程 = 你本人权限：agent 在这台电脑上能做的事，等于你能做的事。建议给它单独的工作目录。
- 首次启动会在 `%USERPROFILE%\.dsh\profiles` 下生成 `sdk` profile（复用同一份 DeepSeek 登录），不影响你桌面版的 `desktop` profile。

## 七、文件说明

| 文件 | 作用 |
|---|---|
| `src/index.js` | 主程序：飞书收发 + 会话映射 + 审批/问答卡片 |
| `src/dsh.js` | DSH SDK JSON-RPC 客户端（stdio，按行分帧） |
| `src/cards.js` | 飞书卡片 JSON（审批卡、结果卡、询问卡） |
| `src/config.js` | 读 `config.json` 并推导 `bin.js` 路径 |
| `test/selftest.js` | 自测：不起真模型，验证传输/通知/审批往返 |
| `run.ps1` / `stop.ps1` / `install-autostart.ps1` | 启停与开机自启 |
| `logs/bridge.log` | 运行日志 |

自测：
```powershell
node test\selftest.js   # 期望输出 SELFTEST PASS
```

## 八、排错

| 现象 | 处理 |
|---|---|
| 启动报 `spawn EPERM` / 找不到 bin.js | `dsh.useNode` 保持 `true`，确认 `runtimeExe` 指向 `DeepSeek Harness.exe`，且装在同一路径下 |
| `initialize` 报模型/适配器错误 | `dsh.model` 改成你桌面版实际在用的模型名；确认桌面版已登录 DeepSeek 账号 |
| 飞书里发消息机器人不回 | 看 `logs/bridge.log`；确认后台“事件订阅=长连接”、已加 `im.message.receive_v1`、应用已发布、机器人能力已开 |
| 审批卡片没有按钮回调 | 后台“事件与回调”里补上回调 `card.action.trigger`；卡片 2.0 需要应用有消息卡片权限 |
| 群里不理人 | 默认要 @机器人；或把 `feishu.requireMention` 设 `false` |
| 回复太长被截断 | 调大 `bridge.maxReplyChars` |

## 九、已知限制（本版）
- 只转发**文字**；图片/文件双向暂不支持（可在后续版本加）。
- 一问多题（一次问多个问题）暂不支持，会提示去电脑端答；单题单选已支持。
- 审批 30 分钟无人点按“取消”处理（fail-closed，操作不会被执行）。
- 飞书卡片按钮依赖 `card.action.trigger` 回调；企业若禁用了互动卡片能力，就退化为只能收发文字、审批需回电脑点。

## 十、多台电脑：一个飞书群，两个机器人

目标：在同一个飞书界面里，既能问家里的 DSH，也能问公司的 DSH。

**做法**（零额外设施）：
1. 两台电脑**各建一个**自建应用（机器人名字分别叫 `DSH-家里`、`DSH-公司`），各拿一对 AppID/AppSecret。
2. 两台电脑各跑一套桥（各自的 `config.json`，`mockMode: false`）。
3. 飞书里建一个群「我的电脑」，把两个机器人都拉进群。
4. 在群里 `@DSH-家里 帮我看看…` / `@DSH-公司 跑一下测试`。只有被 @ 的机器人会响应（`requireMention: true`）。
5. 审批卡片也是各发各的，点哪张就批哪台。

**为什么不能只用一个机器人管两台**：飞书长连接是"同一应用的多条连接抢同一条事件"，一个 AppID 同时跑两个桥，消息会被随机一台接走。所以**一台电脑一个应用**是硬要求。

**想真正做到"一个对话里用前缀切换"**（比如发 `家里: …` / `公司: …`）：需要一个中枢进程同时能连到两台机器，即两台之间要有可达网络（Tailscale / 公司 VPN / 一台小 VPS 做中转）。这个模式本版没实现，需要时再加。


