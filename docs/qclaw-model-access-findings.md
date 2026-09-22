# QClaw 模型接入调查结论

> 调查日期：2026-09-21
> 调查对象：QClaw v0.2.37.630（`E:\soft\QClaw\v0.2.37.630`）
> 目的：评估"把 QClaw 的大模型能力逆向出来，做成 sub2api / CLIProxyAPI 式代理部署到云服务器"的可行性
> 状态：**调查完成，方案待用户拍板，未开工**

---

## 0. 一句话结论（2026-09-21 修订）

> ⚠️ **本节曾写过错误结论，已推翻。** 初版结论是"无需逆向，直接买腾讯云 Coding Plan 官方 key"，理由是渲染层里有一张 BYOK provider 表指向 `api.lkeap.cloud.tencent.com/coding/v3`。
> **该结论不成立**：那张表是 QClaw 的**自定义模型接入（BYOK）目录**，用它是花用户自己的钱，与"用 QClaw 免费额度"无关。真正消耗 QClaw 免费额度的是 **`qclaw/*` 命名空间下的内置模型**（见 §2.0），走的是 `open.qclaw.qq.com/proxy/llm/*` 这条私有链路 —— **这才是需要逆向的对象**。

**修订后的结论**：需要逆向的是 QClaw 内置模型链路（`qclaw/pool-*` 等 11 个模型 + `/proxy/llm/chat/completions`）。已确认该链路的**元数据端点可无签名访问**，但**推理端点存在额外校验**（见 §2.4），签名机制尚未破解。

---

## 2.0 QClaw 内置模型目录（`qclaw/*`，即免费额度所在）

### 权威来源与实时性

- 端点：`GET http://127.0.0.1:19000/proxy/llm/models`，`Authorization: Bearer <token>`
- token 来源：`~/.qclaw/openclaw.json` → `gateway.auth.token`（**明文存盘**），或 `~/.qclaw/identity/device-auth.json` → `tokens.operator.token`（两者实测均可用）
- 本次同时拿到"实时目录"和"2026-07-03 会话日志里的历史抓包"，**两者 11 个 id 完全一致，零增删** → 目录近三个月稳定
- 原始快照存于 `re/catalog-live.json`

### 完整清单（11 个）

调用时 `model` 字段需带前缀：`qclaw/pool-glm-5.2`。下表 id 列为去掉 `qclaw/` 后的值。

| id（`qclaw/`+） | 显示名 | context | 输入 | 说明 |
|---|---|---|---|---|
| `modelroute` | Auto | 250,000 | text,image | 兼顾质量与速度，按任务复杂度从内置模型中智能路由（`display_id: default`） |
| `pool-hy3-preview` | Hy3 / Hy3 preview | 262,144 | text | 能力全面，适合编程开发、复杂推理与长文档处理 |
| `pool-deepseek-v4-pro` | DeepSeek-V4-Pro | 1,048,576 | text | 推理编码顶尖，复杂逻辑分析、工程开发、超长文档理解 |
| `pool-deepseek-v4-flash` | DeepSeek-V4-Flash | 1,048,576 | text | 轻量高效，快速问答、编程辅助、日常创作 |
| `pool-glm-5.2` | GLM-5.2 | 1,048,576 | text | 长程自主交付，大型工程开发、海量文档、长时自动化 |
| `pool-glm-5.2-night` | GLM-5.2 · 夜间专属 | 1,048,576 | text | **23:00–08:00 才开放**，享更低倍率，适合长程任务挂机 |
| `pool-glm-5.1` | GLM-5.1 | 204,800 | text | 逻辑强大，多步复杂指令、数据分析、深度推理 |
| `pool-kimi-k2.7-code-highspeed` | Kimi-K2.7-Code-HighSpeed | 262,144 | text,image | 极速响应，输出达 260 Token/s |
| `pool-kimi-k2.6` | Kimi-K2.6 | 262,144 | text,image | 编程顶尖，全栈代码生成、长时连续编码 |
| `pool-minimax-m3` | MiniMax-M3 | 204,800 | text,image | 原生多模态，图文理解、编程、智能体任务（**当前默认主模型**） |
| `pool-minimax-m2.7` | MiniMax-M2.7 | 204,800 | text | 综合能力强，复杂编程、专业文档、深度分析 |

全部条目 `owned_by: "qclaw"`、`status_level: 0`、`created: 0`。图标由 `webcdn.m.qq.com/webcdn/qclaw/expert/agent-files/` 下发。

### 目录之外的 `qclaw/*` 引用（从会话日志穷举所得，非 /proxy/llm/models 下发）

`qclaw/expert`、`qclaw/agent0507`、`qclaw/workspace-agent-xxx`（占位符）—— 疑为专家/智能体路由用的内部 id；历史会话里还出现过 `qclaw/glm-5.2`、`qclaw/kimi-k2.6` 等**不带 `pool-` 前缀**的写法，说明服务端存在别名映射（对应字节码字符串 `PROXY_V2:model-remap`）。

### 与当前配置的关系

`~/.qclaw/openclaw.json` → `agents.defaults.model.primary = qclaw/pool-minimax-m3`，`agents.defaults.heartbeat.model = qclaw/modelroute`。`models.mode = "merge"`，即 BYOK provider 与内置 `qclaw` provider 合并；`qclaw` provider 本身**不写入该配置文件**，由主进程运行时注入（凭据见 §4）。

---

## 2.4 本地网关与 `/proxy/*` 接口面

### 两套网关，别混

| 端口 | 归属进程 | 性质 |
|---|---|---|
| **19000** | `QClaw.exe` 主进程（PID 14760） | **QClaw 自有代理网关**，转发到 `https://open.qclaw.qq.com/proxy/*`，即免费额度链路 |
| **33187** | `node.exe`（PID 9944，openclaw 网关） | 标准 OpenClaw 网关；`/v1/models` 返回的是 `openclaw/<agentId>` **agent 伪模型**，不是 LLM 目录；`gateway.port` 配置就写着 33187 |

> 初版调查按 QClaw.exe 的 PID 过滤监听端口，因此完全漏掉了 33187（node 进程）。12495 是 openclaw 的控制面（`/health` → `ok`）。

### 实测鉴权矩阵（19000，GET）

| 路径 | 无 token | Bearer token |
|---|---|---|
| `/proxy/health` | 403/9002 | **200** |
| `/proxy/llm/models` | 403/9002 | **200** |
| `/proxy/llm/chat/completions` | 403/9002 | **403** |
| `/chat/completions` | 403/9002 | **403** |
| `/proxy/llm/v1/chat/completions` | 403/9002 | **403** |
| `/v1/chat/completions` | 403/9002 | **403** |
| `/proxy/llm/completions` | 403/9002 | **403** |
| `/proxy/embedding` | 403/9002 | **403** |

**关键推论**：同一个 bearer token 能让元数据端点放行，却挡在推理端点外 → 推理请求还需要**第二层校验**（额外签名头 / 特定 method+body 组合 / 设备指纹参与）。这正是本项目要逆向的核心难点，也是初版"协议就是标准 OpenAI、直接买 key 就行"结论失效的地方。

> 注：403 也可能只是方法门控（这些路径只接受 POST，而我用的是 GET）。**尚未区分这两种解释**，需要用一次真实的 POST 才能定论 —— 但那会消耗免费额度并触碰风控，已停手待用户决定（见 §6 决策项 7）。

### 从字节码字符串提取到的 `/proxy/*` 全量接口面

```
/proxy          /proxy/llm        /proxy/llm/models    /proxy/llm-tool
/proxy/api      /proxy/embedding  /proxy/health        /proxy/aippt
/proxy/plugin   /proxy/plugin/    /proxy/prosearch     /proxy/workspace
/proxy/qclaw-cos               /proxy/qclaw-generate-image
/proxy/internal/queue-guard    /proxy/internal/report
/proxy/oauth-callback          /proxy/pkce-callback
/llm   /llmq   /llmtoolserver   /chat/completions   /api/v3   /api/v4
```
配套字符串证据：`forwarding to llama-server [PROXY_V2:model-remap+content-length-fix]`、`not recognized as QClaw Hermes`、`not found in /v1/models, using defau...`、`chat.completion.chunk`、`requiresHttpChatCompletions`、`isChatCompletionsRequest`。
### 2.5 已验证可用的调用形式（2026-09-21 实测）

