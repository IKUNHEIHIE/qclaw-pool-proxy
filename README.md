# qclaw-pool-proxy

把 QClaw 的免费额度模型（`qclaw/pool-*`）暴露成标准 **OpenAI + Anthropic** 兼容端点，
带**账号池**、自动故障转移与冷却，单进程零依赖，跑在 1c1g Linux 上。

```
你的项目 ──/v1/chat/completions 或 /v1/messages──> 本代理 ──号池调度──> N 个 QClaw 网关
```

## 已验证状态（2026-09-22，本机 + 云服务器双端实测，**号池 3 个真实账号**）

### 两层测试，别把结论混着用

```bash
npm test                                              # 184 项断言：离线、零凭据、不花积分 —— 这是回归门禁
BASE=http://<host>:8787 npm run verify:live -- <vk-…> <admin-…>   # 同一支脚本换打真号池：验"腾讯今天还认我们"
```

`npm test` 串行跑五个套件：`respond-test`（28 项，报文转换）、`pool-priority-test`（11 项，号池调用优先级）、
`admin-guard-test`（7 项，来源闸）、`login-e2e`（51 项，扫码链路，需本机有 Chrome/Edge）、
`verify.mjs --self`（87 项，自桩代理实例，含 WebUI 构建产物检查）。live 实测 85 项（少的 2 项是自桩专属守卫）。

`--self` 的桩在 `scripts/harness.mjs`：假 jprx 总线 + 假 aizone 推理上游 + 假登录页，外加一份落在
`os.tmpdir()` 的一次性配置（里面的 `sk-`/JWT **全是本机现造的假值**，跑完即删）。桩按实测契约回答：
从不返回 `usage`、思考只有开关有效、登录态失效是 `HTTP 200 + {"common":{"code":21004}}`、
参数写错是 `400 + error.type=proxy_param_error`，并且对 4050/4026 **独立重算一遍 HMAC**
（不复用 `webSignHeaders`，否则那条断言就是自证）。所以它证明的是"我们自己的解析、归一、
调度、限额逻辑自洽"，且每次结果确定（真上游有 1~2% 抖动，模型有时不调工具）。

它**不**证明腾讯那条链路今天还活着 —— 那个结论只有 `verify:live` 能给，所以故意不把 live 并进默认测试：
把 live 混进来，迟早会有人把"测试绿了"读成"上游认我们"，而 `21004` 那次误判就是这么来的。
反过来，`--self` 里两条守卫断言专门防止"以为在跑桩其实打了真服务"（核对桩被踩到的次数与账号 id）。

跑法记录：桩改坏一次就红一次 —— 把签名算法换成 `sha1`，只有「扫码的 state 来自 4050 签发」红；
把 4110 的 `balance` 读成别的字段，只有两条积分一致性断言红。反过来把 `reasoning_effort='none'`
删掉不会红，因为 `thinking:{type:'disabled'}` 仍在工作（实测上游两个信号都认），那是等价变异。
顺带被这套门禁抓到的真问题：本机那个常驻实例起于 19:50，而 `stateHow` 日志 21:41 才加，
于是 live 跑它时新断言直接报 FAIL —— **常驻进程跑旧代码**这种情况以前只能靠想起来。

