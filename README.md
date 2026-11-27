# binance-market-signal

新加坡（`ap-southeast-1`）阿里云 FC 自定义运行时服务。Node.js 24 / Debian 12，监听 `0.0.0.0:9000`，适配 0.35 vCPU、512 MB 内存、10 GB 临时磁盘。TypeScript 编译为 JavaScript，部署包没有运行时第三方依赖。

主链路通过 REST 获取币安行情，由 M1 评估已收盘 K 线，M1 触发后由 M2 构建方案，再做结构校验和标记价复核。手动分析和符合条件的自动分析使用 V4 数据契约。日志保留请求编号、状态、耗时和经白名单过滤的诊断字段。自动分析归档包含本次快照使用的 K 线。

## 接口

| 方法 | 对外路径 | 用途 |
| --- | --- | --- |
| GET / HEAD | `/trade/api/signal/health` | 启动和代码版本检查，不调用币安/模型 |
| POST | `/trade/api/signal/analyze` | 分析一个交易对 |
| OPTIONS | `/trade/api/signal/analyze` | 不带 JWT 的 CORS 预检 |

也支持 CDN 去除 `/trade/api/signal` 前缀后回源 `/analyze`、`/health`；POST `/` 和 `/trade/api/signal/` 是分析别名。只读交易计划和查单使用独立的 POST `/trade/api/signal/orders`（或回源 `/orders`）。仅支持 HTTPS 上的业务调用；本地服务器 HTTP 由 FC/CDN 终止 TLS。

```http
POST https://yanxiao.me/trade/api/signal/analyze
Content-Type: application/json
X-JWT-Token: Bearer <北京现有接口签发的交易JWT>

{"symbol":"BTCUSDT","style":"trend"}
```

`style` 支持 `trend`（默认）、`reversal`、`neutral`，只接受 `symbol/style`，不能由请求指定模型地址、API Key、任意币安 URL 或价格数据。交易对受服务端环境变量白名单控制，最多四个 USDT 交易对。

响应含 `analysisId`、`status`、`opportunity`、`market`、`timing`、`model`、`codeVersion`：

- `candidate`：候选价位通过结构校验和最终价格核验，手动下单前须复核草稿并确认委托。保留 V4 的 `triggerVerified=false`，M1 判定见 `m1Trigger.triggered`。
- `watch`：等待条件或等待进入价位区间。
- `none`：暂无机会，入场/止损/方向为空。
- `expired`：分析耗时超限、价格明显偏移，或已越过止损/首个目标。`expiredReasons` 给出原因。

机会包含多空、入场区间、止损、目标、程序重算的盈亏比、触发/失效条件、支持证据和反对理由。不报告未经校准的胜率。定时分析的委托使用独立执行开关。盈亏比按入场区间不利端估算，不含手续费、滑点、资金费，也不计算仓位或杠杆。候选目标引用由合约成交 K 线计算的结构区域，机会状态通过最新**标记价格**复核。此版本是实时研究助手，没有经回测验证的收益承诺。

`market.chart` 由 `{ interval, candles }` 组成，提供本次分析使用的原始收盘 K 线。每行依次为 `[开盘时间戳（毫秒）, 开, 高, 低, 收, 成交量, 主动买量]`，按时间递增。`market.asOf` 是行情快照时间，`market.latestQuote` 是分析后的复核标记价格。

## FC 环境变量

FC 统一使用同域名的原生 JWT 策略，与同步函数复用同一凭证。**不需要任何 SIGNAL_JWT_*、SIGNAL_AUTH_MODE 或 SYNC_JWT_* 环境变量，旧值不再读取。** 下列配置使用默认 M1/M2 分析。手动百炼比较需单独设 `USE_DETERMINISTIC_MODELS=false`，并配置对应地域的百炼密钥和模型。

```json
{
  "SIGNAL_ALLOWED_SYMBOLS": "BTCUSDT",
  "PORT": "9000",
  "MARKET_DATA_MODE": "rest",
  "USE_DETERMINISTIC_MODELS": "true"
}
```