**唯一跑通的推理链路 = 本机 OpenClaw 网关的 agent 路由：**

```http
POST http://127.0.0.1:33187/v1/chat/completions
Authorization: Bearer <~/.qclaw/openclaw.json → gateway.auth.token>
Content-Type: application/json

{"model":"openclaw/main","messages":[{"role":"user","content":"只回复两个字：收到"}],"max_tokens":32}
```
→ HTTP 200，15–17 s，`{"choices":[{"message":{"content":"收到"},"finish_reason":"stop"}]}`，
`usage` 三个字段均为 0（agent 路由不上报 token 数）。

模型目录则必须走另一个端口：`GET http://127.0.0.1:19000/proxy/llm/models`（同一 token 可过）。
注意 33187 对未知路径返回 SPA 的 **HTML + 200**，不能凭状态码判断成功，必须校验响应是 JSON 且有 `data`。

### 2.6 凭据解密与登录契约（已实证）

`AppData\Roaming\QClaw\app-store.json` 的 safeStorage 密文可在本机解密：
`Local State → os_crypt.encrypted_key` → base64 → 去 `DPAPI` 前缀 → `ProtectedData::Unprotect(CurrentUser)`
→ 32 字节主密钥 → 对各 `cipherText` 去 `v10` 前缀后按 **AES-256-GCM**（nonce=12B、tag=末16B）解密。
实现见 `src/bootstrap.mjs`（PowerShell 取 DPAPI + Node 做 GCM）。

解出结果：

| 字段 | 形态 |
|---|---|
| `authGateway.providers.qclaw.apiKey` | `sk-…`，51 字节 |
| `secure.jwtToken` | HS256 JWT：`iss:"openclaw"`、`user_id`、`guid`(64hex)、**`auth_type:"wechat"`**、`iat`/`exp` 约 30 天 |
| `secure.userInfo` | 微信 `openid` / `unionid` / `nickname` / `avatar` |

登录入口（字节码字符串）：`/proxy/oauth-callback`、`/proxy/pkce-callback`、`/api/account/userauth/check`、`/api/account/userauth/code` → **微信 OAuth + PKCE**。号池"加账号"的现实路径是：在目标机器上跑 `bootstrap.mjs` 导出 `{base, token, llmApiKey, note}`，而非在服务端复现登录。

### 扫码登录流程（为"代理内加账号"而挖，尚未拿全）

字节码里的 IPC 日志线索：

```
[IPC] weixinLoginStart: Fetching QR code via fetchQRCode
[IPC] weixinLoginStart: QR code ready, bg poll started sessionKey=<...>
```

可还原出的流程：`fetchQRCode()` 由**服务端下发二维码**（不是本地拼 `open.weixin.qq.com/qrconnect` URL，也未发现本地 appid），拿到 `qrcodeUrl` / `qrcode_img_content` + `sessionKey` → 后台轮询 `/api/account/userauth/check` → 扫码后取 `/api/account/userauth/code` → 换 JWT + `sk-` key。

**未拿到的**：`fetchQRCode` 的真实端点与参数（在 V8 字节码里拼装，字符串表只留下 `ilink/bot/get_bot_qrcode`、`get_qrcode_status`、`https://ilinkai.weixin.qq.com` 这类相邻线索，无法确认属于本流程）。要补上需要 mitm 抓一次登录，或反编译 `index.cjsc`。

**关键结论**：即便实现扫码登录，新账号拿到的仍是 JWT + `sk-` key，而 §2.4/§2.6 表明这套凭据**目前无法在 QClaw 之外完成推理**（9002 / `x-sign-*`）。因此在任务 #10 破解签名之前，自建扫码登录产出的账号不可独立使用；gateway 模式下 QClaw 自身 UI 已能扫码登录，代理侧再做一遍是重复的。


**仍未打通**：用 `sk-` key 直连 `19000/proxy/llm/chat/completions` 返回 9002（耗时 2 s，说明真的转发到了上游并被拒），而 openclaw 自身却能成功调用同一形态 —— 差异指向 `QCLAW_LLM_API_KEY`（配置里只有占位符 `${QCLAW_LLM_API_KEY}` 与 `QCLAW_LLM_API_KEY_ENV_PLACEHOLDER`，真值由主进程注入 node 环境变量，需读进程内存才能拿到），或 `x-sign-signature` + `x-sign-timestamp`（疑与 `turingShield:fetchTicket` 票据相关）。

### 2.7 上游 provider 契约（来自明文 TS 扩展）

`resources/openclaw/config/extensions/qclaw-llm-provider/`（**未混淆的 TypeScript**）：

- `openclaw.plugin.json` → `baseUrl: "${QCLAW_LLM_BASE_URL}"`、`api: "openai-completions"`、`setup.envVars: ["QCLAW_LLM_API_KEY"]`
- `models.ts` → `normalizeQClawModelId()` 剥掉 `qclaw/` 前缀；`default` → `modelroute`；`requestTimeoutMs` 设 7200 s 以绕过内核 120 s idle watchdog
- 结论：**上游就是标准 OpenAI 兼容协议 + Bearer key**，私有性全在 19000 这一层的鉴权与签名上。

---


---


## 1. QClaw 的真实形态

| 项 | 值 |
|---|---|
| 应用标识 | `com.tencent.qclaw`，productName `QClaw`，包名 `@guanjia-openclaw/electron` |
| 版本 | 0.2.37.630（`resources/channel.json` → `channel: 5001`；`app-store.json` → `first_channel: 5043`） |
| 运行时 | Electron 37.10.3 / Node 22.21.1 / Chromium 138.0.7204.251 |
| 安装路径 | `E:\soft\QClaw\v0.2.37.630\QClaw.exe`（204 MB） |
| 用户数据 | `C:\Users\<user>\AppData\Roaming\QClaw` |
| 进程模型 | 8 进程（1 主 + 3 renderer + gpu + network service + audio service + crashpad），常驻约 1.4 GB |
| 遥测 | `https://galileotelemetry.tencent.com/crashReport`（aegis SDK v2.6.17-beta.2） |

### 1.1 捆绑组件（`resources/`）

| 组件 | 体积/内容 | 作用 |
|---|---|---|
| `app.asar` | 143 MB | Electron 壳（**主进程为 V8 字节码**，见 §3） |
| `openclaw_0/1/2.tar` | ~1 GB | OpenClaw 网关运行时 |
| `hermes_0/1/2.tar` | ~530 MB | plugins / skills / libs |
| `llama-server/win-x64` | — | llama.cpp，本地推理 |
| `openclaw/node_modules/@tencent/openclaw-sdk` | 20 KB | **仅是壳**：`dependencies: { "openclaw": "npm:@tencent/openclaw-sdk-internal@2026.6.5-9" }` |
| `openclaw/node_modules/openclaw` | 96 MB | 真运行时，`src/manifest.json` → `version 2026.6.5`, `repo https://github.com/openclaw/openclaw.git` → **公开 OSS** |
| `qimei/qimei.dll` | Windows 原生 | 腾讯设备指纹 |
| `turing-shield/turing_bridge.exe` | Windows 原生 | 腾讯风控 |
| `security/lowpriv-launcher.exe` | Windows 原生 | 降权启动 |
| `bin/ui-reader.exe` | Windows 原生 | UI 取词/截屏 |
| `node/`, `python/`, `git/`, `lemonade/`, `oauth-assets/` | — | 自带工具链 |