| 能力 | 结果 |
|---|---|
| `/v1/models` | 11 个 `qclaw/*` 模型，含真实名称 |
| OpenAI 非流式 | 200，真实返回「收到」，响应 `model` 回显所选模型 |
| OpenAI 流式 SSE | 分片 + `[DONE]` 正常 |
| Anthropic `/v1/messages` 非流式 | 200，`stop_reason=end_turn` |
| Anthropic 流式 | 完整 `message_start → content_block_delta → message_stop` 事件序列 |
| 客户端/管理令牌错误 | 均 401 拒绝 |
| 未知模型名 | 干净 404，绝不 5xx |
| 客户端密钥自助生成/删除 | 新密钥立即可用，删除后立即 401 |
| 扫码登录会话 | 可发起（无头浏览器出二维码）/ 未知会话 404 |
| 坏号处理 | 定向打坏号 → 401 判定为鉴权故障并冷却 89s；池里有坏号时正常请求仍 200 |
| 多账号轮询 | 同一密钥的连续请求命中 3 个不同账号；带 `user` 的同一会话固定同一账号 |
| 额度信息 | 直连账号带 4708 试用/购买额度（注意：免费池不走该口径，故只报数字不作可用性判断） |
| 凭据不外泄 | `/admin/state` 快照中不含任何 `sk-`/JWT 原文；`config.json` 写盘强制 `0600` |
| **密钥级速率限制** | 超 `rpm` 立即 `429` 并带 `retry-after` |
| **密钥级日配额** | 超 `dailyRequests` 返回 `429 insufficient_quota`（UTC 日切） |
| **密钥模型白名单** | 越权模型 `403`；`/v1/models` 只返回白名单内的模型 |
| **停用 / 过期 / 轮换** | 停用 `403`、重新启用恢复；轮换后旧密钥立刻 `401` |
| **按密钥计量** | 请求数、失败数、token 估算、最近使用时间逐密钥累计并持久化 |
| **请求日志** | `/admin/log` 返回最近 500 条对外请求（密钥/模型/账号/状态/耗时/token） |
| **CORS** | 预检 `204` + `access-control-allow-*`，浏览器可直连 |
| WebUI | 概览 / 密钥 / 号池 / 对话 / 日志 / 接入 六个视图，真实链路流式对话实测通过 |
| 加号入口 | 推送命令展示、批量 JSON 导入、扫码登录、手动表单四种都在位 |
| **密钥复制（非 HTTPS）** | `isSecureContext:false` 且 `navigator.clipboard` 不存在时 `execCommand` 兜底成功；再失败弹已全选的可复制层 |
| **密钥明文可见** | 「显示明文」逐行展开完整 `vk-…`（默认掩码，只影响浏览器渲染） |
| **积分余额(4110)** | 每号显示「N 分 · 已用 %」+ 用量条 + 活动/订阅/积分包三档；明细悬停出每笔赠送与到期日 |
| **今日 token(4075)** | 单列显示日用量 / 日额度 + `rpm_limit`，与积分分列（两回事） |
| **模型能力与倍率** | `/v1/models` 与号池模型页带 `capabilities`（深度思考/图片输入）、`canThink`、`creditRate`（4327 积分倍率） |
| **工具调用** | 三个入口实测 `tool_calls` / `tool_use` / `function_call` 全通；`role:"tool"` 回传可续写 |
| **思考开关** | `reasoning_effort:"none"` / `thinking:{type:"disabled"}` / Responses `reasoning.effort` 任一种都能关掉思考；档位与 `budget_tokens` 上游无效（已实测，不假装支持） |
| **参数错误不瘫痪号池** | 客户端坏参数 → 干净 400 `client_param`，账号不进冷却；对外错误体不回显账号 id |
| **账号身份 unionid** | 每行显示「微信 昵称 · unionid …后6位」，并持久化进 `config.json` |
| **同一微信号重复上号** | 第二次 upsert 返回 `reused=<已有id>` 并就地换凭据，池里该 unionid 仍只有一条 |
| **`/v1/responses`** | 非流式返回 `response` 对象；流式重放 `created→in_progress→output_text.delta→…→completed`；支持 `input` 数组与 `instructions`；有状态字段明确 400；受同一套白名单/限流约束 |
| **非 ASCII 账号 id** | 管理端点已解码路径段（此前中文 id 删除会 404、留在池里删不掉） |

调度语义（重要）：**粘性按会话、不按密钥**。`stickyKey` 取请求体的 `user`
（Anthropic 侧为 `metadata.user_id`）或 `x-qclaw-session` 头；都没有就走加权轮询。
早先按 `clientKey` 固定会让"一个密钥永远只用一个号"，号池对单用户形同虚设 —— 已修正。
每次响应带回 `x-qclaw-account` 头，指明这次是哪个账号服务的。

**账号能不能接某个模型**只看两样：显式 `models`，否则看已加载的目录；**两者都没有就不接**（不是"什么都能接"）。
所以往 `config.json` 里手加账号时要么带上 `models`，要么走 `POST /admin/accounts/upsert`
（它会立刻刷一次目录，且写盘前校验，非法账号返回 400 而不是把服务拖进启动期崩溃循环）。
`x-qclaw-account` 只能指向**已启用、不在冷却、且确实服务该模型**的账号，否则 403/404 —— 冷却是保护账号与免费额度的机制，不允许被外部请求绕过。

`node scripts/models-sweep.mjs <base> <clientKey>` → **11/11 模型**均返回非空正文且模型名回显正确。

直连模式单次延迟 **1–4 秒**（旧的 gateway 回连模式为 15–17 秒）。

## 已知限制

1. **推理令牌有 30 天寿命。** `qclaw-aizone` 账号靠登录 JWT（`X-OpenClaw-Token`）过鉴权，
   JWT 30 天到期；号池页会显示"至 YYYY-MM-DD（剩 Nd）"。到期后上游返回
   `common.code 21004`，该账号进入 `cooldownAuthFailSeconds` 冷却并自动换号 —— 需要重新登录补号。
2. **`max_tokens` 要给够，且思考只能开关不能调档。** `pool-*` 多为推理模型，思考内容走 `reasoning_content`；
   预算小时会被思考吃满，正文返回空串且 `finish_reason=length`（对话面板会明确提示这一点）。
   带不动档位（`low/medium/high`、`budget_tokens` 上游都不生效，见「上号身份、积分、思考与工具」），
   只能 `"reasoning_effort":"none"` 整体关掉思考来省预算与积分。
3. **gateway 模式的模型选择仍是假的。** 它按 `openclaw/<agentId>` 路由，需要在
   `~/.qclaw/openclaw.json` 给每个 agent 绑定 `model.primary` 后回填 `modelAgents`；
   且 `gateway.port` 每次重启都会变。直连模式没有这两个问题，因此是默认推荐。