百炼 Key 与调用地域必须匹配。北京默认使用 `https://dashscope.aliyuncs.com/compatible-mode/v1`，新加坡可使用 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`。也接受百炼工作空间专属域名，如 `https://你的WorkspaceId.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`。使用控制台针对该 Key 给出的地址，模型服务地域由 API Key 和端点决定，与函数所在地域独立。代码只向明确列入白名单的百炼官方 HTTPS 域名发送 Key，禁止重定向。

百炼 `kimi-k3.1-pro` 的采样参数固定为 `temperature=1.0`、`top_p=0.95`、`presence_penalty=0.0`。代码按模型名自动设置温度为 1，其余两个参数不传，使用服务端默认值；其他模型沿用温度 0.1，无需新增温度环境变量。Kimi 建议先用 `DASHSCOPE_RESPONSE_FORMAT=json_object`、`DASHSCOPE_ENABLE_THINKING=false` 验证完整调用。这里保持既有的非思考请求模式；若改用 `omit` 交由模型默认启用思考，需另行评估输出预算和超时。参考：[百炼 Kimi 参数约束](https://www.alibabacloud.com/help/en/model-studio/kimi-api#default-parameters)。

模型失败时，HTTP 错误响应和 `analysis_failed` 日志保留 `upstreamStatus`，并按可用情况提供 `upstreamCode`、`upstreamRequestId`。上游错误正文只进行最多 8 KiB 的有界读取，代码仅允许已知错误码和 UUID/32位十六进制请求编号进入诊断字段；原始错误消息、未知字段和 HTML 不记录或透传。不自动重试。`MODEL_UNAVAILABLE` 加 `upstreamStatus=400` 应优先检查参数；404 检查模型 ID、开通状态和地域；5xx 根据上游请求编号排查服务异常。

函数的 HTTP 请求由 FC 自定义域名上的原生 JWT 策略验签，函数读取 `X-JWT-Token` 里的声明。分析使用 `sub` 和 `exp`，HTTP 业务请求无需附带 `x-fc-*` 元数据。信任边界是 FC 的原生 JWT 入口，默认 FC 域名的业务 POST 会被拒绝。

CDN 的业务 POST 使用已开启原生 JWT 且覆盖业务路径的 FC 自定义域名回源。CI 仅更新并验证函数代码、运行时、版本及健康状态，FC 控制台负责维护自定义域名和鉴权策略。定时任务经独立的 `/invoke` 事件入口调用，运行时要求 FC 标记的事件类型。

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

业务校验失败时查看 `validation.reason`。例如，`zone_not_found` 表示本次快照缺少引用区域，`zone_broken` 表示区域已突破，`entry_out_of_bounds` 同时记录入场上下限、原始区域上下限及按价格步长计算的 `selectablePriceRange`。目标越界也记录对应区域的可选范围。止损方向或距离、阻挡区域和价格步长有各自的原因及数值上下文。格式不合法的模型区域 ID 只记录为 `malformed`。这些字段只进入 FC 日志。

日志的 `exception` 保留最多四层异常类型、受控的错误码和服务模块行号，可以区分 DNS、连接超时、断线及 JSON 格式错误。HTTP 错误响应保持原有结构。日志仅采集诊断字段，不采集 Token、API Key、请求正文、完整模型输出或上游异常原文。

### V4 数据契约

- `schemaVersion=4`。规则分析版本标记为 `deterministic-m1-m2-v1`。手动百炼比较提示词标记为 `market-research-v4-volume-timing-v8`。保留 `opportunity`、`market.chart`、历史解析和当前 JWT 接口。
- 手动和自动分析共用收盘等待与重试机制。每次分析核对 4h、1h、15m 的最新应收盘时间，自动分析另核对 5m，必要时重试，仍未发布则返回 `MARKET_CANDLE_NOT_READY`。取数期间跨过触发周期的新收盘边界时重新构建快照。模型输入的 `latestClosedAt` 表示各周期最后一根的收盘边界，每根 K 线仍以开盘时间标识。
- `market.frames` 保留各周期的趋势、ATR 百分比、波动状态、最近 5 根量价细节及 5/20/50 根阶段统计。RVOL20 以此前 20 根均量为分母，CLV 取值为 −1 到 1。量比达到 1.5 或降至 0.75 时分别标记放量和缩量。OI 按两个相邻整点与 1h 已收盘价格对齐，缺失值保留为空。
- 每个摆动点等待后两根 K 线收盘确认。新摆动点与同类区域聚类时，中心跨度上限取初次和本次确认 ATR14 的较小值乘 0.5。区域在极值外扩初次确认 ATR 的 0.15，外扩上限为价格的 1%。区间 ID 由周期、原始支阻类型和第一个摆动点的开盘毫秒组成。聚类扩张后，以最后确认时点起跟踪最终边界的突破和回测，保留量比及触达反应。每周期保留每类离最新成交收盘价最近的 6 个区间。区域来自摆动结构，成交量证据为整根 K 线的观察量。
- 模型从区间 ID 中选择入场、失效和目标依据。失效区和 1h ATR 用作止损研究参考。程序校验止损在入场区间的不利侧、步长及价格尺度，并在下单前执行配置的价差风险上限。目标按方向排序，较近的有效 4h 区域或触达至少两次的独立区域须优先设目标。全市场 `exchangeInfo` 按实例缓存 1 小时，读取 `PRICE_FILTER.tickSize` 并校验各价位。程序保留模型提交的价位或返回诊断。
- 模型输入的区域额外附带 `selectablePriceRange`，用于入场和目标选价。程序按价格步长向区间内取整，下界上取整，上界下取整。区域已突破或范围内无可用价位时，该字段为空。入场的两个端点都须落在同一个引用区域。入场价越界但其他校验通过时，返回无计划的 `watch`，显示模型原区间和可选范围，原因代码为 `entry_out_of_bounds`。
- 目标按价格路径跨周期排序。模型输入的 `effectiveKind` 和 `importantObstacle` 标明区域的有效支阻与重要性。模型若跳过更近的重要区域，其余校验通过时保留已校验的行情解读，返回无计划的 `watch`，摘要说明首个被跳过的区域。
- `research` 包含市场状态、情景、三周期结论、价格区间、风险、目标评估和规则结果。目标距离、1h ATR 倍数和 R 以入场区间的不利端计算；历史波动分位数用快照前不重叠的 1h 成交 K 线窗口计算，并附样本数。4h / 12h / 24h 研究窗口独立于 30–300 秒的 `validForSeconds`。模型给出方向但将入场区间明确设为 `null` 时，保留行情解读并返回无计划的 `watch`，清除价格、区间引用和执行条件。已有入场区间的方案继续通过原有数值和结构校验。
- 手动百炼比较使用 `1/(1+R)` 作为忽略成本的盈亏平衡门槛，定性判断证据能否支持尝试。时机尚未完全确认但权衡有利时可以给出候选，并说明提前入场风险。等待应有明确、足以改变结论的理由。
- 研究结果通过 `triggerConditions` 记录入场前复核条件，在 `invalidationConditions` 写出「未入场失效」和「持仓提前退出」。这些条件用于人工复核，结构止损和目标仍使用 `stopLoss` 和 `targets`。

### M1 触发评分

手动和自动分析都由 `analysis.ts` 调用 `MarketDataProvider.snapshot()`。4h、1h、15m 使用同一快照时间构建已收盘的趋势、价格区域和波动特征。自动分析另外读取已收盘 5m K 线，作为 M1 的形态、收盘价和相对成交量输入，保存在 `market.triggerFrame`。15m 仍提供趋势、价格结构及 ATR，M2 的价格和风险距离继续用 15m ATR。手动分析使用 15m 收盘触发，可选 WebSocket 模式在缓存缺口时用 REST 补齐。

在百炼模式中设置 `USE_M1_TRIGGER=true` 后，手动分析响应附带 `m1Trigger`，包含 `triggered`、`score`、`reasons`、`keyFeatures` 和 `confidence`。该开关默认关闭。启用后可对照 `m1Trigger` 与 `decision.modelStatus` 查看程序评分和百炼判断。

| 规则 | 分数 | 默认条件 |
| --- | ---: | --- |
| 形态 | 30 | `trend` 要求 4h、1h 同向且触发周期收盘涨跌方向与之相符。`reversal` 使用触发周期的放量下影收复或上影受阻。`neutral` 优先顺势，未匹配时检查反转。 |
| 区域 | 25 | 触发周期的成交收盘价距同向有效区域不超过 1 倍 15m ATR14。做多看支撑，做空看阻力，排除已跌破的支撑、已站上的阻力及状态为 `broken` 的区域。 |
| 相对成交量 | 25 | 触发周期 RVOL20 ≥ 1.2，分母为该周期此前 20 根均量。放量影线标签沿用 RVOL20 ≥ 1.5。 |
| 多周期趋势 | 5 或 10 | 两个周期与信号方向一致得 5 分，三个周期一致得 10 分。 |
| 波动率 | 10 | 15m ATR14 占收盘价的百分比在 0.05% 至 2% 之间，含边界。 |

形态、区域、波动率条件均满足且总分至少 80 时触发。触发后，95 分起为 `high`，其余为 `medium`，未触发为 `low`。分数和置信度表示规则吻合程度，尚未用历史收益校准。阈值集中在 `src/m1-trigger.ts`。本地运行 `npm test` 可验证评分、手动响应与自动归档。

### M1 + M2 规则分析

手动分析默认使用 M1 和 M2，留空或设 `USE_DETERMINISTIC_MODELS=true` 即可。显式设为 `false` 时，手动分析返回百炼研究结果，订单票据仅由规则分析生成。自动分析固定使用 M1/M2，无需配置百炼。

| 环节 | M2 默认规则 |
| --- | --- |
| 入场 | 使用 M1 引用的有效区域，标记价距区域最多 0.5 倍 15m ATR14。将标记价限制在区域内作为中心，向两侧各扩 0.15 倍 ATR，取与区域和距离限制的交集并按步长向内取整。 |
| 止损 | 做多放在支撑区下沿外，做空放在阻力区上沿外。区域缓冲至少 0.15 倍 ATR 或一个价格步长中的较大值，入场近端到止损至少 0.5 倍 ATR。按入场不利端计算的风险距离最多 2 倍 ATR。 |
| 目标 | 按路径选取对向确认区域的近端可用价位，最多两个。首个目标至少 1.5R，目标距入场不利端最多 6 倍 ATR。实单沿用首个目标作为止盈保护价。 |

响应和自动归档包含 `decisionSource: "deterministic"`、`m1Trigger` 与 `m2Order`。M1 未触发时返回 `none`。M1 触发但 M2 无合法方案时返回无交易计划的 `watch`。M2 有方案时，`opportunity` 及其最终状态来自现有结构校验和标记价复核。订单预览及提交继续校验盘口、交易所过滤器和账户风险上限，自动提交只接受通过复核的 `candidate`，并受独立执行开关控制。规则参数在 `src/m2-order.ts` 中，尚待历史回放校准。


## HTTP触发器与CDN

将 `/trade/api/signal/*` 回源本函数，`/trade/api/sync/*` 仍回源原同步函数。业务方法 POST，允许 OPTIONS 预检，使用 HTTPS 回源、禁止缓存、原样透传 `X-JWT-Token`/JSON请求体，不通过重定向切换接口。CDN/浏览器等待预算需覆盖函数的默认65秒分析预算；平台不支持该等待时间时需要调整预算或另行实现流式/异步协议。

沿用 `X-JWT-Token: Bearer <JWT>`。FC 在该请求头验签，票据提取前缀配置为 `Bearer `。函数读取同一个请求头的声明。订单另外验证签发方、受众、操作范围、时效、草稿绑定和归属。验签公钥只在 FC 原生 JWT 的 JWKS 中维护，环境变量 `SIGNAL_ORDER_JWT_PUBLIC_KEY` 和本地验签用的 `BINANCE_SYNC_KEY_ID` 可以从本函数移除。签发端继续使用已有签名配置。由网关处理无 JWT 的 OPTIONS 预检，CORS 仅允许 `https://yanxiao.me` 和 `https://www.yanxiao.me`。

## 小规格实例的实现

- 每实例最多一个分析任务，额外请求429，不排队、不自动重试；该限制不是跨实例的全局限流。对全局调用量有要求时应另加网关配额或共享限流。
- 行情请求并发最多2；每周期向模型传入最近最多200根已收盘K线和程序计算的指标摘要。K线以紧凑数组传入，字段为开盘时间、开高低收、成交量和主动买量。
- 4h/1h/15m 及自动分析的 5m K 线以币安 UTC 周期为准。每周期至少使用 60 根连续的最新已收盘 K 线。
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

部署 RAM 身份只需目标函数的 `fc:GetFunction`、`fc:UpdateFunction` 和 `fc:InvokeFunction`。

部署前核对现有 `binance-market-signal`：`ap-southeast-1`、`custom.debian12`、0.35vCPU、512MB、10240MB磁盘、9000端口；不匹配时写入前停止。**保留控制台已有的 Node.js 24 层与 PATH**。部署将启动命令改为 `/bin/sh /code/bootstrap`（从原命令保留已有Node解释器绝对路径），超时120秒。部署保留环境变量、层、角色、资源、网络及健康检查配置。通过代码核验后单独同步分析定时器的 Cron。

CI编译并将约数十KB的代码ZIP直接上传FC，不依赖北京OSS；校验远端代码CRC64、配置保留情况，再通过RAM `InvokeFunction` 的 `{"action":"health"}` 做冷启动探测，检查 Node 主版本24和本次Git提交号。探测不调用百炼/币安、不需要配置模型Key。部署异常不自动覆盖重试，不将SDK原始异常或配置值打印到日志。

## 自动分析、历史查询和订单的 OSS 配置

使用 `OSS_BUCKET`、`OSS_REGION`、`ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET`。地域填 Bucket 的地域 ID，比如 `cn-hangzhou`，Bucket 变量填桶名。`OSS_NETWORK` 可选，默认 `public`，使用 OSS 内网域名时填 `internal`。

已有的 `SIGNAL_ORDER_OSS_BUCKET` / `SIGNAL_ORDER_OSS_REGION` 可以直接沿用，其次兼容旧的 `SIGNAL_SCANNER_OSS_BUCKET` / `SIGNAL_SCANNER_OSS_REGION`。新 `OSS_*` 配置优先。Bucket 和地域须来自同一组。各业务使用独立的对象前缀。两者之前分桶时，默认沿用订单桶以保留订单记录和在途锁。原扫描记录仍留在旧桶，需要回查时可将扫描前缀的历史文件迁入共用桶并保持对象键名。不要在有在途或持仓订单时切换订单桶。

遇到 `SCAN_STORAGE_CONFIGURATION` 时，在 `market_auto_analysis_failed` 或 `market_scan_request_failed` 日志查看 `configurationField`，按变量名检查值。日志不包含变量值。

## BTCUSDT 开仓、止盈和止损

网站所有者可在交易日志的行情分析面板打开「测试网订单验证」。`demo-plan` 仅在 `SIGNAL_ORDER_MODE=demo` 时可用。它用 BTCUSDT 测试网盘口、价格步长和既有风险上限生成短期测试计划，使用原有订单票据、预览和手动确认流程。生成测试草稿无需调用模型，也不会创建分析历史。打开执行开关且保护任务就绪后，可以在测试网验证开仓、止损、止盈和查单。

市场处于候选状态时，市价草稿展示入场参考价、止盈和止损。止盈使用研究的首个目标，止损使用研究失效价。程序复核价格步长、方向、入场范围、最新标记价格及计划价差风险。计划风险估算未计手续费、滑点和资金费。

实盘和测试网均支持手动确认提交回踩限价和条件限价。回踩限价使用只挂单 `LIMIT/GTX`。条件限价使用 `STOP/GTC`，标记价达到触发价后由币安生成限价委托。挂单提交后约两分钟开始由 `market-order-protection` 尝试撤销未成交委托。这是任务处理期限，币安实际撤单时间取决于任务运行和接口响应。确认部分成交时尝试撤销未成交余量，为已观察到的成交量对应仓位挂保护单，待余量终止后才将保护标记为齐全。条件限价以币安生成的子委托成交为准。下单请求结束后的成交由定时任务确认，止损生效时间取决于下一次任务执行和交易所响应。订单验证入口继续使用测试网凭据，实盘挂单从行情分析的订单草稿进入。

网站所有者确认后，服务端先发送市价开仓请求。币安返回全额或部分成交后，按原价提交标记价格触发的 `STOP_MARKET`，收到止损有效确认后再发 `TAKE_PROFIT_MARKET`。二者均限定 BTCUSDT 的对应双向持仓方向，使用 `closePosition=true` 平掉该方向剩余持仓。开仓前要求 BTCUSDT 无既有持仓及挂单。执行期间应避免在同一账户用其他客户端建立 BTCUSDT 委托或仓位。币安分开受理三个请求，成交与止损生效之间存在风险窗口。

委托 ID 和计划在发送前写入 OSS。同一研究只发送一次开仓请求。开仓响应不明时按客户端订单编号查单。恢复任务仅继续保护已成交仓位，对未查到的保护单核对状态并有限重试。查单页面区分开仓成交、止损状态及止盈状态。确认仓位已平，恢复任务撤销剩余保护单，再释放开仓锁。如果原触发价已被越过、保护单被明确取消或恢复穷尽，页面提示立即核对保护状态，程序仍使用已确认的价格。参考 [Binance USDⓈ-M Trade API](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade)。

| FC 环境变量 | 用途 |
| --- | --- |
| `SIGNAL_ORDER_MODE` | 默认关闭。`demo` 使用测试网行情，`live` 使用生产行情。需要单独启用执行。 |
| `SIGNAL_ORDER_EXECUTE` | 执行开关，默认关闭。设为 `true` 且保护恢复任务就绪才允许新开仓。 |
| `BINANCE_BASE_URL` | 对应币安 USDT-M HTTPS 根地址。实盘只接受 `https://fapi.binance.com`，测试只接受 `https://demo-fapi.binance.com` 或 `https://testnet.binancefuture.com`。 |
| `BINANCE_API_KEY`、`BINANCE_API_SECRET` | 对应环境的 Binance HMAC 密钥。预览和查单使用合约读取权限。执行需开通合约交易权限并限制来源 IP。 |
| `SIGNAL_ORDER_QUANTITY` | BTC 数量，默认 `0.001`。交易所步长或最低名义额不满足时拦截，保留配置数量。 |
| `SIGNAL_ORDER_MAX_RISK_USDT` | 入场参考价至止损价的计划价差风险上限，默认 `1`，单位 USDT。 |

北京私有鉴权函数配置 `BINANCE_ORDER_TICKETS_ENABLED=true` 才会签发订单预览和提交票据。CDN 透传 `X-JWT-Token` 与请求体，保留订单路径或统一改写成 `/orders`，关闭缓存与自动重试。

启用执行前，在信号函数上配置 FC 定时触发器 `market-order-protection`，调度 `0 * * * * *`，触发消息可以留空。事件走 FC 的 `POST /invoke`。等待日志 `order_protection_recovery` 出现后再打开执行开关。恢复心跳超过 90 秒时拒绝新开仓。关闭执行开关后定时任务仍继续处理现有仓位，保留触发器和币安凭证直到仓位结束。[FC 定时触发器](https://www.alibabacloud.com/help/en/functioncompute/time-triggers)

研究订单引用和草稿由共用私有 OSS 按随机引用保存，客户端使用原有订单预览和提交票据。订单前缀下的 `<mode>/temporary/` 存放短时凭据，程序按有效期拒绝过期请求，可以在 OSS 对该精确前缀设一天的生命周期删除。已提交的市价订单和在途保护记录保持原路径。可从 FC 环境变量删除 `SIGNAL_ORDER_SIGNING_SECRET` 和 `SIGNAL_ORDER_RECOVERY_SECRET`。

预览需要 `oss:GetObject` 和 `oss:PutObject` 读取及写入短时凭据，历史查单使用 `oss:GetObject`。执行还需桶级 `oss:GetBucketVersioning`、订单前缀下 `oss:PutObject` 和对 `locks/btcusdt.json` 的 `oss:DeleteObject`。同一账户和模式的所有实例使用相同 OSS 桶和前缀。保留激活锁及执行记录，持仓期间不要更换币安 API Key、模式或前缀。遇到 `order_entry_unresolved`、`order_protection_requires_attention` 或 `ORDER_RECOVERY_RELEASE`，按分析编号及客户端订单编号核对成交、持仓和保护单。仅在停用新执行、确认无在途请求与未处置仓位后清理孤立锁。先使用测试网验证 FC、OSS 和币安链路，再启用实盘。

## BTCUSDT 定时 M1/M2 分析

1. 定时器 `binance-market-analysis` 使用 Cron `5 */5 * * * *`，在每根 5m K 线收盘后第 5 秒执行。代码部署核验通过后，工作流尝试更新已有定时器的 Cron，保留其启用状态和触发消息。自动更新需要 `fc:GetTrigger` 和 `fc:UpdateTrigger`。部署摘要出现 `analysisSchedule` 警告时，在 FC 控制台检查该定时器和 Cron。[FC 定时触发器](https://www.alibabacloud.com/help/en/functioncompute/time-triggers)
2. 设置 `SIGNAL_AUTO_ANALYSIS_DAILY_LIMIT` 为正整数以启用定时分析。留空或设为 `0` 时跳过定时分析。限额按 5m 收盘所属的北京时间自然日统计，每次 M1 触发且取得归档额度时占一次。同日原有 15m 记录继续计入额度，M1 未触发的收盘和手动分析不占用额度。
3. 定时入口以 `neutral` 风格使用 `RestMarketDataProvider` 获取 4h、1h、15m 结构数据及 5m 触发证据。事件超过该 5m 收盘三分钟或快照对不上该收盘时跳过。M1 通过才运行 M2，交易方案经结构、步长和最新标记价格复核。每根 5m 收盘独立去重，发生并发时只允许一个调用归档及继续执行。

| OSS 路径 | 用途与权限 |
| --- | --- |
| `private/market-signal-auto-analysis/v1/BTCUSDT/slots/<北京时间日期>.ndjson` | 定时分析去重和每日额度，需 `oss:GetObject` 和 `oss:PutObject`。Bucket 策略须允许追加对象。 |
| `<PRIVATE_RESOURCE_ROOT>/.trading/owner/market-signals/{records,index,review-queue,review-enqueued}/` | M1 触发后写入网站分析历史和 4h、12h、24h 复盘队列，需 `oss:PutObject`。扫描列表核对关联归档及读取详情需要 `records/` 的 `oss:GetObject`。根目录默认 `/private`。 |
| `private/market-signal-scanner/v1/` | 历史扫描及旧分析关联，只读，需 `oss:GetObject`。原 `POST /scans` 和关联归档读取接口继续可用。 |

归档默认使用共用 OSS 桶。网站历史使用独立桶时，可设置 `OSS_CONTENT_BUCKET` 和 `OSS_CONTENT_REGION`。自动扫描面板使用 `POST /scans` 的 `version: 4`，按时间显示 5m、既有 15m M1 评估与旧扫描记录。此前只保存了收盘时间和状态的记录继续显示这些字段。日志事件 `market_auto_analysis_run` 记录定时执行结果，`market_auto_analysis_completed` 关联归档编号，`market_auto_analysis_failed` 记录行情、配额或归档错误。M1/M2 的阈值为原型参数，尚待历史校准。

### 自动委托

`SIGNAL_AUTO_ORDER_EXECUTE=true` 与 `SIGNAL_ORDER_EXECUTE=true` 同时开启后，已归档的有效 `candidate` 可进入自动委托复核。复核使用与账户相同的 `BINANCE_BASE_URL`，沿用 `market-order-protection` 恢复心跳、最新盘口、入场区间、过期时间、既有持仓和委托检查、交易所过滤器以及价差风险上限。关闭自动执行开关时，定时任务只做分析及归档。

入口以最新对手价提交 `LIMIT/IOC`，确认成交后提交标记价止损和首个目标止盈。执行、保护和恢复沿用原订单路径。日志 `market_auto_order_outcome` 记录提交和保护结果，可用分析编号查单。

自动扫描的分析记录会显示 M2 首个未通过的条件和相应数值，也会保留后续报价复核的判定原因。自动候选方案的详情使用 `/scans` 的 `execution` 操作读取同一分析编号下的委托回报，区分未提交、拒绝、未成交、部分成交及待确认。缺少回报时显示暂无记录。该读取操作使用现有扫描鉴权和 OSS 配置。

## M1/M2 交易结果日志

日志复用现有分析归档的私有 OSS 桶和 `records/` 写入路径，无需新增环境变量。默认根路径为 `private/.trading/owner/market-signals/records/trade-results/v1/`。每个 JSON 对象包含 `schemaVersion: 1`，通过 `analysisId` 关联。

| 相对路径 | 内容 |
| --- | --- |
| `decisions/<analysisId>.json` | 手动和定时确定性分析的决策记录，包含请求和扫描编号、时间、代码与规则版本、完整 M1/M2 输出、报价复核结论，以及当时的行情快照。包含 M1 未触发和额度已用完的收盘，定时重复调用只留一条。快照保留结构区、指标和各周期原始收盘 K 线，供后续人工或离线模型回放、修改规则及比较新旧规则。 |
| `outcomes/<analysisId>/<phase>.json` | 分析跳过或失效记录、委托回报、保护恢复观察，以及确认的终局。`finalStatus` 取 `win`、`loss`、`breakeven`、`expired`、`cancelled`、`not_executed` 或 `null`。待提交的手动草稿可按 `validUntil` 判断是否过期，之后执行的订单由单独的回报关联。 |

保护恢复在可核对开仓和保护退出成交数量一致时，依据币安成交均价记录退出价、估算的毛已实现盈亏和 R 倍数，费用与资金费未计入。成交订单的更新时间齐全时记录退出时间和持有时长。手动平仓或成交证据不足的退出保留 `finalStatus: null`，不以行情触及目标或止损替代真实成交。分析及委托照常处理，OSS 日志写入失败单独记录 `trade_result_log_failed`。

## 本地验证

```sh
npm ci --ignore-scripts
npm run check
npm test
python3 -m pip install -r scripts/requirements-deploy.txt
python3 -m unittest discover -s test -p 'test_deploy_fc.py' -v
npm run package
```

测试使用模拟 REST、OSS 和币安委托接口，覆盖新旧定时入口、收盘重试、M1/M2、每日额度、并发去重、归档及保护委托风险校验。另覆盖手动接口、历史扫描读取、WebSocket 缓存补齐、交易结果日志和部署配置保留。

参考：[FC自定义运行时](https://www.alibabacloud.com/help/en/functioncompute/custom-runtime/)、[百炼兼容接口](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)、[币安USD-M行情](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)。
