# binance-market-signal

新加坡（`ap-southeast-1`）阿里云 FC 自定义运行时服务。Node.js 24 / Debian 12，监听 `0.0.0.0:9000`，适配 0.35 vCPU、512 MB 内存、10 GB 临时磁盘。TypeScript 编译为 JavaScript，部署包没有运行时第三方依赖。

一次请求完成：币安公开行情 → 收盘K线/指标 → 百炼分析 → 最新标记价格再次核验 → 返回候选机会详情。原始行情、提示词和分析结果均不写 OSS、数据库或本地磁盘。日志记录请求编号、状态、耗时及模型失败时经过白名单过滤的诊断字段，不记录 JWT、密钥、模型完整回复或请求头。

## 接口

| 方法 | 对外路径 | 用途 |
| --- | --- | --- |
| GET / HEAD | `/trade/api/signal/health` | 启动和代码版本检查，不调用币安/模型 |
| POST | `/trade/api/signal/analyze` | 分析一个交易对 |
| OPTIONS | `/trade/api/signal/analyze` | 不带 JWT 的 CORS 预检 |

也支持 CDN 去除 `/trade/api/signal` 前缀后回源 `/analyze`、`/health`；POST `/` 和 `/trade/api/signal/` 是分析别名。其他业务路径返回 404。仅支持 HTTPS 上的业务调用；本地服务器 HTTP 由 FC/CDN 终止 TLS。

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

机会包含多空、入场区间、止损、目标、程序重算的盈亏比、触发/失效条件、支持证据和反对理由。不报告未经校准的胜率，不自动下单。盈亏比按入场区间不利端估算，不含手续费、滑点、资金费，也不计算仓位或杠杆。价格全部以**标记价格**为参照，不等同于实际成交报价。此版本是实时研究助手，没有经回测验证的收益承诺。

## FC 环境变量

FC 统一使用同域名的原生 JWT 策略，与同步函数复用同一凭证。**不需要任何 SIGNAL_JWT_*、SIGNAL_AUTH_MODE 或 SYNC_JWT_* 环境变量，旧值不再读取。**只需配置 `DASHSCOPE_API_KEY`，并建议明确百炼地域端点与模型。示例值中的占位符必须替换：

```json
{
  "DASHSCOPE_API_KEY": "填写百炼API Key",
  "DASHSCOPE_BASE_URL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "DASHSCOPE_MODEL": "qwen-plus",
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
| `DASHSCOPE_MAX_TOKENS` | `2000` | 输出上限，范围512–4096；截断结果会被拒绝 |
| `BINANCE_TIMEOUT_MS` | `8000` | 每个行情请求超时，范围1000–15000 |
| `SIGNAL_REQUEST_TIMEOUT_MS` | `65000` | 完整请求预算，范围5000–110000 |
| `SIGNAL_MAX_ANALYSIS_AGE_MS` | `60000` | 从请求开始计算的机会时效上限，范围5000–110000 |
| `SIGNAL_MAX_PRICE_AGE_MS` | `5000` | 最终报价最大年龄，范围1000–15000 |
| `SIGNAL_MAX_PRICE_DRIFT_BPS` | `30` | 分析期间最大允许价格偏移，30基点=0.3%，可配置1–500 |
| `SIGNAL_COOLDOWN_SECONDS` | `10` | 同一 subject 在单实例内的分析间隔，范围0–300 |

没有 OSS 或币安账户密钥环境变量。百炼 Key 只放 FC 环境变量，不需要放 GitHub Secrets。`GET /health` 成功只说明服务启动成功，不说明密钥、模型权限或币安行情已经验证。

## HTTP触发器与CDN

将 `/trade/api/signal/*` 回源本函数，`/trade/api/sync/*` 仍回源原同步函数。业务方法 POST，允许 OPTIONS 预检，使用 HTTPS 回源、禁止缓存、原样透传 `X-JWT-Token`/JSON请求体，不通过重定向切换接口。CDN/浏览器等待预算需覆盖函数的默认65秒分析预算；平台不支持该等待时间时需要调整预算或另行实现流式/异步协议。

沿用 JWT Header 名称 `X-JWT-Token`，值为 `Bearer <JWT>`；不要使用会被 CDN OSS 回源鉴权占用的 Authorization。FC 必须保持原生 JWT 启用，控制台保留公钥与 `X-JWT-Token` 读取位置，去掉 `Bearer ` 前缀。函数不再配置单独的用途或公钥，沿用同步凭证和原生域名鉴权。确保无JWT的 OPTIONS 由网关直接处理；不能将分析路径加入免鉴权名单。CORS 仅允许 `https://yanxiao.me`、`https://www.yanxiao.me`，不携带网站 Cookie。此工作流不修改 HTTP 触发器、CDN 或原生JWT策略。

## 小规格实例的实现

- 每实例最多一个分析任务，额外请求429，不排队、不自动重试；该限制不是跨实例的全局限流。对全局调用量有要求时应另加网关配额或共享限流。
- 行情请求并发最多2；每周期最多200根收盘K线，模型只接收每周期最近24根及程序计算的摘要。
- 1h/4h/1d K线以币安UTC周期为准，剔除未收盘K线；缺失、不连续、过期的必需数据直接失败。
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