openclaw 运行时的 `node_modules` 内含 `openai`、`@anthropic-ai`、`@google`、`@mistralai`、`@modelcontextprotocol`、`@openclaw/proxyline`、`@openclaw/fs-safe`，以及 dingtalk / slack / discord / telegram(grammyjs) / lark / line 等 channel 连接器 → **该运行时天生就是多 provider、OpenAI/Anthropic 兼容的网关**。

### 1.2 本机端口拓扑（均由主进程 PID 持有）

| 端口 | 绑定 | 行为 |
|---|---|---|
| `12495` | 127.0.0.1 | HTTP，`GET /health` → `ok`，其余路径 404 → **openclaw 网关控制面** |
| `19000` | 127.0.0.1 + ::1 | **路由无关的统一鉴权门**：`/`、`/health`、`/v1/models`、`/v1/chat/completions`、`/compatible-mode/v1/chat/completions` 全部返回同一响应 ↓ |
| `5283` | 127.0.0.1 | HTTPS（明文 HTTP 请求被拒：`Client sent an HTTP request to an HTTPS server`），未进一步探测 |

19000 的响应体（缺 token 时）：
```json
{"error":{"code":"9002","message":"该功能暂不可用，请稍后再试<!--error_code:9002-->","type":"auth_error","source":"gateway"}}
```

出网经 `127.0.0.1:10808`（用户本机 Clash mixed 端口）。

---

## 2. 上游模型接口（核心成果）

### 2.1 完整 provider 表

> ⚠️ **定位说明**：本节与 §2.2 是 QClaw 的**自定义模型接入（BYOK）目录** —— 用户自行填 key、花自己的钱，**与 QClaw 免费额度无关**。保留作为参考（例如代理若要同时支持 BYOK 转发时用得上），但**它不是逆向目标**。逆向目标见 §2.0。

从 `app.asar` 解包后的渲染层 bundle（`out/renderer/assets`、`out/renderer/sdk`）提取，原文是压缩后的 JS 数组（变量名 `F6`）：

**Coding Plan 类（订阅套餐）**

| key | label | baseUrl | api |
|---|---|---|---|
| `tencent-plan` | 腾讯云 Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` | `openai-completions` |
| `tencent-token-plan` | 腾讯云Token Plan | `https://api.lkeap.cloud.tencent.com/plan/v3` | `openai-completions` |
| `bailian-plan` | 百炼 Coding Plan | `https://coding.dashscope.aliyuncs.com/v1` | `openai-completions` |
| `minimax-plan` | MiniMax（国内-Coding Plan） | `https://api.minimaxi.com/anthropic` | `anthropic-messages` |
| `zhipu-plan` | 智谱 AI（GLM国内-Coding Plan） | `https://open.bigmodel.cn/api/anthropic` | `anthropic-messages` |
| `ark-plan` | 方舟（火山引擎）Coding Plan | `https://ark.cn-beijing.volces.com/api/coding` | `anthropic-messages` |
| `kimi-plan` | Kimi Coding Plan | `https://api.kimi.com/coding/v1` | `anthropic-messages` |
| `qianfan-plan` | 百度千帆 Coding Plan | `https://qianfan.baidubce.com/anthropic/coding` | `anthropic-messages` |

**普通按量类**

| key | label | baseUrl | api |
|---|---|---|---|
| `hunyuan` | 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | `openai-completions` |
| `deepseek` | 深度求索（DeepSeek） | `https://api.deepseek.com/` | `openai-completions` |
| `kimi` | Moonshot AI（Kimi国内） | `https://api.moonshot.cn/v1` | `openai-completions` |
| `zai` | 智谱 AI（GLM国内） | `https://open.bigmodel.cn/api/paas/v4` | `openai-completions` |
| `qwen` | 百炼（千问） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `openai-completions` |
| `doubao` | 火山引擎（豆包） | `https://ark.cn-beijing.volces.com/api/v3` | `openai-completions` |
| `minimax` | Minimax（国内） | `https://api.minimaxi.com/v1` | `openai-completions` |

> 关键推论：**只有 5 家 coding plan 走 `anthropic-messages`**（MiniMax / 智谱 / 方舟 / Kimi / 千帆），腾讯与百炼走 `openai-completions`。做多厂商号池时，协议转换层是主要工作量。

### 2.2 模型清单（完整，已从渲染层穷举）

统计：**15 个 provider / 90 条模型条目 / 小写归一后 49 个不同 model id**。

#### Coding Plan 类

**`tencent-plan` + `tencent-token-plan`**（两者模型池完全相同，8 条）
`tc-code-latest`(自动)、`hunyuan-2.0-instruct`、`hunyuan-2.0-thinking`、`hunyuan-t1`、`hunyuan-turbos`、`minimax-m2.5`、`kimi-k2.5`、`glm-5`

**`bailian-plan`**（7 条）
`qwen3.5-plus`、`qwen3-coder-plus`、`qwen3-max-2026-01-23`、`kimi-k2.5`、`glm-5`、`MiniMax-M2.5`、`glm-4.7`

**`minimax-plan`**（8 条）
`MiniMax-M2.7-highspeed`、`MiniMax-M2.7`、`MiniMax-M2.5`、`MiniMax-M2.5-highspeed`、`MiniMax-M2.5-Lightning`、`MiniMax-M2.1`、`MiniMax-M2.1-lightning`、`MiniMax-M2`

**`zhipu-plan`**（6 条）
`GLM-5-Turbo`、`glm-5`、`glm-4.7`、`glm-4.6`、`glm-4.5-air`、`glm-4.5`

**`ark-plan`（火山方舟）**（8 条）
`doubao-seed-2.0-code`、`doubao-seed-2.0-pro`、`ark-code-latest`、`doubao-seed-code`、`glm-4.7`、`deepseek-v3.2`、`kimi-k2-thinking`、`kimi-k2.5`

**`kimi-plan`**（1 条）
`kimi-k2.5`

**`qianfan-plan`（百度千帆）**（4 条）
`kimi-k2.5`、`deepseek-v3.2`、`glm-5`、`minimax-m2.5`

#### 按量付费类

**`hunyuan`**（4 条）
`hunyuan-turbos-latest`、`hunyuan-t1-latest`、`hunyuan-2.0-instruct-20251111`、`hunyuan-2.0-thinking-20251109`

**`deepseek`**（4 条）
`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`

**`kimi`**（4 条）
`kimi-k2-thinking`、`kimi-k2-thinking-turbo`、`kimi-k2.5`、`moonshot-v1-128k`

**`zai`（智谱按量）**（6 条）
`glm-5-turbo`、`glm-5`、`glm-4.7`、`glm-4.6`、`glm-4.5-air`、`glm-4.5`

**`qwen`（百炼按量）**（10 条）
`qwen3.5-plus`、`qwen-max`、`qwen-plus`、`qwen-turbo`、`qwen3-coder-plus`、`MiniMax-M2.5`、`kimi-k2.5`、`glm-5`、`glm-4.7`、`deepseek-v3.2`

**`doubao`（火山按量）**（7 条）
`doubao-seed-2-0-pro-260215`、`doubao-seed-1-8-251228`、`glm-4-7-251222`、`doubao-seed-code-preview-251028`、`doubao-seed-1-6-lite-251015`、`doubao-seed-1-6-flash-250828`、`doubao-seed-1-6-vision-250815`

**`minimax`（按量）**（5 条）
`MiniMax-M2.7`、`MiniMax-M2.5`、`MiniMax-M2.1`、`MiniMax-M2.1-lightning`、`MiniMax-M2`

#### 实现相关观察