4. **号池仍是"同区单点"。** 多账号会一起命中上游的按账号限流；跨地域/多出口需要自行前置。

## 安装与运行

零依赖，只需 Node ≥ 20。

```bash
# 1) 在运行 QClaw 的 Windows 机器上提取账号（解密 DPAPI 凭据 + 探测模型目录）
node src/bootstrap.mjs --id qclaw-a --host 192.168.1.20 --out config.json
#    --host 是"号池服务器回访这台机器的地址"，纯本机试用则省略（默认 127.0.0.1）
#    首次创建 config.json 时会生成并打印 adminToken / clientKey（只显示一次）

# 2) 多账号：换机器/换账号重复第 1 步，--id 取不同名字即可（号池自动轮询）
#    也可以直接把账号推送到远端号池，不必手改 config.json：
node src/bootstrap.mjs --id 同事的机器 --push http://<服务器>:8787 --admin-token <adminToken>
#    指向 127.0.0.1 的 openclaw-gateway 账号会被自动跳过（远端连不上本机端口）

# 3) 启动
PROXY_ADMIN_TOKEN=<adminToken> node src/server.mjs --config config.json
```

浏览器打开 `http://<host>:8787/` 即 WebUI，六个视图：
**概览**（在线账号/模型数/有效密钥/今日请求/失败率等指标卡 + 风险横幅：无密钥、号池不健康、
登录态 7 天内到期、有号在冷却）、**密钥**（签发与限额、用量、启停/轮换/删除）、
**号池**（健康度、冷却、延迟、请求统计、JWT 到期、扫码登录、账号增删）、
**对话**（选模型/选密钥/选账号/流式逐字/思考折叠/停止/System 提示/重新提问/复制为 curl）、
**日志**（最近 500 条对外请求，可按状态过滤）、**接入**（按选中密钥生成可复制的 curl/SDK 片段）。
对话面板用客户端密钥走的是和外部客户端完全相同的 `/v1/chat/completions` 链路，不是旁路。

号池页把"加号"这件事集中成四个入口：**扫码登录**（无头浏览器出码）、
**从其他机器补号**（自动填好本机地址的 `bootstrap --push` 命令，可一键复制）、
**批量导入**（粘贴 `bootstrap` 打印的 JSON，支持单对象 / 数组 / `{accounts:[…]}`，
逐条 upsert 并给 ✓/✗ 结果；有任何一条缺 id/type 就整批拒绝，避免半导入）、
以及**手动表单**。

## 扫码登录（服务端自助补号）

> **结论先说：这条链是通的，可以直接在 WebUI 扫码加号。**
> 2026-09-22 之前这里写的是"服务端整族关闭、不能入池"，**那是误判**：
> 不带签名打 `4026`/`4050` 会回 `21004 鉴权不通过，请升级最新版本`，字面像"接口下线"，
> 其实是缺了官网网页通道的 HMAC 签名头。签名算法在 `https://qclaw.qq.com` 自己的 JS 包里是明文的。
> 现在的判据（全部实测，未真机扫码前）：`4050` 匿名+签名 → `code 0` 并签发 `state`；
> 带这个 `state` 打 `4026` → `code -1 微信授权失败`（说明 state 已过校验，只差一个真的微信授权码）；
> 换成自造的 `state` → `code 4 state 无效或已过期`。对照：`4027` 带 JWT 仍 `code 0`。

号池页点「生成登录二维码」，服务端会：

1. 生成网页通道 guid（`qclawmp_<uuid>`，与桌面端那串 64 hex 不同），
   用它调 **`4050` 领 `state`** —— state 必须服务端签发并绑在 guid 上，自造的会被拒；
   然后用**无头浏览器**打开微信登录页
   `https://open.weixin.qq.com/connect/qrconnect?appid=wx9d11056dd75b7240&scope=snsapi_login&redirect_uri=https://security.guanjia.qq.com/login&state=<4050 签的>`，
   页面自己用 `wxLogin.js` 出码；
2. 等二维码真的渲染出来再按元素裁剪截图（跨域 iframe 里的码也支持），返回 `qrImage`，前端每 2.5s 轮询 `/admin/login/:id`；
3. 监听所有帧的请求/跳转与**响应体**；
4. **code 是一次性的，所以顺序很重要** —— 签名通道排第一，兜底通道才会消耗 code。拿登录态有五条路，谁先出结果用谁：
   - **签名兑换（主路径）**：`4026 {guid, code, state}` + `x-sign-*` → 直接吐 openclaw JWT
     （移动端编号 `4630` 同参数，作为回落一起试）；
   - **跳转回调**：捕获 `?code=` / `?token=`；
   - **页面自换 → loginkey**：`/wxLogin` 父页会 `POST https://luban.m.qq.com/api/public/pcmgr/sendLoginCode`
     `{code,guid,loginAccType}` 换出**管家会话**（`loginkey`/`accountId`/微信 token/昵称/头像）。
     `loginkey` 不是 JWT 形状，由 `pickLoginKey()` 专门识别，随后当 `x-token` 交给总线；
   - **响应体直取**：直接挖响应体里的 JWT（不需要知道兑换接口 apiId）；
   - **响应头 / Set-Cookie** 与**页面 cookie / localStorage / sessionStorage 周期探测**（每 2s）。
   都没命中时，才回退到用 `code` 按 `QPP_LOGIN_API_IDS` 主动兑换（默认 `4026`）。
   拿到管家会话后还会自动探测 `4055`/`4058`/`4027`/`4320`，任何一个吐出 JWT 就直接入池。
