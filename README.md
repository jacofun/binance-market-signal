# binance-market-signal

新加坡（`ap-southeast-1`）阿里云 FC 自定义运行时服务。Node.js 24 / Debian 12，监听 `0.0.0.0:9000`，适配 0.35 vCPU、512 MB 内存、10 GB 临时磁盘。TypeScript 编译为 JavaScript，部署包没有运行时第三方依赖。

一次请求依次获取币安公开行情、计算收盘 K 线特征与价格区域、让百炼模型研究、用程序校验结构和复核标记价格，最后返回 V4 研究结果。原始行情、提示词和分析结果均不写 OSS、数据库或本地磁盘。日志记录请求编号、状态、耗时及模型失败时经过白名单过滤的诊断字段，不记录 JWT、密钥、模型完整回复或请求头。

## 接口

| 方法 | 对外路径 | 用途 |
| --- | --- | --- |
| GET / HEAD | `/trade/api/signal/health` | 启动和代码版本检查，不调用币安/模型 |
| POST | `/trade/api/signal/analyze` | 分析一个交易对 |
| OPTIONS | `/trade/api/signal/analyze` | 不带 JWT 的 CORS 预检 |

也支持 CDN 去除 `/trade/api/signal` 前缀后回源 `/analyze`、`/health`；POST `/` 和 `/trade/api/signal/` 是分析别名。下单功能使用独立的 POST `/trade/api/signal/orders`（或回源 `/orders`）。仅支持 HTTPS 上的业务调用；本地服务器 HTTP 由 FC/CDN 终止 TLS。

```http
POST https://yanxiao.me/trade/api/signal/analyze
Content-Type: application/json
X-JWT-Token: Bearer <北京现有接口签发的交易JWT>

{"symbol":"BTCUSDT","style":"trend"}
```

`style` 支持 `trend`（默认）、`reversal`、`neutral`，只接受 `symbol/style`，不能由请求指定模型地址、API Key、任意币安 URL 或价格数据。交易对受服务端环境变量白名单控制，最多四个 USDT 交易对。

响应含 `analysisId`、`status`、`opportunity`、`market`、`timing`、`model`、`codeVersion`：

- `candidate`：候选价位通过结构校验和最终价格核验，仍须人工确认自然语言触发条件；`triggerVerified` 固定为 `false`。
- `watch`：等待条件或等待进入价位区间。
- `none`：暂无机会，入场/止损/方向为空。
- `expired`：分析耗时超限、价格明显偏移，或已越过止损/首个目标。`expiredReasons` 给出原因。

机会包含多空、入场区间、止损、目标、程序重算的盈亏比、触发/失效条件、支持证据和反对理由。不报告未经校准的胜率，不自动下单。盈亏比按入场区间不利端估算，不含手续费、滑点、资金费，也不计算仓位或杠杆。候选目标引用由合约成交 K 线计算的结构区域，机会状态通过最新**标记价格**复核。此版本是实时研究助手，没有经回测验证的收益承诺。

`market.chart` 由 `{ interval, candles }` 组成，提供本次分析送给模型的原始收盘 K 线。每行依次为 `[开盘时间戳（毫秒）, 开, 高, 低, 收, 成交量, 主动买量]`，按时间递增。`market.asOf` 是行情快照时间，`market.latestQuote` 是分析后的复核标记价格。

## FC 环境变量

FC 统一使用同域名的原生 JWT 策略，与同步函数复用同一凭证。**不需要任何 SIGNAL_JWT_*、SIGNAL_AUTH_MODE 或 SYNC_JWT_* 环境变量，旧值不再读取。**只需配置 `DASHSCOPE_API_KEY`，并建议明确百炼地域端点与模型。示例值中的占位符必须替换：

```json
{
  "DASHSCOPE_API_KEY": "填写百炼API Key",
  "DASHSCOPE_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "DASHSCOPE_MODEL": "kimi-k3.1-pro",
  "SIGNAL_ALLOWED_SYMBOLS": "BTCUSDT",
  "PORT": "9000",
  "MARKET_DATA_MODE": "rest"
}
```