1. **model id 大小写不一致**：同一模型在不同 provider 下写作 `MiniMax-M2.5` / `minimax-m2.5`、`GLM-5-Turbo` / `glm-5-turbo`、`glm-4.7` / `glm-4-7-251222`。号池做模型名匹配与跨 key 路由时**必须大小写不敏感**，且不能假设 id 全局唯一（唯一性作用域是 provider 而非全局）。
2. **跨厂商同名模型**：`kimi-k2.5`、`glm-5`、`glm-4.7`、`deepseek-v3.2`、`MiniMax-M2.5` 在多家 coding plan 里同时出现 → 号池可跨厂商做"同模型多 key 故障转移"，这是号池价值最高的特性。
3. **`*-latest` / `自动` 语义**：`tc-code-latest`(自动)、`ark-code-latest` 是服务端路由别名，实际模型随厂商策略变化。要固定行为就别用它们。
4. **QClaw 自带默认模型不在这张表里**：走 `authGateway.providers.qclaw`（主进程注入）。但渲染层中出现的 `hunyuan-2.0-instruct`、`hunyuan-2.0-thinking`、`hunyuan-t1`、`hunyuan-turbos`、`tc-code-latest` 与 `tencent-plan` 的 id **完全一致** → 强烈提示 QClaw 默认模型即为 lkeap Coding Plan 模型，只是凭据由 QClaw 账号换取。未通过抓包最终证实。
5. 另有一处 zod schema 描述 Hermes 的 BYOK 配置：`{apiKey, apiMode?, defaultModel?, contextLength?, rateLimitDelay?}` —— `rateLimitDelay` 说明客户端侧已有节流概念，可参考其语义。


### 2.3 官方来源确认

- 腾讯云文档「大模型服务平台 TokenHub」确认 base URL `https://api.lkeap.cloud.tencent.com/coding/v3`、兼容 OpenAI、API Key 需订阅 Coding Plan 获取、支持 Cline / Cursor 等第三方工具
- 相关文档页：TokenHub `product/1823/130099`、OpenClaw `product/1823/130094`、Claude Code `product/1823/130097`
- 入口：`https://console.cloud.tencent.com/hunyuan/start`（Coding Plan）、`https://hunyuan.cloud.tencent.com/#/app/tokenplan`（Token Plan）
- 价格参考：Coding Plan 首月 7.9 元（第三方报道，未核实当前价）

### 2.4 渲染层出现的其他域名（非模型链路）

`qclaw.qq.com`、`aiarea.qclaw.qq.com`、`cdn.qclaw.qq.com`、`agent.qq.com/agent`、`mmgrcalltoken.3g.qq.com/aizone`、`security.guanjia.qq.com`、`security-test.guanjia.qq.com`、`pcmgrmonitor.3g.qq.com`、`aegis.qq.com`、`h.trace.qq.com`、`oth.str.beacon.qq.com`、`otheve.beacon.qq.com`、`om.gtimg.cn`、`beacon.cdn.qq.com`、`galileotelemetry.tencent.com`、`api.hunyuan.cloud.tencent.com`、`docs.qq.com/oauth/v2`、`res.wx.qq.com`、`work.weixin.qq.com/kfid`、`ima.qq.com`、`meeting.tencent.com`、`jprx.m.qq.com`、`mirrors.tencent.com/npm`、`webcdn.m.qq.com/qclaw`、`ai-page-1251316161.cos.ap-guangzhou.myqcloud.com`、`tun-cos-1258344701.file.myqcloud.com`、`rule.tencent.com`、`privacy.qq.com`

---

## 2.8 mitm 抓包实测结论（2026-09-21 晚）

### 抓到的真实 API 总线

QClaw 的业务接口不是 REST 风格，而是**统一转发总线**：

```
POST https://jprx.m.qq.com/data/<数字apiId>/forward
```

已识别的 apiId：`4327` = 模型目录（请求体 `{"model_ids":["default","pool-hy3-preview",…],"web_version":"1.4.0","web_env":"release"}`）、`4243` = 场景开关（`{"scenes":["openPurchase","chat","jumpToWebPurchase"]}`）、`4283` = 专家/agent 列表、`4204` = 分页列表。另有 20+ 个 apiId 未归类。

### 账号凭据头集合（关键成果）

总线请求携带的鉴权头，已从 `re/secrets.jsonl`（118 条）确认：

| 头 | 长度 | 形态 |
|---|---|---|
| `x-account` | 10 | user_id（与 JWT 的 user_id 一致） |
| `x-guid` | 64 | 设备 guid，与 `secure.userInfo.guid` 完全相同 |
| `x-qclaw-devicetoken` | **431** | **`v3:AAAA…` 前缀的版本化设备令牌**（疑由 qimei/turing 产出） |
| `x-openclaw-token` | 305 | 就是我们已能解密的 HS256 JWT |
| `x-version` / `x-is-internal` | 1 | `1` / `0` |
| `x-token` / `x-session` | 0 | 在这些请求里为空 |

**重要结论：没有发现任何逐请求 HMAC**（`x-sign-signature` / `x-sign-timestamp` 未出现在真实流量中）。鉴权是**一组静态凭据头**，其中真正的设备绑定项是 `x-qclaw-devicetoken`。这显著降低了 #10 的难度 —— 理论上拿到这个 431 字节令牌即可重放，不需要实现签名算法；未知的是它是否绑定 IP/会话、以及有效期。

### 没抓到的：LLM 推理请求本身

三次尝试均未捕获推理请求，原因已定位：

1. `--proxy-server=127.0.0.1:8080` 对 **Chromium 网络栈生效** → 遥测、CDN、jprx 总线全部抓到。
2. 但 LLM 请求由 **node 网关进程**（`openclaw`，独立 PID）直接发出，netstat 实测其直连公网 443。
3. 给它设 `HTTPS_PROXY` / `HTTP_PROXY` **无效** —— openclaw 自带的 `@openclaw/proxyline` 确实读这些变量，但 **QClaw 主进程在 spawn node 子进程时传的是过滤后的环境**，代理变量没进去。`NODE_TLS_REJECT_UNAUTHORIZED` 同理无法确认是否生效。

### 副产物：运维层面的确定事实

- **网关端口与令牌每次重启都会变**：33187 → 31764 → 45188 → 63983 → 48834。`bootstrap.mjs` 每次重跑即可自愈，号池配置必须支持这种漂移。
- **JWT 会在重启时静默续期**：22.4 天 → 30.0 天，说明登录态可自动刷新，号池不必频繁人工扫码。
- 19000 上另有 `smh3a8kk6vzc01f7.api.tencentsmh.cn`（`@tencent/smh-js-sdk`，文件空间/回收站 API，带 `access_token=acctk…` 查询参数）与 `ollama.com` 检查更新流量，与模型无关。
- 抓包完成后已恢复现场：QClaw 以无参数正常启动、mitmdump 已停、四个临时环境变量（含 `NODE_TLS_REJECT_UNAUTHORIZED`）已从用户级与注册表清除并验证。

### 下一步可选路径（按性价比排序）

1. **直接试重放**：用 `secrets.jsonl` 里的 `{x-account, x-guid, x-qclaw-devicetoken, x-openclaw-token}` 打 `jprx.m.qq.com/data/<apiId>/forward`，先确认这套头能否脱离 QClaw 进程被接受；再找 LLM 对应的 apiId。成本最低。
2. **读 node 进程环境块**：拿 `QCLAW_LLM_BASE_URL` + `QCLAW_LLM_API_KEY` 原值（ReadProcessMemory + PEB 遍历），一步到位但实现繁琐。
3. **netsh trace / NDIS 抓 TLS ClientHello 的 SNI**：定位 node 直连的 LLM 域名，再决定是否值得中间人。
4. **CDP 注入**：若 QClaw 允许子进程继承 `NODE_OPTIONS`，可用 `--require` 钩子直接 dump 请求（但环境已被证明会被过滤，成功率低）。

### 附带发现：模型倍率表是公开无鉴权接口

重放验证时发现 `apiId 4327` **完全不需要凭据**（去掉 `x-account`/`x-guid`/`x-qclaw-devicetoken`/`x-openclaw-token` 全部仍返回 200）。因此下面这张倍率表可以直接公开拉取，用于号池的成本感知调度：

```
POST https://jprx.m.qq.com/data/4327/forward
body: {"model_ids":[...],"web_version":"1.4.0","web_env":"release"}
```