5. 拿到 JWT 后调 `4055` 取该账号 `sk-`、`4320` 取模型清单，自动 upsert 进号池并落盘 `config.json`。

五条取 token 路径都用桩服务做过离线端到端验证（**5 个场景 23 项断言全通过**，Windows/Edge 与 Debian/chromium 各一轮）：

```bash
node scripts/login-e2e.mjs   # 桩登录页 + 桩总线，跑通 出码→捕获→取token→取sk-→入池
```

二维码 5 分钟过期；`POST /admin/login/:id/cancel` 可提前取消并回收浏览器。

依赖一个本机浏览器：Linux `apt install chromium`（已在 Debian 13 + Chromium 153 实测出图），
Windows 自动探测 Edge/Chrome；也可用 `QPP_BROWSER=<可执行文件路径>` 指定，`QPP_DEBUG_PORT` 设调试端口基准值（默认 9333，实际每会话自动挑空闲端口，可并发）。
root 下会自动加 `--no-sandbox`，非 root 保留沙箱。

| 环境变量 | 作用 |
| --- | --- |
| `QPP_BROWSER` | 指定 chrome/chromium/edge 可执行文件 |
| `QPP_DEBUG_PORT` | CDP 调试端口基准值（默认 9333，被占用时自动顺延） |
| `QPP_LOGIN_API_IDS` | 兑换 code 的候选总线 apiId，逗号分隔（默认 `4026`）—— 发现新接口后改这里即可，不用改代码 |
| `QPP_LOGIN_URL` | 登录入口 URL 模板（`%STATE%` / `%GUID%` 占位），默认管家 `/wxLogin?guid=%GUID%`；也是离线验证的注入点 |
| `QPP_LUBAN_BASE` | code→管家会话的兑换基址（默认 `https://luban.m.qq.com/api/public/pcmgr/`） |
| `QPP_LOGIN_ACC_TYPES` | `sendLoginCode` 的 `loginAccType` 候选，逗号分隔（默认 `2,32`；页面自己换好的那条不受影响） |
| `QPP_JPRX_BASE` | 总线基址（默认 `https://jprx.m.qq.com/`），离线验证时指向桩服务 |
| `QPP_LOGIN_TRAIL` | 回调轨迹文件路径（默认 `login-trail.log`） |

扫码是一次性事件，所以浏览器经过的每个登录/回调地址都会追加写入 `QPP_LOGIN_TRAIL`。
已捕获到的一个事实：微信登录页会去探测**本机 PC 微信客户端**（`https://localhost.weixin.qq.com:13013..14015/api/check-login`）
以便免扫码一键确认；无头服务器上没有 PC 微信，这些探测必然失败，页面会退回纯扫码路径 —— 属预期行为。

> **状态（2026-09-22 定论）**：1–4 步全部实测通过 —— 云服务器出码、手机扫码、回调捕获、
> `sendLoginCode` 换出真实账号会话（`accountId` + 59 天 `loginkey` + 微信 access/refresh token）都跑通了。
> **但号池进不去**：jprx 只认 openclaw JWT，而发 JWT 的 `4026` 与发 state 的 `4050` 已被腾讯服务端关闭 ——
> 用**同一个有效 JWT** 做对照，`4027` 返回 `code:0 Success`，`4026`/`4050` 仍返回 `21004 鉴权不通过，请升级最新版本`；
> 且 `4066 checkUpdate` 显示最新版就是本机这版 `0.2.37-5001-630`，所以不是版本落后。
> 桌面 App 自己也调不动它：主进程 `authMod.wx.loginCallback` 在带上它自己签发的 state 后**仍然不发任何网络包**（mitm 实测）。
>
> **因此补号目前唯一可行的路径**：在任何一台**已登录 QClaw** 的机器上导出登录态再推给服务器 ——
> `node src/bootstrap.mjs` 读 `safeStorage` 里的 JWT → `4055` 取 `sk-` → `4320` 取模型 →
> `--push http://<服务器>:8787 --admin-token <token>` 直接入池。号池的第 3 个账号就是这么来的。
> 扫码功能保留：一旦腾讯重新开放 `4026`（或换新的兑换接口），无需改代码即可自动完成入池。

## 对外提供 API：密钥、限额与运维

WebUI 的「密钥」页就是控制面。每把密钥独立配置，**全部在网关侧强制执行**：