百炼 Key 与调用地域必须匹配。北京公共兼容端点为上面的默认值；新加坡可使用 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。也接受百炼工作空间专属域名，如 `https://你的WorkspaceId.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。使用控制台针对该 Key 给出的地址，模型服务地域由 API Key 和端点决定，与函数所在地域独立。代码只向明确列入白名单的百炼官方 HTTPS 域名发送 Key，禁止重定向。

百炼 `kimi-k3.1-pro` 的采样参数固定为 `temperature=1.0`、`top_p=0.95`、`presence_penalty=0.0`。代码按模型名自动设置温度为 1，其余两个参数不传，使用服务端默认值；其他模型沿用温度 0.1，无需新增温度环境变量。Kimi 建议先用 `DASHSCOPE_RESPONSE_FORMAT=json_object`、`DASHSCOPE_ENABLE_THINKING=false` 验证完整调用。这里保持既有的非思考请求模式；若改用 `omit` 交由模型默认启用思考，需另行评估输出预算和超时。参考：[百炼 Kimi 参数约束](https://www.alibabacloud.com/help/en/model-studio/kimi-api#default-parameters)。

模型失败时，HTTP 错误响应和 `analysis_failed` 日志保留 `upstreamStatus`，并按可用情况提供 `upstreamCode`、`upstreamRequestId`。上游错误正文只进行最多 8 KiB 的有界读取，代码仅允许已知错误码和 UUID/32位十六进制请求编号进入诊断字段；原始错误消息、未知字段和 HTML 不记录或透传。不自动重试。`MODEL_UNAVAILABLE` 加 `upstreamStatus=400` 应优先检查参数；404 检查模型 ID、开通状态和地域；5xx 根据上游请求编号排查服务异常。

签名公钥、issuer/audience 等策略只保留在 FC 实际回源入口。函数读取平台已验证 JWT 的 sub 和过期时间，不再重复验签，也不单独限制 market:analyze。业务鉴权不要求 `x-fc-control-path`、`x-fc-function-name` 或 `x-fc-request-id`；这些运行时元数据不构成密码学证明，缺失或取值不同不会拦截分析请求。信任边界是 FC 原生 JWT 入口，部署前后继续审计入口鉴权。禁止在无验签网关的普通 HTTP 服务器上公开这个处理器。

CI 在写入前和部署后读取所有公开HTTP触发器及指向该函数的FC自定义域名，确认业务JWT入口使用RS256公钥、唯一的 `X-JWT-Token` 来源，且全部分析路径受到JWT保护。默认函数URL可保留RAM签名鉴权，它是受IAM权限约束的管理调用入口；不接受匿名入口。跨地域迁移时，允许先在仅有RAM签名保护的默认函数URL后部署代码；工作流会标记 `jwtIngressReady=false`。切换CDN流量前，再配置受JWT保护的自定义域名。匿名入口仍会阻止部署。不接受会绕过业务路径鉴权的白名单/黑名单策略，只允许精确的健康检查路径例外；配置无法确认时停止部署。读取的JWKS只在CI内存中检查，不写入环境变量、部署包或日志，工作流不会修改任何鉴权配置。

网站复用 `POST /api/private-auth/trading/binance/token`，沿用现有 `BINANCE_SYNC_*` 签名配置以及 `aud=binance-trade-sync, scope=trading:sync`，不需要新增签名接口或环境变量。交易日志页的“分析交易机会”获取短期凭证后直接请求 `/trade/api/signal/analyze`；北京不代理行情和模型调用。凭证仅驻留当前请求内存，不落浏览器存储。同一交易凭证授权这个域名内的同步与分析两项能力，签发接口继续限制 owner、登录态、Origin 和 CSRF。

可信本地测试脚本 `npm run --silent token` 也使用现有 `BINANCE_SYNC_PRIVATE_KEY`、`BINANCE_SYNC_KEY_ID`、`BINANCE_SYNC_ISSUER` 和 `BINANCE_SYNC_AUDIENCE`；私钥仅供本地或北京签发中心，禁止放入本函数。

可选参数及默认值：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `DASHSCOPE_RESPONSE_FORMAT` | `json_object` | 可选 `json_schema`，须模型支持；无静默降级 |
| `DASHSCOPE_ENABLE_THINKING` | `false` | 首版关闭思考模式以控制延迟；不支持该参数的模型可设 `omit` |
| `DASHSCOPE_TIMEOUT_MS` | `45000` | 模型调用超时，范围1000–90000 |
| `DASHSCOPE_MAX_TOKENS` | Kimi K3.1 Pro 为 `4096`，其他模型 `2000` | 输出上限，范围512–4096；显式配置优先；截断结果会被拒绝 |
| `BINANCE_TIMEOUT_MS` | `8000` | 每个行情请求超时，范围1000–15000 |
| `SIGNAL_REQUEST_TIMEOUT_MS` | `65000` | 完整请求预算，范围5000–110000 |
| `SIGNAL_MAX_ANALYSIS_AGE_MS` | `60000` | 从请求开始计算的机会时效上限，范围5000–110000 |
| `SIGNAL_MAX_PRICE_AGE_MS` | `5000` | 最终报价最大年龄，范围1000–15000 |
| `SIGNAL_MAX_PRICE_DRIFT_BPS` | `30` | 分析期间最大允许价格偏移，30基点=0.3%，可配置1–500 |
| `SIGNAL_COOLDOWN_SECONDS` | `10` | 同一 subject 在单实例内的分析间隔，范围0–300 |

行情分析无需配置 OSS 或币安账户密钥。百炼 Key 只放 FC 环境变量，不需要放 GitHub Secrets。`GET /health` 成功只说明服务启动成功，不说明密钥、模型权限或币安行情已经验证。

### 排查 INVALID_MODEL_OUTPUT

`INVALID_MODEL_OUTPUT` 表示模型响应读取、正文解析或业务校验失败，与 HTTP 4xx/5xx 的 `MODEL_UNAVAILABLE` 不同。旧日志只有总错误码，无法据此确定一次历史请求的具体失败环节。新版错误响应及 `analysis_failed` 日志提供以下诊断信息，不记录模型正文、思考内容或 API Key：

| `outputReason` | 含义与处理 |
| --- | --- |
| `truncated` | `finish_reason=length`，输出被截断；检查 `DASHSCOPE_MAX_TOKENS`，Kimi 建议4096；实时分析建议 `DASHSCOPE_ENABLE_THINKING=false` |
| `empty_content` | 正文为空；思考内容不能代替最终 JSON |
| `invalid_json` | 正文不是完整 JSON；不提取解释文字中的片段，不修复残缺 JSON |
| `schema` | 必需字段、类型或列表不符合要求，查看 `outputField` |
| `unsupported_metric` | 引用了不在当前快照指标枚举中的名称，查看 `outputField` |
| `missing_volume_price_evidence` | 候选或观察机会缺少量价摘要引用 |
| `price_relationship` / `price_scale` | 止盈止损方向、区间或价格尺度不合规，结果继续拒绝 |
| `unsupported_target` | 目标区不存在、方向不符，或目标价不在引用区域内 |
| `unsupported_zone` | 入场区或失效区无有效依据，或止损超出结构边界允许的距离 |
| `target_obstacle` | 目标跳过了靠近入场端的重要结构区域 |
| `price_precision` | 入场、止损或目标价格未对齐合约 PRICE_FILTER 的 tickSize |
| `finish_reason` / `response_envelope` / `content_too_large` | 结束状态异常、响应封装无效或响应超限 |

按可用情况同时提供 `finishReason`、`outputChars`、`inputTokens`、`outputTokens` 和经过格式检查的 `upstreamRequestId`。`outputField` 由服务端固定字段路径生成，不包含模型返回的字段名或值。例如 `outputReason=unsupported_metric, outputField=evidence[0].metric` 可以定位首条证据的指标引用错误。

### 云函数日志

用网站响应的 `requestId` 搜索 `analysis_failed` 或 `analysis_completed`。失败日志包含代码版本、HTTP 状态、耗时和执行阶段（`request`、`market_snapshot`、`model`、`proposal_validation`、`quote_verification`）。超时和客户端断开分别记录为 `request_deadline` 和 `client_disconnected`。币安请求失败时可查看固定的 `marketEndpoint` 和上游返回的 `marketHttpStatus`。百炼用 `upstreamRequestId` 关联上游请求。

业务校验失败时查看 `validation.reason`。例如，`zone_not_found` 表示本次快照缺少引用区域，`zone_broken` 表示区域已突破，`entry_out_of_bounds` 同时记录入场上下限和区域上下限。止损方向或距离、目标范围、阻挡区域和价格步长有各自的原因及数值上下文。格式不合法的模型区域 ID 只记录为 `malformed`。这些字段只进入 FC 日志。

日志的 `exception` 保留最多四层异常类型、受控的错误码和服务模块行号，可以区分 DNS、连接超时、断线及 JSON 格式错误。HTTP 错误响应保持原有结构。日志仅采集诊断字段，不采集 Token、API Key、请求正文、完整模型输出或上游异常原文。

### V4 数据契约

- `schemaVersion=4`、`model.promptVersion=market-research-v4`。保留 `opportunity`、`market.chart` 和当前 JWT 接口。先更新网站和私有鉴权函数对 V4 的解析及归档，再更新行情分析函数。
- `market.frames` 保留各周期的趋势、ATR 百分比、波动状态、最近 5 根量价细节及 5/20/50 根阶段统计。RVOL20 以此前 20 根均量为分母，CLV 取值为 −1 到 1。量比达到 1.5 或降至 0.75 时分别标记放量和缩量。OI 按两个相邻整点与 1h 已收盘价格对齐，缺失值保留为空。
- 每个摆动点等待后两根 K 线收盘确认。新摆动点与同类区域聚类时，中心跨度上限取初次和本次确认 ATR14 的较小值乘 0.5。区域在极值外扩初次确认 ATR 的 0.15，外扩上限为价格的 1%。区间 ID 由周期、原始支阻类型和第一个摆动点的开盘毫秒组成。聚类扩张后，以最后确认时点起跟踪最终边界的突破和回测，保留量比及触达反应。每周期保留每类离最新成交收盘价最近的 6 个区间。区域来自摆动结构，成交量证据为整根 K 线的观察量。
- 模型从区间 ID 中选择入场、失效和目标依据。止损在失效区不利侧边界外，至边界至多 1 倍 1h ATR。目标按方向排序，较近的有效 4h 区域或触达至少两次的独立区域须优先设目标。全市场 `exchangeInfo` 按实例缓存 1 小时，读取 `PRICE_FILTER.tickSize` 并校验各价位。程序保留模型提交的价位或返回诊断。
- `research` 包含市场状态、情景、三周期结论、价格区间、风险、目标评估和规则结果。目标距离、1h ATR 倍数和 R 以入场区间的不利端计算；历史波动分位数用快照前不重叠的 1h 成交 K 线窗口计算，并附样本数。4h / 12h / 24h 研究窗口独立于 30–300 秒的 `validForSeconds`。无计划的 `watch` 可与 `none` 一样留空方向和价格。


## HTTP触发器与CDN

将 `/trade/api/signal/*` 回源本函数，`/trade/api/sync/*` 仍回源原同步函数。业务方法 POST，允许 OPTIONS 预检，使用 HTTPS 回源、禁止缓存、原样透传 `X-JWT-Token`/JSON请求体，不通过重定向切换接口。CDN/浏览器等待预算需覆盖函数的默认65秒分析预算；平台不支持该等待时间时需要调整预算或另行实现流式/异步协议。

沿用 JWT Header 名称 `X-JWT-Token`，值为 `Bearer <JWT>`；不要使用会被 CDN OSS 回源鉴权占用的 Authorization。FC 必须保持原生 JWT 启用，控制台保留公钥与 `X-JWT-Token` 读取位置，去掉 `Bearer ` 前缀。分析沿用同步凭证和原生域名鉴权。订单接口还会独立校验网站签发的订单 JWT。确保无JWT的 OPTIONS 由网关直接处理；不能将分析路径加入免鉴权名单。CORS 仅允许 `https://yanxiao.me`、`https://www.yanxiao.me`，不携带网站 Cookie。此工作流不修改 HTTP 触发器、CDN 或原生JWT策略。

## 小规格实例的实现

- 每实例最多一个分析任务，额外请求429，不排队、不自动重试；该限制不是跨实例的全局限流。对全局调用量有要求时应另加网关配额或共享限流。
- 行情请求并发最多2；每周期向模型传入最近最多200根已收盘K线和程序计算的指标摘要。K线以紧凑数组传入，字段为开盘时间、开高低收、成交量和主动买量。
- 4h/1h/15m K线以币安UTC周期为准，剔除未收盘K线；每周期至少60根且须连续、最新，否则分析失败。
- 持仓量接口不可用时明确标注缺失；被限流时停止，不能把缺失数据当作0。持仓量不代表净多头，也不直接代表资金流入。
- 原始响应、模型输出、请求体均有大小上限；Node堆限制256 MB，为原生缓冲区和运行时保留空间。10 GB磁盘不用于堆积行情。
- 模型失败、截断、结构不合法不重试，不以修复后的自由文本输出代替有效机会。

## WebSocket扩展

`MarketDataProvider` 是统一接口，已有 `RestMarketDataProvider` 和 `WebSocketMarketDataProvider`。后者使用Node.js 24内置WebSocket客户端，无第三方依赖，支持订阅合并、断流检查、指数退避重连、定期轮换连接、重复/旧事件忽略、每交易对/周期最多200根缓存及REST缺口修复。连接断开期间报价缓存失效。模型分析不会阻塞行情回调，不会对每个行情tick都调用大模型。

FC首版使用 `MARKET_DATA_MODE=rest`，部署脚本不接受FC配置为websocket模式。未来在新加坡常驻主机上启动持续服务：

```sh
npm ci --ignore-scripts
npm run build
# 当前 HTTP 处理器依赖 FC 原生 JWT；独立主机上线前须增加可信验签网关/鉴权适配器。
MARKET_DATA_MODE=websocket CONTINUOUS_WORKER=true npm start
```

常驻模式启动时开始订阅。相同HTTP接口读取实时缓存，缓存未就绪或缺少已收盘K线时通过REST恢复。它是单进程内存缓存，进程重启后通过REST重新初始化；不承诺逐笔成交零丢失。多实例共享、全局去重、故障切换及持久化消息队列属于进一步扩展，不能仅凭FC选择Node.js 24保证持续接收。

## 推送部署

`main` 推送和手动触发运行 `.github/workflows/deploy-fc.yml`，PR仅测试。只使用已配置的：

- `ALIYUN_FC_ACCESS_KEY_ID`
- `ALIYUN_FC_ACCESS_KEY_SECRET`

RAM身份需要目标函数的 `fc:GetFunction`、`fc:UpdateFunction`、`fc:InvokeFunction`，以及只读鉴权审计的 `fc:ListTriggers`、`fc:GetTrigger`、`fc:ListCustomDomains`、`fc:GetCustomDomain`。不需要OSS或镜像仓库权限。

部署前核对现有 `binance-market-signal`：`ap-southeast-1`、`custom.debian12`、0.35vCPU、512MB、10240MB磁盘、9000端口；不匹配时写入前停止。**保留控制台已有的 Node.js 24 层与 PATH**。部署将启动命令改为 `/bin/sh /code/bootstrap`（从原命令保留已有Node解释器绝对路径），超时120秒；其他环境变量、层、角色、资源、网络、健康检查配置和触发器均保留。

CI编译并将约数十KB的代码ZIP直接上传FC，不依赖北京OSS；校验远端代码CRC64、配置保留情况，再通过RAM `InvokeFunction` 的 `{"action":"health"}` 做冷启动探测，检查 Node 主版本24和本次Git提交号。探测不调用百炼/币安、不需要配置模型Key。部署异常不自动覆盖重试，不将SDK原始异常或配置值打印到日志。

## 人工确认 BTCUSDT 委托

网站在新分析返回有效方向和价位时自动取委托草稿。候选状态可显示市价、只挂单（GTX）回踩限价和标记价格触发的条件限价。方向明确的观望状态只显示后两种，且价格必须通过同样的预检。观望且无价位、无机会、已过期及其他交易对均无委托草稿。所有委托使用服务端签名草稿。市场规则、盘口、账户和挂单在提交时重新检查。盘口价差风险上限只用于下单前的估算，实际成交和亏损取决于交易所撮合及后续处置。

网站所有者必须选择一张草稿、确认说明并点击发送。一个研究最多提交一次。仓位方向固定为 BTCUSDT 双向持仓模式下的 LONG / SHORT 开仓，同交易对已有持仓、普通挂单或条件挂单时中止。市价以盘口给出参考价。条件限价使用入场区边缘作为触发价与限价，只有标记价格条件由币安执行。市场定性条件由用户核对。委托在研究到期后仍可能有效，止盈、止损和撤单须在币安端管理。委托状态可按分析编号查询，条件单区分交易所受理、触发和实际撮合。

| FC 环境变量 | 用途 |
| --- | --- |
| `SIGNAL_ORDER_MODE` | 默认关闭。使用 `demo` 联调，`live` 启用真实委托。 |
| `BINANCE_BASE_URL` | 对应币安 USDT-M HTTPS 根地址。实盘只接受 `https://fapi.binance.com`，测试只接受 `https://demo-fapi.binance.com` 或 `https://testnet.binancefuture.com`。 |
| `BINANCE_API_KEY`、`BINANCE_API_SECRET` | 对应环境的 Binance HMAC 密钥。开通合约读取和交易权限，限制来源 IP，关闭提现等其他权限。 |
| `SIGNAL_ORDER_QUANTITY` | BTC 数量，默认 `0.001`。交易所步长或最低名义额不满足时拦截，保留配置数量。 |
| `SIGNAL_ORDER_MAX_RISK_USDT` | 入场参考价至研究失效价的计划价差风险上限，默认 `1`，单位 USDT。 |
| `SIGNAL_ORDER_JWT_PUBLIC_KEY` | 北京私有鉴权函数 `BINANCE_SYNC_PRIVATE_KEY` 对应的 RSA 公钥 PEM。 |
| `BINANCE_SYNC_KEY_ID`、`BINANCE_SYNC_ISSUER`、`BINANCE_SYNC_AUDIENCE` | 网站签发配置若有改动，信号函数填相同值。默认沿用 `trade-sync-v1`、`https://www.yanxiao.me`、`binance-trade-sync`。 |
| `SIGNAL_ORDER_SIGNING_SECRET` | 服务端草稿签名密钥，用 `openssl rand -hex 32` 单独生成。 |
| `ACCESS_KEY_ID`、`ACCESS_KEY_SECRET` | OSS RAM 访问密钥。 |
| `SIGNAL_ORDER_OSS_BUCKET`、`SIGNAL_ORDER_OSS_REGION` | 私有订单桶及 region ID，例如 `ap-southeast-1`。桶应从未启用版本控制。 |
| `SIGNAL_ORDER_OSS_NETWORK`、`SIGNAL_ORDER_OSS_PREFIX` | 默认公网 `public`，同地域可设 `internal`。默认前缀 `private/market-signal-orders/v1`，服务按 `demo` 和 `live` 分目录。 |

北京私有鉴权函数需配置 `BINANCE_ORDER_TICKETS_ENABLED=true`。保持 JWT 自定义域名校验原有签名、公钥、issuer 和 audience。网站新增的 `/api/private-auth/trading/binance/order-token` 用原私有鉴权入口。CDN 下单路径 `/trade/api/signal/orders` 使用与分析相同的 HTTPS、POST、OPTIONS、JWT 透传和关闭缓存规则，回源时保留原路径或映射为 `/orders`，关闭自动重试。订单函数额外验证签名、用途和草稿摘要。行情分析只会本地生成可选签名，任何订单配置错误都不阻塞分析响应。

OSS RAM 权限包含桶级 `oss:GetBucketVersioning`、订单前缀下的 `oss:GetObject` 和 `oss:PutObject`，以及仅对订单前缀各模式 `locks/btcusdt.json` 的 `oss:DeleteObject`。前缀应排除 CDN 对外访问与自动生命周期删除。同一账户、模式的所有 FC 实例使用相同桶和前缀。此功能使用独立的订单审计记录，无须迁移研究归档。防覆盖要求适用于版本控制从未启用的桶。版本控制已启用或已暂停的桶应另建私有桶。

若发生网络超时、币安结果不明或 OSS 写回失败，保留 `<prefix>/<mode>/locks/btcusdt.json`。用锁内的分析编号、客户端订单编号和 `requestId` 查 `order_submission_outcome`、`order_lookup_failed`、`order_outcome_write_failed` 或 `order_lock_release_failed`。先在币安核对委托、条件单及持仓，并确认对应 FC 请求已经结束。核对后才由运营人员删除该锁；保留 `attempts/<ownerSha256>/<analysisId>/intent.json` 和 `result.json`。关闭 `SIGNAL_ORDER_MODE` 可立即停用站内入口，已发出的委托继续由币安管理。部署时先启用 demo，完成账号、OSS 权限和真实回源联调后再决定是否启用 live。

## 本地验证

```sh
npm ci --ignore-scripts
npm run check
npm test
python3 -m pip install -r scripts/requirements-deploy.txt
python3 -m unittest discover -s test -p 'test_deploy_fc.py' -v
npm run package
```

测试覆盖共用交易凭证和FC入口边界、鉴权先于上游调用、CORS/路径、收盘及连续性、限流、过期报价、模型无效/截断输出、分析后重新核价、小实例并发、WebSocket缓存/补齐与部署配置保留。模型和行情使用可注入测试数据；真实百炼分析与真实WebSocket长时间稳定性仍需在配置完成后的运行环境验证。

参考：[FC自定义运行时](https://www.alibabacloud.com/help/en/functioncompute/custom-runtime/)、[百炼兼容接口](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)、[币安USD-M行情](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)。