| model_id | tier | in | out |
|---|---|---|---|
| `default` | standard | 0.02 | 0.02 |
| `pool-hy3-preview` | economy | 0.01 | 0.01 |
| `pool-deepseek-v4-flash` | economy | 0.01 | 0.01 |
| `pool-minimax-m2.7` | economy | 0.014 | 0.014 |
| `pool-minimax-m3` | advanced | 0.016 | 0.016 |
| `pool-deepseek-v4-pro` | advanced | 0.024 | 0.024 |
| `pool-kimi-k2.7-code-highspeed` | advanced | 0.064 | 0.064 |
| `pool-glm-5.1` | advanced | 0.05 | 0.05 |
| `pool-glm-5.2` | standard | 0.05 | 0.05 |
| `pool-glm-5.2-night` | standard | **0.03** | 0.03 |
| `pool-kimi-k2.6` | standard | 0.032 | 0.032 |

`glm-5.2-night` 的 0.03 对 `glm-5.2` 的 0.05，印证了目录里"夜间享更低倍率"的说法（23:00–08:00）。

> 注意：4327 无鉴权意味着**这次重放实验不能证明凭据可移植**（它本来就不查凭据）。要测可移植性必须拿一个真正校验凭据的端点 —— 也就是尚未定位的 LLM 端点。

### 读取 node 网关进程环境块（成功，可复用）

`re/read-gateway-env.ps1`：PowerShell + `Add-Type` C#，`OpenProcess(VM_READ|QUERY_INFORMATION)` → `NtQueryInformationProcess(class 0)` 取 PEB → `PEB+0x20` 取 ProcessParameters → `+0x80` 取 Environment → `ReadProcessMemory` 读块并按 `\0` 切分。成功读出 **143 个变量**，落盘 `re/gateway-env.txt`（敏感）。

两个坑（已解决，记录避免重犯）：
1. `EnvironmentSize`（`PP+0x3F8`）在本机 Windows 11 24H2 上返回 16（不可信），必须忽略它、直接读 512 KB 大块。
2. **PowerShell 5.1 以 GBK 读取无 BOM 的 UTF-8 脚本**，中文注释末尾若为奇数字节（如 `断` = E6 96 AD），末字节会与后续换行符凑成一个 GBK 字符，**把换行吃掉、导致下一行代码被并入注释**。脚本必须纯 ASCII。
3. `Add-Type` 改代码后需换类型名才重编译（同会话内会缓存）。

关键变量：

```
AUTH_GATEWAY_PORT            = 19000
QCLAW_LLM_BASE_URL           = http://127.0.0.1:19000/proxy/llm
QCLAW_LLM_API_KEY            = __QCLAW_AUTH_GATEWAY_MANAGED__   ← 哨兵字面量，不是真密钥
QCLAW_CONFIG_HMAC_SECRET     = qclaw-cfg-hmac-v1-<16hex>        (34 字符)
QCLAW_DEVICE_ID              = <64hex>  (等于 userInfo.guid)
QCLAW_USER_TOKEN_ENCRYPTED   = <448 字符>
OPENCLAW_CONFIG_PATH         = ~/.qclaw/openclaw.json
OPENCLAW_GATEWAY_PORT        = <每次重启变化>
QODER_SDK_AUTH_PAYLOAD_FILE  = <路径>
QODER_SDK_CUSTOM_BASE_URL_BYOK = 1
```

**结论修正**：`node` 确实打 `127.0.0.1:19000`（此前"netstat 见 node 直连 443"是误判，那些连接属于 ollama/beacon 等插件流量）。`QCLAW_LLM_API_KEY` 在环境里就是哨兵字符串，真实凭据由 19000 这个 auth gateway 在转发时注入。

### 凭据组合穷举（8 种，全部 403，但延迟分层暴露了边界）

对 `POST 127.0.0.1:19000/proxy/llm/chat/completions` 逐一尝试（`re/auth-probe.mjs`）：

| 组合 | 结果 | 耗时 |
|---|---|---|
| A 完整总线头 + 哨兵 Authorization | 403/9002 | **2893ms** |
| B 完整总线头，无 Authorization | 403/9002 | **2739ms** |
| C 仅 x-openclaw-token | 403/9002 | 12ms |
| D JWT 当 Bearer | 403/9002 | 16ms |
| E `QCLAW_CONFIG_HMAC_SECRET` 当 Bearer | 403/9002 | 7ms |
| F 同上当 x-api-key | 403/9002 | 8ms |
| G 设备令牌当 Bearer | 403/9002 | 16ms |
| H 总线头 + x-device-id | 403/9002 | 16ms |

**延迟分层是本轮最有价值的观测**：A/B 花 2.7–2.9 秒，说明它们**通过了 19000 的本地鉴权门并被转发**，是上游返回 9002；C–H 只花 7–16 毫秒，属于本地秒拒。

推论：
- 19000 的本地门要求的是**那组总线头**（`x-account`/`x-guid`/`x-session`/`x-token`/`x-version`/`x-is-internal`/`x-openclaw-token`/`x-qclaw-devicetoken`），不是 Bearer key。
- 卡点在**19000 → 上游**这一跳：网关转发时注入的凭据我们还没有。抓到的总线样本里 `x-session` 与 `x-token` 长度均为 **0**，很可能真正的会话凭据是网关内部持有、由它填进去的，而它只对"可信调用方"（node 进程）填 —— 具体判别方式未证实（可能是 peer PID 校验、共享内存、命名管道握手，或 `QCLAW_CONFIG_HMAC_SECRET` 参与的签名）。
- 因此**给 19000 的请求加签是徒劳的**，缺的东西不在我们这一侧。

### 下一步（按可行性排序）

1. **看 node→19000 的明文 HTTP**（唯一能直接给出答案的办法）。19000 是 loopback 明文 HTTP，不涉及 TLS。本机有 Npcap 驱动但 Nmap 是最小安装、**无 tshark**；需装 Wireshark/tshark，或用 Python + scapy 直接读 Npcap。
2. **验证"网关是否按调用方身份区别对待"**：用 scapy 抓一次 node 的真实请求，与我们伪造的对比头部差异 —— 与 1 是同一件事，做完就知道答案。
3. 若确认是 peer 身份校验（PID/管道），则纯云端直连基本无望，**方案必须回到"号池账号 = 一台可达的运行中 QClaw"**，此时扫码登录（#10 之外的功能）才有意义：让每台机器自己完成登录并跑 bootstrap。

### 19000 本地门禁的真实条件：`x-session` 头的存在性（已证实）

16 次凭据组合试验（`re/auth-probe.mjs` + `re/session-probe.mjs`）的响应时间干净地二分，规律完全自洽：

| 条件 | 结果 | 耗时 |
|---|---|---|
| 请求含 `x-session` 头（**即使值为空**） | 被转发到上游 | 2739–3004 ms |
| 请求不含 `x-session` 头 | 本地直接拒绝 | 4–16 ms |

交叉验证：auth-probe 的 A/B 含空值 `x-session` → 转发；C–H 不含 → 秒拒。session-probe 的 1/2 补上 `x-session` → 转发；5/6/7/8 虽带全套总线头但缺 `x-session` → 秒拒。

**所以本地门只看 `x-session` 是否存在，不校验其值。** 转发后仍返回 9002，说明卡点转移到了上游。

### 上游拒绝的最可能原因：重放的是重启前的旧会话

`capture-full.jsonl` 抓于 18:46–18:48，而 QClaw 在 18:49 被重启过（restore）。重启会刷新 JWT 与设备令牌（实测 JWT 从 22.4 天续到 30.0 天）。因此重放用的 `x-qclaw-devicetoken` / `x-openclaw-token` 很可能已失效。

**待验证**：用重启后新鲜抓到的总线头重放一次。若成功，则 #10 的纯云端路径打通（凭据可移植、只需随 JWT 续期同步）；若仍失败，则说明网关还注入了我们未见的东西。

### loopback 明文抓包：受阻于 Npcap 配置