| 字段 | 语义 | 越界时的响应 |
|---|---|---|
| `rpm` | 每分钟请求数（滑动窗口） | `429 rate_limit_exceeded` + `retry-after` |
| `dailyRequests` | 每日请求配额（UTC 日切） | `429 insufficient_quota` + `retry-after` |
| `models` | 模型白名单，空 = 不限 | `403 model_not_allowed`；`/v1/models` 同步过滤 |
| `maxTokens` | 该密钥单次请求 `max_tokens` 上限 | 入站时静默下调到这个值（防推理模型吃满额度） |
| `expiresAt` | 到期时间 | `401 authentication_error` |
| `enabled` | 停用开关 | `403 permission_denied` |

端点：`GET/POST /admin/keys`、`PATCH /admin/keys/<key>`（改限额/启停）、
`POST /admin/keys/<key>/rotate`（换值、旧值立刻失效）、`DELETE /admin/keys/<key>`、
`GET /admin/log?limit=N`（最近 500 条对外请求：密钥、模型、服务账号、状态、耗时、token 估算）。
号池账号：`POST /admin/accounts/<id>/disable` 与 `/enable`（启用会一并清除冷却状态；未知 id 返回 404）。

错误体统一是 `{ error: { message, type, code } }`。**`code` 是稳定的机器码，给外部 SDK 分支用**
（`message` 是给人看的中文，会改）：

| `error.code` | HTTP | 含义 |
|---|---|---|
| `missing_api_key` / `invalid_api_key` | 401 | 没带密钥 / 密钥不存在 |
| `key_expired` | 401 | 已过 `expiresAt` |
| `key_disabled` | 403 | 被停用 |
| `model_not_allowed` | 403 | 模型不在该密钥白名单内 |
| `rpm_exceeded` | 429 | 触发每分钟速率限制（带 `retry-after`） |
| `daily_quota_exceeded` | 429 | 触发日配额（带 `retry-after` 到 UTC 零点） |
| `no_keys_configured` | 503 | 服务端一把密钥都没签发，全部拒绝 |

模型白名单支持 `*`（`"models": ["*"]` 等价于不限制）；WebUI 的密钥弹层里"全不勾"就是不限制。
`cors.origin` 可以是 `"*"`、单个来源，也可以是数组 —— 配数组时按请求 `Origin` 精确回显并自动带 `Vary: Origin`。

计量按密钥累计并定期写回 `config.json`（内存计数 + 5s 合并写盘，1c1g 上不会因记账打爆磁盘）；
上游不返回 `usage` 时按「中日韩 1 字≈1 token、其余 4 字≈1 token」估算，UI 上标 `估`，**不要当账单用**。

### 公网部署前必做

```jsonc
// config.json
{
  "listen": { "host": "0.0.0.0", "port": 8787,
              "adminAllowFrom": ["127.0.0.1", "10.0.0.0/8"] },  // 管理面来源白名单，空=不限制
  "cors":   { "origin": "*" }                                    // 收紧到你的前端域名
}
```

- `adminAllowFrom` 一配上，`/admin/*` 就只对列出的来源/CIDR 开放（socket 真的是回环的恒放行，
  远程管理走 `ssh -L 8787:127.0.0.1:8787 <host>`）。**建议一定配上**：`/admin/state`、`/admin/config`
  能读走整个号池的凭据，风险远高于推理口本身。`config.example.json` 默认就是 `["127.0.0.1"]`，
  拷过去即"只能本机/隧道管理"，要放开再往里加 IP 或 CIDR。
- `trustProxy` 默认 `false`：此时 `X-Forwarded-For` 一律不采信，来源只看 TCP 对端地址。
  只有当你**确实**把服务放在 nginx/Caddy 之类反代后面时才置 `true`，那时取 XFF 的**最后一跳**
  （链首仍是客户端自己填的）。反代不在中间却开这个开关，等于把 `adminAllowFrom` 关掉。
- **本进程不做 TLS。** 公网上传 bearer 凭据必须要么前置一个反代终止 HTTPS（配好 `trustProxy`
  与真实头传递），要么让客户端走 SSH/VPN 隧道。裸 HTTP 暴露到公网时，密钥与响应内容在链路上是明文的。
- `cors.origin` 收紧到实际前端域名；`*` 只适合你自己全开的场景。
- 一把密钥都没配时 `/v1/*` 返回 `503` 而不是放行 —— 防止误配成开放代理。
- 启动日志会明确提示当前是否处于"管理面无限制"状态。

## 控制台前端（shadcn/ui + React）与这一轮新增的四件事

