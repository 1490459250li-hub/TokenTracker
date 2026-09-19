# API Shim — 本地反向代理记账

让 **API 直连调用**（DeepSeek、小米 MiMo 等任何 OpenAI 兼容端点）也能被 TokenTracker 精确统计。

## 原理

你的应用 → 本地 shim（127.0.0.1:17444）→ 真实上游。
shim 透传请求/响应，同时从响应的 `usage` 字段读出**精确 token 数**（不是估算），追加写入
`~/.tokentracker/api-shim/usage.jsonl`。同步管线（`src/lib/api-shim-source.js`）读取该文件，
以 `deepseek-api` / `mimo-api` 来源进入 dashboard。只记录 token 计数/模型/状态/耗时，
**从不落盘对话内容**；API key 只发往你配置的上游。

## 使用步骤

1. 生成配置：

   ```powershell
   mkdir "$env:USERPROFILE\.tokentracker\api-shim" -Force
   copy src\api-shim\config.example.json "$env:USERPROFILE\.tokentracker\api-shim\config.json"
   ```

2. 编辑 `%USERPROFILE%\.tokentracker\api-shim\config.json`，填入两个上游的 `api_key`。

3. 启动（独立版用户）：

   ```powershell
   & "C:\Users\Flish\Desktop\token\TokenTracker-standalone\EmbeddedServer\node.exe" `
     "C:\Users\Flish\Desktop\token\TokenTracker-standalone\EmbeddedServer\tokentracker\src\api-shim\server.js"
   ```

   开发环境：`node src/api-shim/server.js`

4. 把你应用的 `base_url` 改指向 shim：

   | 上游 | 原 base_url | 改为 |
   |---|---|---|
   | DeepSeek | `https://api.deepseek.com` | `http://127.0.0.1:17444/deepseek` |
   | MiMo | `https://token-plan-cn.xiaomimimo.com/v1` | `http://127.0.0.1:17444/mimo/v1` |

   请求路径其余部分不变。API key 填任意非空值即可（shim 会替换成配置里的真实 key）。

5. 正常跑你的应用，然后执行 `tokentracker sync`（或等托盘自动同步），dashboard 会出现
   **DEEPSEEK-API** / **MIMO-API** 来源。

## 已支持工具状态检查

- 托盘右键 → Open Dashboard：来源筛选里能看到所有已统计来源
- 命令行：`tokentracker status --json` / `tokentracker doctor`
- shim 自身：浏览器打开 `http://127.0.0.1:17444/healthz` 查看各上游配置与健康状态

## 定价

- DeepSeek：定价表内置，成本自动计算
- MiMo：打开 `src/lib/pricing/curated-overrides.json`，在 `exact` 里按已有条目格式补
  `mimo-v2.5` / `mimo-v2.5-pro` 的 `input`/`output` 单价（USD/百万 token，见你平台控制台），
  保存后下次刷新即生效，无需重新构建