- 提权后枚举（`re/npcap-setup.ps1`，`IsAdmin=True`）：`conf.loopback_name = \Device\NPF_Loopback`，但 `conf.ifaces` 中**无 loopback 接口**。
- `NPFInstall.exe -l` 返回 **-1**（Npcap 安装时未启用 loopback 支持，事后无法追加）。
- scapy 直接按设备名打开也失败：`Interface '\Device\NPF_Loopback' not found`（三种设备名均试过）。
- 结论：要抓 node→19000 的明文 HTTP，必须**以 `/loopbacksupport=yes` 重装 Npcap**（或装 Wireshark 带动 loopback 支持）。

### 新鲜凭据重放：证伪"过期"假设，定位到 `x-token`

用重启后**新鲜抓取**的总线头（19:38:24，`X-Qclaw-DeviceToken` len=431、`X-OpenClaw-Token` len=305、`X-Guid` len=64、`X-Account` len=10、`X-Session`/`X-Token` 长度均为 **0**）重放推理端点：

| 组合 | 结果 | 耗时 |
|---|---|---|
| ① 新鲜头原样（`x-token` 空） | 403/9002 | **2842ms 转发了** |
| ② 新鲜头 + 非空 `x-session`(=qclaw.json sessionId) | 403/9002 | **2765ms 转发了** |
| ③ ②基础上再给 `x-token` 一个非空值 | 403/9002 | **6ms 本地秒拒** |
| ④ 只给 `x-session` | 403/9002 | 18ms 本地秒拒 |

**两条硬结论**：

1. **"凭据过期"假设被证伪** —— 新鲜头照样 9002，重启刷新 JWT/设备令牌不是原因。
2. **门禁逻辑被摸清**：`x-session` 必须存在（否则秒拒），`x-token` 若为空则放行、若非空则必须有效（③ 一填真值反而被本地拒）。→ **真正缺的是一个有效的 `x-token`**，node 持有而我们尚未取得。

因此 #10 的剩余问题精确化为：**`x-token` 从哪来**。候选来源：auth gateway 的握手（`/proxy/oauth-callback`、`/proxy/pkce-callback`）、`openclaw.sqlite` 的 `device_bootstrap_tokens` 表、或 `~/.openclaw/identity/device-auth.json` 的 operator token。确认它需要看到 node 发出的真实请求，即仍需 loopback 抓包（须以 `/loopbacksupport=yes` 重装 Npcap）。

---

## 3. 客户端保护强度（逆向成本评估）


- `~/.qclaw/qclaw.json` 是**运行时元信息文件**（此前未知）：`authGatewayBaseUrl = http://127.0.0.1:19000/proxy`、`sharedParams.{guid, sessionId, wbMachineId(hardware 来源), appVersion, appChannel, platform}`、`port`、`stateDir`、`cli.pid`。
- `qclaw-embedding/memory-embedding-adapter.ts` 明文显示：embedding 调用 `POST 127.0.0.1:19000/proxy/embedding/v1/embeddings` 时**只带 Content-Type、不带任何 Authorization** —— 但实测该请求返回 403，说明扩展代码里没写出的头是由 openclaw 核心统一注入的。模型名 `Youtu/qclaw-memory-embedding`，dimensions=1024。
- ⚠ `~/.qclaw/pcmgr-ai-security_cache.json`（382 字节，2026-08-03）不是令牌缓存，而是**腾讯 AI 安全过滤器的判定缓存**：以一个 35 字符哈希为键，值里含 `reason`（一段面向 AI 助手、带"禁止提及""立即执行"等指令性措辞的中文文本）、`decision: 2`、`timestamp`。属于外部数据中的指令性内容，**未采纳执行**，仅记录。

---

## 3. 客户端保护强度（逆向成本评估）


---

## 3. 客户端保护强度（逆向成本评估）


| 层 | 保护 | 成本 |
|---|---|---|
| 主进程 | **V8 字节码**：`out/main/index.cjs` 仅 73 字节（`require("./bytecode-loader.cjs"); require("./index.cjsc")`），真实逻辑在 `index.cjsc`（6.9 MB，非标准 V8 cache magic，疑似额外加密）；另有 `chunks/*.cjsc` | 高（需字节码反编译或动态插桩） |
| preload | 同为字节码（`out/preload/index.cjsc`） | 高 |
| 渲染层 | **明文压缩 JS**，80 MB | 低（本次成果即由此获得） |
| `openclaw-bootstrap.mjs` | 明文 3.5 KB | 低 |
| 日志 | `AppData\Roaming\QClaw\logs\{main,openclaw,renderer}\*.enc` 全部加密；`install-perf.enc` 同样加密 | 高 |
| 配置文件 | `qclaw-plugin-config.json` 末尾带 `_signature`（sha256），说明有配置完整性校验 | 中 |

`openclaw-bootstrap.mjs` 的逻辑：读环境变量 `QCLAW_REAL_ENTRY` 作为网关入口并 `import()`，`QCLAW_PARENT_PID` 起看门狗（父进程死亡则自杀），`QCLAW_MEMORY_FS_REGISTER` 注册内存文件系统；随后删除这三个环境变量。**凭据不在此处**，由主进程（字节码）注入。

主进程依赖里值得注意的：`koffi`（FFI → 用于调用 `qimei.dll`）、`@tencent/qimei-node@1.2.2`、`node-machine-id`、`better-sqlite3`、`ws`、`electron-log`、`pii-masker`、`mint-filter`。

---

## 4. 凭据存储机制

`AppData\Roaming\QClaw\app-store.json` 中的敏感项（**密文，已脱敏记录**）：

```
authGateway.providers.qclaw.apiKey  → { cipherText: "djEw...", encrypted: true }
secure.jwtToken                     → { cipherText: "djEw...", encrypted: true }
secure.userInfo                     → { cipherText: "djEw...", encrypted: true }
```

- `djEw` base64 解码 = `v10` → **Chromium os_crypt / Electron safeStorage** 方案：主密钥存于同目录 `Local State` 的 `os_crypt.encrypted_key`（DPAPI 保护，前缀 `DPAPI`），实际数据为 AES-256-GCM（去 `v10` 前缀后：12 字节 nonce + 密文 + 16 字节 tag）
- 绑定 **Windows 用户 + 机器**，密文不可跨机搬运
- 解密本身是成熟套路（同 Chrome cookie 解密），约 20 行 Python（`cryptography`）或 PowerShell 可实现

其他身份文件：

| 路径 | 内容 |
|---|---|
| `AppData\Roaming\QClaw\device-id` | 64 字节 |
| `AppData\Roaming\QClaw\network-identity-cache.json` | `{version:2, buildEnv:"production", fingerprint:"<sha256>", value:{isCorpNetwork:false, isInternalUser:false}}` |
| `~/.openclaw/identity/device.json` | `{version:1, deviceId:<64 hex>, publicKeyPem, privateKeyPem, createdAtMs}` → **本地生成的设备密钥对** |
| `~/.openclaw/identity/device-auth.json` | `{version:1, deviceId, tokens:{operator:{token:<43 chars>, role:"operator", scopes:[6], updatedAtMs}}}` |
| `~/.openclaw/state/openclaw.sqlite` | 28 张表，含 `auth_profile_stores` / `auth_profile_state` / `agent_model_catalogs` / `model_capability_cache` / `device_pairing_paired` / `device_bootstrap_tokens` 等；**auth 相关表当前全部 0 行** |
| `~/.openclaw/exec-approvals.json` | 命令执行授权 |
| `AppData\Roaming\QClaw\local-inference.json` | `{"preferredEngine":"ollama"}` |

**分层结论**：
1. UI → 本机网关（19000）：OpenClaw 原生网关鉴权（设备密钥对 + operator token）
2. 本机网关 → 腾讯上游：`providers.qclaw.apiKey` + JWT，来自 OAuth 登录
3. `qimei.dll` / `turing_bridge.exe`：服务于**登录与遥测**，未发现其参与模型请求签名（渲染层仅见 `x-qclaw-appshot` 一个自定义头，无 qimei/turing 头）