界面是 [shadcn/ui](https://ui.shadcn.com/)（React + Tailwind v4 + Radix）的单页控制台，源码在 `ui/`，
`npm run build` 产出到 `web/`。**服务端仍然是零运行时依赖**：`dependencies` 是空的，所有前端库都在
`devDependencies`（构建期），发出去的是打包好的静态文件，`src/server.mjs` 的静态处理一行没动。

```bash
npm install          # 只装构建期依赖
npm run dev          # 本机 5173 起 vite，/admin 与 /v1 代理到 127.0.0.1:8787
npm run build        # tsc 类型检查 + vite 打包到 web/
```

`web/` 是构建产物，**不在版本库里**（见 `.gitignore`）。要么按上面三步自己构建，要么直接下载
[Releases](../../releases) 里与源码同版本的 `web-<tag>.zip`，解压到仓库根目录即可，服务端会原样静态托管它。

- **号池序号 = 调用优先级**：账号可带 `priority`（从 0 起，越小越优先）。调度只在**最小序号那一档**内轮转，
  那一档全部冷却/停用才落到下一档 —— 语义是"先榨干这个号"，不是"按序号分流量"；`weight` 只在同档内做次级排序。
  没编号的排在最后（`Pool.pri()` 里 `null` 绝不能过 `Number()` —— 那会变成 0，正好反了）。
  号池页每行可直接改序号（失焦即 `PATCH /admin/accounts/:id`），「按顺序重排序号」把删号留下的洞补成连续 0…N-1。
- **测活 = 查积分**（同一个动作，走 `POST /admin/accounts/:id/probe`）：探针是总线 4110 那一次积分查询 ——
  它和推理吃同一套登录态，却能一次都不花额度。查得到就顺手把余额刷新，**查不到就是这个号掉线或被封**，
  状态列直接标「需要重新登录」并按既有 auth 冷却摘出轮询；只有"根本没连通"才判成「暂不可达」不定罪
  （否则一次总线抖动能把整个池子清空）。非直连账号没有总线身份，探针退化成"能不能拉到自己目录"。
  真发一次推理的深度测活收进每行的「…」菜单（`/test`，仍走 `allowUnavailable`）。批量按序号逐个查，不并发。
- **登录**：按定下的口径保持现状 —— 管理面仍由 `adminToken` 这把 Bearer 守着（没令牌时 `/admin/*` 一律 401），
  登录页只是把它收进一个密码框，值只写本机 localStorage。
- **对话**：新增「思考」开关与多会话。关思考是显式发 `reasoning_effort:"none"`（上游只认开/关，档位无效）；
  会话存在浏览器 localStorage，「新建对话」开一条空的、可切可删，老的单串历史会自动并成第一条会话。

## 上号身份、积分、思考与工具

**同一微信号重复上号只认一条。** 编号空间本来是多套的：QClaw 的 `user_id`、管家的 `accountId`、
按 appid 变的 `openid` 都不可靠，只有 **`unionid`**（4027 返回）在开放平台维度稳定。
入池时（扫码 `login.mjs` 或 `bootstrap --push` 走 `/admin/accounts/upsert`）会查 `unionid` 并在池子里找同一条：
命中就**就地更新凭据**并返回 `{id: 已有id, reused: 已有id}`，不新增。查到的身份也会写回 `config.json`，
所以下次重启前就已知的账号无需再查。WebUI 号池页每行显示「微信 昵称 · unionid …后6位」，能一眼看出哪几条其实是同一个号。

> 这条识别在提示上必须说白：**「已写入号池」这种含糊话会被读成"多了一个号"**。实测有人删掉一个号后又扫了
> 同一个微信号，看到成功提示却发现号池反而小了一个，就判定加号功能坏了 —— 其实扫出来的本来就是池里已有那条，
> 只是凭据被更新。所以扫码结果分两套文案（`已新增账号 …，号池共 N 个号` / `已就地更新 …，号池数量不变 ——
> 要加新号得用另一个微信号扫码`），`login-e2e` 的场景 I 把分叉钉住。**要加新号，只有一个此前没用过的微信号才行。**

**积分看 4110，那才是 QClaw 面板上那个数。** 号池页「积分余额」列取 `4110`（客户端 `getQPointAccount` 同一个接口）：
`balance` = 剩余积分，`balance_detail` 拆成活动/订阅/积分包三档，`items[]` 是每笔赠送的
`label / total_amount / remain_amount / expire_time`（如「免费版月度赠送 500」「新用户注册赠送 2000」），
余额恒等于各笔 `remain_amount` 之和，所以进度条按"已消耗 / 已发放"算。推理按 4327 的倍率扣积分
（`input_rate` / `output_rate`，号池页「积分倍率」列与 `/v1/models` 的 `creditRate` 都看得到），
所以**积分见底才是硬停**，这才是"这个号还能不能用"的口径。
`4075`（`daily_token_limit` / `daily_token_used` / `rpm_limit`）单列显示为「今日 token」，它解释的是"有积分却被限流"；
`4708` 的试用/购买额度是第三件事，免费池不走它（实测能正常推理的号在 4708 上全空），
三列分开显示，**绝不用 `canUse` 判断账号可用性**。点「目录·积分」按钮会连同目录、额度、积分、身份一起重查。

**思考深度只有「开 / 关」，档位是无效的。** 直连上游做的对照实验（`re/probe-effort-tools.mjs`、`re/probe-usage-graded.mjs`）：
`reasoning_effort` 与 `thinking` 都是**被校验**的字段（给错形状上游回 400 `proxy_param_error` / `invalid_request`），
但只有 `reasoning_effort:"none"` 或 `thinking:{type:"disabled"}` 有可观察效果（`reasoning_content` 直接为空、耗时明显变短）；
`minimal/low/medium/high` 在同一道题上分别是 556 / 1071 / 611 字符，与基线 480 无单调关系，
`thinking.budget_tokens` 也不封顶（预算 60 仍产出 ~850 token 推理）。所以本代理只对齐"开关"这一件事：
三个入口（`reasoning_effort` / `thinking` / Responses 的 `reasoning.effort`）任写一种都能关掉思考，
档位原样透传但**不承诺效果**，别按档位规划积分。会不会思考以 4320 的 `capabilities` 为准
（只有 `pool-hy3-preview`、`pool-deepseek-v4-pro` 标了「深度思考」，`/v1/models` 里同名字段 + `canThink`）。
上游也从不返回 usage（`stream_options.include_usage` 也不给），所以 usage 一律是估算值：
`/v1/responses` 与 `/v1/messages` 的出参里补齐，OpenAI 流式则在 `[DONE]` 前补一帧 —— 否则按 usage 做上下文压缩的客户端会一路算成 0。

**工具调用三个入口都可用（实测 `finish_reason=tool_calls`）。** 上游原生吃 chat 工具，所以
`/v1/chat/completions` 直接透传 `tools` / `tool_choice`，`role:"tool"` 结果回传能续写；
`/v1/messages` 收 Anthropic 的 `tools + input_schema`，出口转 `tool_use` 块（流式参数走 `input_json_delta`，
早先只发空 `input:{}` 会把参数整段丢掉）；`/v1/responses` 收**扁平** `tools`（`{type,name,parameters}`）并转成
嵌套 `function` —— 不转不是"没工具"，而是上游 400 `proxy_param_error`。`mcp` / `shell` 一类工具类型上游没有，明确 400 不静默降级。

**`/v1/responses`（ChatGPT / Codex 系客户端）。** 上游只有 chat/completions，这里做双向映射：
`input`（字符串或 `[{role, content:[{type:'input_text'}]}]`）+ `instructions` → `messages`；
出参是 `response` 对象（`output[]` 含 `message` / `reasoning` / `function_call`、`output_text`、
`usage.input_tokens|output_tokens`）。流式重放 Responses 事件序列
（`response.created → in_progress → output_item.added → output_text.delta → …done → response.completed`）。
`conversation` / `previous_response_id` / `store` / `background` / `truncation` 这类有状态字段
**明确返回 400 `unsupported_field`**，因为上游没有会话存储 —— 假装支持比拒绝更容易埋坑。
密钥的模型白名单、限流、配额对 `/v1/responses` 同样生效。

**密钥在非 HTTPS 下也能复制。** `navigator.clipboard` 只在安全上下文存在，而控制台最常见的用法就是
`http://<服务器IP>:8787` —— 那里它是 `undefined`，所以原来那句"请手动选中"是死路。现在：
先试 `clipboard`，失败退到 `execCommand('copy')`（实测在 `isSecureContext:false` 下仍成功），
两者都不行就把完整密钥摊在一个已全选的弹层里。密钥列表默认掩码，「显示明文」按钮切换（只影响浏览器渲染，不额外请求服务端）。

## 接入方式

```js
// OpenAI SDK
client = OpenAI(base_url = "http://<host>:8787/v1", api_key = "<clientKey>")
client.chat.completions.create(model = "qclaw/pool-minimax-m3", messages = [...])

// Anthropic SDK / Claude Code
Anthropic(base_url = "http://<host>:8787", api_key = "<clientKey>")   # 走 /v1/messages
```

```bash
curl http://<host>:8787/v1/chat/completions \
  -H "Authorization: Bearer <clientKey>" -H "content-type: application/json" \
  -d '{"model":"qclaw/pool-minimax-m3","messages":[{"role":"user","content":"你好"}]}'
```

### 账号类型

| type | 用途 | 凭据 |
| --- | --- | --- |
| `qclaw-aizone` | **推荐**。免签直连 QClaw 免费额度模型的真实上游，服务器上不需要装/跑 QClaw | `apiKey`=该账号的 `sk-`（总线 4055 签发）+ `jwt`=登录态 + `guid`/`account` |
| `openclaw-gateway` | 回连本机 QClaw 内嵌网关，仅适合本机调试 | `token`=网关 token（模型选择依赖 agent 绑定，不精确） |
| `openai-compat` | 混合任意标准 OpenAI 上游（含 BYOK 的 coding plan，走你自己的付费额度） | `apiKey` |

`qclaw-aizone` 的请求形式（实测 11/11 模型可用、响应 `model` 字段回显所选模型）：

```
POST https://mmgrcalltoken.3g.qq.com/aizone/v1/chat/completions
Authorization: Bearer sk-...
X-OpenClaw-Token: <登录 JWT>          # 缺 → 总线码 21004
X-Conversation-Request-ID: <uuid>     # 缺 → 400 invalid_request
{"model":"pool-glm-5.2", ...}         # 裸模型名，不带 qclaw/ 前缀
```

模型清单与 `sk-` 都由 jprx 总线取（`src/qclaw-api.mjs`：4320 列模型、4055 发密钥），
总线侧实测只需要 JWT + guid + account，设备令牌与 `JPrx-Ctx` 签名都不是必需的。
登录态失效（21004）会按 `cooldownAuthFailSeconds` 冷却并自动换号。

## 部署到 1c1g Linux

```bash
useradd -r -s /usr/sbin/nologin qclawproxy
mkdir -p /opt/qclaw-pool-proxy /etc/qclaw-pool-proxy
cp -r src web package.json /opt/qclaw-pool-proxy/
cp config.json /etc/qclaw-pool-proxy/config.json
cp deploy/env.example /etc/qclaw-pool-proxy/env && chmod 600 /etc/qclaw-pool-proxy/env
cp deploy/qclaw-proxy.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now qclaw-proxy
```

systemd 单元带 `MemoryMax=220M`、`ProtectSystem=strict`、非 root 运行；常驻 RSS 约 60 MB。

### 用 `tools/deploy.py` 发版（我实际用的路径）

```bash
SSH_PASS=<密码> DEPLOY_KEEP_CONFIG=1 python tools/deploy.py
```

`DEPLOY_KEEP_CONFIG=1` 表示**沿用远端 config.json**（不加这个会用空号池覆盖，把线上凭据全清掉）。发版脚本做三件保命的事：
日志**追加**写 `/var/log/qpp.log`（早先是 `>` 截断，号池少了一个号却无从查证）、
覆盖前把旧版留成 `config.json.bak`（`saveConfig` 内建，每次写盘都留）、
并留最近 5 份 `config.pre-deploy-<时间戳>.json`。号池的 `sk-` 与 30 天 JWT 只存在这一份文件里，
**丢了只能重新登录补号**，所以本机 / 云服务器 / 备份三份配置都要当成有独立价值的数据，别只存一处。

## 目录结构

```
src/server.mjs      HTTP 入口、路由、鉴权、限流、CORS、管理端点
src/respond.mjs     上游响应 → 客户端报文的四个象限（OpenAI/Anthropic × JSON/SSE），含背压与断开处理
src/keys.mjs        对外密钥：签发/轮换/限额/配额/模型白名单/用量计量/请求日志
src/pool.mjs        号池状态机：健康度、冷却、加权轮询、粘性路由、失败换号、体检（查积分即测活）
src/upstream.mjs    上游适配（qclaw-aizone / openclaw-gateway / openai-compat）
src/qclaw-api.mjs   jprx 总线 + luban 网关客户端（目录 4320 / 倍率 4327 / 签发 sk- 4055 / 积分 4110 / 今日 token 4075 / 身份 4027 / code 兑换）
src/reasoning.mjs   思考深度参数跨入口归一（只有开/关有效，档位与 budget 上游不生效）
src/translate.mjs   OpenAI ⇄ Anthropic 报文与流式互转
src/login.mjs       无头浏览器扫码登录引擎
src/cdp.mjs         零依赖手写 WebSocket + CDP 客户端
src/config.mjs      配置加载/校验/落盘（强制 0600），${env:VAR} 展开
src/bootstrap.mjs   Windows 侧账号提取（DPAPI + AES-256-GCM），同时产出直连账号
ui/src/             控制台前端源码（Vite + React + TS + Tailwind v4 + shadcn/ui）
ui/src/views/       六个视图：概览 / 密钥 / 号池 / 对话 / 日志 / 接入
web/                上面的构建产物（npm run build 生成，不在版本库；可作为 Release 资产下载）
scripts/test.mjs              回归门禁：串行跑下面五个离线套件并汇总断言数（npm test，184 项）
scripts/harness.mjs           一次性自桩实例（假总线 + 假 aizone 上游 + 假登录页 + tmpdir 配置 + 起代理）
scripts/verify.mjs            端到端验收（--self 走自桩 87 项；不带 --self 打真号池 85 项）
scripts/respond-test.mjs      报文转换离线测试（假 res/假上游，含背压与断开 + 思考/工具映射；28 项，不需要活号池）
scripts/admin-guard-test.mjs  管理面来源闸回归（含伪造 X-Forwarded-For 必须被拒；7 项）
scripts/login-e2e.mjs         扫码登录离线端到端（桩登录页 + 桩总线；9 个场景 51 项，含 luban 抖动重试与签名校验）
scripts/models-sweep.mjs      逐模型验收（live 层）：确认每个 qclaw/* 都能真的吐 token
deploy/             systemd 单元与环境文件模板
```

## 合规

逆向自家账号的免费额度接口供其他程序调用属于服务条款灰区，公开分发或售卖是另一回事。
仅在自购/自有账号上使用，并控制并发。