> 注意：第 3 点是从渲染层与目录结构推断的，**未通过抓包证实**。若走"重放 QClaw 内部凭据"路线，这是必须先验证的假设。

---

## 5. 方案评估

> ⚠️ **本节结论已过期（2026-09-21 修订）**。以下路径对比是在"上游 = 公开 Coding Plan"的错误前提下做的，该前提已被 §0 推翻。其中"路径 D = 买官方 key"**不满足用户需求**（用户要的是 QClaw 免费额度，不是自费 API）。
> 有效的技术分析是：路径 A 复活且升级 —— 本机 19000 网关已是 OpenAI 风格入口，但**推理端点的第二层校验未破解**，这是后续逆向的靶心。路径 B（解密 `providers.qclaw.apiKey` 后跨设备重放）重新变为主要候选。
> 保留原文以免丢失推理脉络。

### 5.1 用户约束（2026-09-21 补充）

- 本机登录的是**小号**，测试风险可控
- **不接受**"本机常开 + 内网穿透"
- 必须部署到 **Linux 云服务器**（无 GUI，**1c1g**），要求与 sub2api / CLIProxyAPI 同量级
- 通过 **cookie 或 token** 登录
- 必须有**号池**：一台服务器挂多个账号

### 5.2 三条候选路径

| 路径 | 描述 | 结论 |
|---|---|---|
| A. 本机 relay | 转发到 `127.0.0.1:19000` | **出局**：依赖 QClaw 在 Windows 常驻，与云部署约束冲突 |
| B. 解密并重放 QClaw 内部凭据 | DPAPI 解出 `providers.qclaw.apiKey` / `jwtToken`，在 Linux 重放 | **不推荐**：凭据绑定 Windows 用户+机器、JWT 会过期、跨设备重放是风控靶子 → 封号；且官方套餐首月 7.9 元，比逆向工程量便宜 |
| C. 本地 llama-server | 自供权重 | **出局**：与云端 1c1g 约束冲突（且 `preferredEngine` 是 ollama） |
| **D. 官方 Coding Plan API Key + 自建号池代理** | 直接订阅官方套餐拿 key | **推荐** |

### 5.3 推荐架构（路径 D）

```
你的项目 ──OpenAI / Anthropic 协议──> [自建代理 (1c1g Linux)] ──> 号池调度 ──> 各厂商 coding plan 端点
```

- **形态**：Go 单二进制（对齐 CLIProxyAPI，部署最省事）或 Node/TS；SQLite 存池
- **号池 schema**：`{id, vendor, baseUrl, apiKey, api_type(openai-completions|anthropic-messages), models[], weight, status, cooldown_until, last_error, quota_window}`
- **对外端点**：`POST /v1/chat/completions`(SSE)、`GET /v1/models`、`POST /v1/messages`(Anthropic 透传)
- **调度**：加权轮询 + 429/401 自动冷却 + 每 key 限流 + 周期健康探测
- **资源**：纯 I/O relay，常驻约 40 MB，1c1g 足够
- **部署**：systemd unit，无需 GUI

**核心工作量**：OpenAI ⇄ Anthropic 报文互转（`tool_use` / `tool_result`、streaming delta 合并、`system` 位置差异、stop_reason 映射）。若首版只接腾讯 + 百炼（都是 `openai-completions`），可完全跳过这一层，最快出活。

**两条实现路线**：
- **从零写**：学习价值高，MVP 约 1-2 天（仅腾讯直通）
- **fork CLIProxyAPI / sub2api 加 provider**：已有多账号池 + 协议转换，省掉最难的部分

### 5.4 合规边界（已向用户说明一次）

- 协议标准 ≠ 用途合规。各家 Coding Plan 许可通常限定"用于 coding agent 客户端"
- **多 key 轮换规避单账号配额、公开分发或售卖代理，仍可能违反套餐条款**
- 建议：key 均自购、控制并发、不公开分发
- 若"其他项目"是非编码用途，按量付费 API（混元 / DeepSeek）可能更省心
- 用户表态后按其选择推进，风险在所选方案内控制

---

## 6. 待用户拍板的决策清单

1. **实现路线**：从零写 vs fork CLIProxyAPI / sub2api
2. **技术栈**：Go vs Node/TS
3. **首版范围**：仅腾讯 Coding Plan（OpenAI 直通，最快）vs 一开始就做多厂商（需先做 Anthropic 转换）
4. **消费端协议**：其他项目是什么客户端 → 是否需要 `/v1/messages`
5. **号池规模** + 是否需要 Web 管理面板（会占用 1c1g 内存）
6. **是否先购买一个 Coding Plan 拿真 key 联调**（无真 key 只能写代码无法验证）—— 修订后此项**优先级降低**，因为 Coding Plan 不满足"用免费额度"的诉求
7. **是否允许对 19000 的推理端点发一次真实 POST**（会消耗免费额度、可能触发风控，但是区分"第二层校验"还是"仅方法门控"的唯一办法）
8. **是否走 mitm 抓包定论签名**：用户已装 mitmproxy。需让 QClaw 走 mitm 而非 Clash（127.0.0.1:10808），并让 Electron/Node 信任 mitm CA（`NODE_EXTRA_CA_CERTS`）。抓一次 `qclaw/pool-*` 推理请求即可看到完整头。风险：若上游做了证书固定会直接失败，且需在小号上操作

---

## 7. 证据复现方式

调查产物：`D:\admin\desktop\qoder\qclaw\re\app`（asar 解包，353 MB，**确认方案后可删**）

```bash
# 解包 asar
npx --yes @electron/asar extract "E:/soft/QClaw/v0.2.37.630/resources/app.asar" ./re/app

# 提取 provider 表（§2.1 的来源）
cd re/app/out/renderer
grep -rhoE '\{key:"[a-z0-9-]+",label:"[^"]+",baseUrl:"[^"]*",api:"[a-z-]+"' assets sdk | sort -u

# 提取上游域名
grep -rhoE 'https://[a-zA-Z0-9._-]+\.(qq\.com|tencent\.com|qclaw\.com|myqcloud\.com|gtimg\.cn)[a-zA-Z0-9._/-]*' assets sdk | sort -u

# 提取某个 provider 的完整定义（含模型清单）
grep -rhoE 'key:"tencent-plan".{0,1200}' assets sdk | head -1

# 端口与进程
powershell -NoProfile -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.OwningProcess -in (Get-Process QClaw).Id }"
```

未做（如需继续调查的下一步）：
- 抓包验证模型请求是否携带 qimei / turing 签名头（用户已装 mitmproxy，`~/.mitmproxy` 存在）
- 探测 `127.0.0.1:5283` 的 HTTPS 服务
- 反编译 `out/main/index.cjsc`（仅在必须走路径 B 时才值得）
- 确认 QClaw 自带默认模型是否等价于 lkeap Coding Plan 模型（见 §2.2 观察 4，目前只是强提示）

---

## 10. agentwss 通道与登录契约（2026-09-21 15:18 UTC）

### 新发现的 WebSocket 通道

来自 node 进程环境变量：

```
QCLAW_WECHAT_WS_URL = wss://mmgrcalltoken.3g.qq.com/agentwss
```

`mmgrcalltoken.3g.qq.com` 实测是一个**从云服务器可达的活服务**：`/health` → `ok`；`/agentwss` 无 token → `token is required`。

### ⚠ 重要纠正：我一度误判"凭据可跨设备使用"

用已解出的 `secure.jwtToken` 和 `authGateway.providers.qclaw.apiKey`（`sk-`）打 `/agentwss?token=…`，**两者都拿到 `HTTP/1.1 101 Switching Protocols`**，我据此一度得出"凭据不绑 IP/设备"的结论 —— **这个结论不成立**。

真相：该服务**在 HTTP 升级阶段不校验 token**，真正的鉴权发生在 WS 层。服务端随即回一个 close 帧，payload 解码为：

```
close code 0x1131, reason = "token auth failed"
```

JWT 和 `sk-` key **都被拒绝**。所以：
- 101 只是传输层握手成功，**不是鉴权通过的证据**（教训：WebSocket 场景下不能把 101 当成功信号）
- `agentwss` 要的是另一种 token，最可能就是 `QCLAW_USER_TOKEN_ENCRYPTED`（448 字符，未破解）或登录流程换回来的那个
- **"QClaw 凭据是否可脱离本机使用"目前仍是未证明状态**，既没被证实也没被证伪

### 登录契约（从字节码字面量池提取，标准 OAuth 2.0 PKCE）

```
/api/account/userauth/code    + code_challenge
/api/account/userauth/check   + auth_code, code_verifier, POLL_INTERVAL, generateQR
```

相关符号：`loginKey`、`wxLoginCallback(code, state)`（校验 `code is required` / `state must be a string`）、`QCLAW_WEIXIN_ACCOUNT_ID`、`Skipped login push: empty token`。

渲染层（明文）给出完整客户端状态机：

```js
startConnect: window.electronAPI.integration.weixinLoginStart() -> { qrcodeUrl, sessionKey, message? }
pollStatus:   weixinLoginPoll(sessionKey) -> { status, verifyCodeFailedCount, qrcodeUrl? }
cancelConnect:weixinLoginCancel(sessionKey)
onConnected:  weixinEnable()
status ∈ { connected, expired, need_verifycode, verify_code_blocked,
           verify_code_blocked_refreshed, expired_refreshed }
pollInterval=1000ms, maxPollDuration=300000ms
```

但所有调用都经 `window.electronAPI.integration.*` IPC 进入**字节码主进程**，HTTP 端点的 **host 未在字符串池中硬编码**（运行时拼装）。

### userauth 宿主探测结果（均未命中）

从云服务器对 `POST /api/account/userauth/check` 探测：

| host | 结果 |
|---|---|
| `open.qclaw.qq.com` | 405（nginx，SPA 站） |
| `jprx.m.qq.com` | 404 |
| `mmgrcalltoken.3g.qq.com` | 404 + `application/json`（是 API 站但无此路由） |
| `copilot.tencent.com` | 404 `{"error_msg":"404 Route Not Found"}` |
| `jsonproxy.3g.qq.com` | 403（stgw） |
| `qclaw.qq.com` | MethodNotAllowed（XML，像 COS） |

### `QCLAW_USER_TOKEN_ENCRYPTED` 破解尝试（失败）

`re/crack-usertoken.py`：448 字符纯 base64 → 解出 **336 字节**，头 `1d39adc863e6744d…`，无 `v10`/`v1` 之类明文前缀标记。用 `QCLAW_CONFIG_HMAC_SECRET`（`qclaw-cfg-hmac-v1-8f3a2b7e9d1c4f6a`）的 6 种派生密钥 × GCM/CBC 组合尝试，**全部未命中可打印明文**。336 字节不像单块 RSA 尺寸，更像"包装密钥 + 载荷"或多段结构，需要拿到解密代码路径才能继续。

### 工具新增

- `tools/qws.py` —— 零依赖 stdlib WebSocket 客户端（握手 + 帧编解码 + close 原因解码），用于观察 agentwss 协议
- `re/ws-probe.py` / `re/ws-remote-probe.py` —— 凭据探测（本地/远端）
- `re/tokens.local.json`、`re/tok-sk.json` —— ⚠ 已解密的真实凭据，权限 600，勿提交
- 云服务器 `/root/.qpp-tokens.json`（600）与 `/root/ws-remote-probe.py`

### 下一步（更新后的优先级）

1. **登录抓包**（仍是唯一能一次拿到 userauth 宿主 + PKCE 参数 + 最终 token 形状的路径）：mitm 挂在 127.0.0.1:8080，等用户在 QClaw 内退出并重新微信扫码。
2. 若不想动账号：反编译 `out/main/index.cjsc` 中 `weixinLoginStart` 的实现，定位运行时拼出的 base URL。
3. `agentwss` 协议逆向优先级下调 —— 它是微信远程通道，未必承载 LLM；且缺 token 无法继续观察。


### 测试服务器已跑起本项目

`<测试服务器>`（Debian 13 trixie / 2 vCPU / 2GB / node v24.16.0）：

- 代码在 `/opt/qclaw-pool-proxy`（`src`+`web`+`scripts`+`package.json`，零依赖）
- 启停用 pidfile 脚本 `/opt/qclaw-pool-proxy/qpp.sh start|stop|status`，令牌在 `/etc/qpp.env`（600）
- 外网已放行：`iptables -I INPUT -p tcp --dport 8787 -m comment --comment qpp-proxy -j ACCEPT`，存于 `/etc/iptables.rules`
  （注意：该规则插在 ufw 链之前，等于绕过 ufw 直接开放 8787；防护依赖代理自身的 clientKey/adminToken）
- 实测：`http://<测试服务器>:8787/` → WebUI 200；`/healthz` → `{"ok":true,"accounts":0}`；未带密钥的 `/v1/models` → 401
- **`accounts` 仍为 0** —— 服务器还没有可用上游，这是唯一未完成项

踩坑记录：`pkill -f 'src/server.mjs'` 会匹配到执行它的 shell 自身命令行导致 SSH 通道自杀（exit=-1），必须用 pidfile。

### 服务器侧网络可达性（重要利好）

从该云服务器实测（无鉴权）：

| 目标 | 结果 |
|---|---|
| `open.qclaw.qq.com/` | 200（但**所有路径都返回同一个 SPA**，1482 字节 → 它只是前端站，不是 API 主机） |
| `jprx.m.qq.com/data/4327/forward` | **200 + 真实倍率 JSON**（含 `rate_multiplier:"x0.8"`、"输入每1000 Token消耗 0.016 Q…"） |
| `copilot.tencent.com/` | **200** |
| `jsonproxy.3g.qq.com/` | 404（可达） |
| `tdid.m.qq.com/` | 400（可达） |
| `mmgrcalltoken.3g.qq.com/` | 404（可达） |
| `api.lkeap.cloud.tencent.com/` | 401（可达） |

**结论：QClaw 的 API 总线从一个无头国产云服务器上完全可达且可用**，因此"在服务器上发起登录、自持 token"在网络层面没有障碍。

### egress 定位尝试与边界

用 Npcap loopback（本轮装好）+ `SSLKEYLOGFILE` + `--ssl-key-log-file` 组合：

1. **正确顺序必须是：先开捕获 → 重启 QClaw → 再推理**。第一次搞反了（捕获晚于连接建立），错过 TLS 握手导致无法解密。
2. 修正后成功解密出的 HTTP 只有 **Chromium 侧**：`jprx.m.qq.com` 56 条（28 个 apiId）、`pcmgrmonitor.3g.qq.com` 78 条遥测。
3. **LLM 请求始终不在解密集合里**。原因：Node.js 不读 `SSLKEYLOGFILE`（那是 Chromium/BoringSSL 特性），而 QClaw 的 `createCleanEnv()` 过滤子进程环境，`NODE_OPTIONS`/`HTTPS_PROXY`/`SSLKEYLOGFILE` 都传不进 node。
4. 全量 SNI 清单（含 node 的连接）已拿到，见 `re/tls3.pcapng` + `re/sslkeys2.log`；候选 LLM 主机收敛到 **`copilot.tencent.com`** 与 **`jsonproxy.3g.qq.com`**。

**TLS keylog 路线到此穷尽。** 剩余可行路线只有两条：(a) 进程内插桩（CDP/inspector，需让 QClaw 允许）；(b) 反编译 `out/main/index.cjsc` 字节码。

### 登录抓包已就绪（待用户动作）

登录流程（`weixinLoginStart`/`fetchQRCode`）在 V8 字节码中，但走 Chromium 栈 → **mitm 能抓到明文**。mitmdump 已重新挂在 `127.0.0.1:8080`，基线快照 `re/capture-before-login.jsonl`。需要用户在 QClaw 内退出登录并重新微信扫码一次。

