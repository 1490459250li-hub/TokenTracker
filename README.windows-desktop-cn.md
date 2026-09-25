# TokenTracker · Windows 桌面定制分支（windows-desktop-cn）

> 本分支基于 [TokenTracker v0.97.2](https://github.com/xiufengsun/TokenTracker)（MIT License）二次开发，
> 面向 **Windows 桌面用户**，聚焦**数据 100% 本地**、**API 直连**与**国产大模型**生态。
> 在上游 v0.97.2 的 39 个数据源基础上，本分支新增 4 个 API 直连/小浣熊来源，并合入官方 MiniMax Code 源，共 **44 个主动扫描源**；另有 `sensenova-api` 经 shim 记账进统计。
>
> 与上游 `main` 保持独立并行，不合并、不覆盖。本文件是此分支的专属说明，
> 不替换上游的 `README.md` / `README.zh-CN.md`。

---

## 分支定位

上游版本持续演进，官方默认体验包含云同步、排行系统、成就系统与 telemetry 遥测。
本分支按个人使用场景做了**定向裁剪 + 定向增强**：

| 维度 | 上游默认 | 本分支 |
|---|---|---|
| 数据存储 | 全本地，但保留云同步入口 | **100% 本地**：删除登录、遥测、云同步、自升级 |
| 排行 / 成就 | 15 个成就轨、全球排行榜 | **已移除**，避免任何数据外传入口 |
| 遥测 | 内嵌 posthog-js 等 SDK | **完全剔除**，网络只用于主动调 API |
| API 直连 | 需第三方中转 | **内置本地反向代理 shim**，直连 DeepSeek / MiMo / 日日新 |
| 国产模型 | 部分支持 | **深度适配**：商汤小浣熊、MiMo 双体系、SenseNova Flash-Lite |
| 限额页 | 订阅额度监控 | **三张 API 套餐卡** + 趋势线 + 宠物双池血条 |

---

## 核心定制点

### 1. 商汤小浣熊适配器（`raccoon-api`）

本分支的招牌功能。直接读取小浣熊本地会话数据库
（`%APPDATA%\office-raccoon\local-chat.sqlite3`）中的 turn 级用量元数据，
把商汤日日新小浣熊的 token 消耗接入 TokenTracker 主页统计。

- **读取方式**：数据库只读副本（拷贝 `db + wal + shm` 到临时目录再连），绝不锁库、不干扰客户端
- **增量游标**：按 `messages.id` 水位断点续读，只处理新增记录
- **模型识别**：读取 `default-session-model-binding.json` 的全局模型绑定
- **输出**：归一化为 `source=raccoon-api` 的半小时桶行，进主页 Token 总数与成本统计
- **实测**：历史 226 条 turn 已回填 107 个半小时桶，约 11.78 亿 tokens（模型 `sn-glm-5-3-flash`）

### 2. API 直连本地反向代理（shim）

删除云同步后，通过本地反向代理 shim 直连大模型厂商 API，
**key 只保存在本地文件 `~/.tokentracker/api-shim/config.json`**，绝不外传。

- 监听 `127.0.0.1:17444`，按 `config.json` 的 `upstreams` 字典驱动
- prefix 自动生成 `/upstream.key`，SDK 可直接设 `base_url`
- 记账写 `usage.jsonl`（同步管线从这里读取，进主页统计）
- 支持 `POST /reload` **热重载**，改完配置立即生效（含重建前缀路由表）
- 已接入上游：**DeepSeek**、**MiMo Token Plan**、**MiMo 按量**、**SenseNova 日日新**

### 3. MiMo 双体系接入

小米 MiMo 有两套不互通的 key 体系，本分支两者都接：

- **`mimo`**（Token Plan 套餐）：`token-plan-cn.xiaomimimo.com`，套餐专属 key
- **`mimo-payg`**（开放平台按量）：`api.xiaomimimo.com`，普通 API key
- 两条上游在限额页分别展示花费，血条按套餐/按量分池
- 修复了 shim 热重载后不重建前缀路由表的 bug

### 4. 限额页三张 API 套餐卡

限额页从"订阅额度监控"重构为 **API 直连套餐管理**：

- 三张卡：DeepSeek API / MiMo Token Plan / MiMo 按量
- 每张卡：预算线、已花费、趋势线走势图、保存 toast
- 宠物头顶显示**像素风双池血条**，随 API 花费实时变化

### 5. SenseNova Flash-Lite 专属池

日日新 SenseNova 在限额页单列 Flash-Lite 专用配额池，
并修复了 CORS scope 在 shim 转发路径中的问题。

### 6. key 连接测试

设置页每个上游配 `测试连接` 按钮，一键验证 key 与 base_url 连通性
（修复了缺 local-auth 头导致误报 403 的问题）。

### 7. 本地定价引擎

- 基于 LiteLLM 快照 + `curated-overrides.json` 覆盖 + 用户 `pricing.json`
- 已内置 MiMo、SenseNova 等国产模型单价
- 未发布官方牌价的模型按 0 占位，不虚报成本

---

## 数据源清单

**44 个主动扫描源**（上游 v0.97.2 基线 39 个 + 本分支新增 4 个 + 官方 v1.0.0 合入的 MiniMax Code；
只读本地会话日志，不读 prompt、不读文件内容）：

```
acode · antigravity · anythingllm · claude · claude-science · codebuddy · codex
copilot · craft · cursor · devin · droid · dsh · deepseek-api · every-code · gemini
goose · grok · hermes · kilo-cli · kilocode · kiro · kimi · kimi-code · lmstudio
mimo · mimo-api · mimo-payg · omo · omp · opencode · openclaw · pi · qoder
qoder-cn · raccoon-api · reasonix · roocode · sensenova-api · trae-cn · unsloth
workbuddy · zcode · zed
```

> 注：`raccoon-api`、`sensenova-api`、`mimo-api`、`mimo-payg`、`deepseek-api`
> 为本分支独有或强化的来源。

---

## 与上游的差异（截至基线 v0.97.2）

**已移除（按隐私原则）**
- 云同步、登录、自升级
- 15 个成就系统、全球排行榜
- posthog 遥测 SDK 等所有 telemetry
- ShareModal 中遗留的 `insforge` 裸引用（已修复运行时崩溃）

**已合入：官方 v0.97.2 ~ v1.0.7 可用功能（cherry-pick）**
- **按行定价修复**（v0.99.0）：model-breakdown 逐行 `computeRowCost`，与首页成本对齐（修复 Fast 档/长上下文/厂商自报成本被求和吞掉的问题）
- **DeepSeek V4.1 Flash 定价**（v0.98.0）：`deepseek-v4.1-flash` / `deepseek-flash` 官方价，含峰谷减半
- **MiniMax Code 数据源**（v1.0.0）：新增 `minimax-code`，读 `~/.minimax/v2/sessions/**/messages.jsonl`
- **Reasonix Windows 路径修复**（v0.99.0）：找 `%APPDATA%
easonix`，并从根递归扫描
- **mimocode.db Windows 路径修复**（v1.0.6）：MiMo Code 数据在 Windows 也能找到
- **宠物隐藏 Alt+Tab / Win+Tab**（v1.0.6）：加 `WS_EX_TOOLWINDOW`，任务切换器不再显示宠物
- **Antigravity 缓存/推理 token 读取**（v0.98.0）：从 sqlite usage metadata 读 cached input + reasoning tokens

**仍未合入（按隐私/平台原则不引入）**
- posthog-js 遥测 SDK、云同步/边缘函数（edge-patches 相关）、leaderboard/成就系统
- 官方 macOS / Linux 专属修复（灵动岛、托盘贴边等）
- Tencent Hy4、GPT-6 Sol 定价（用到再补）

> 万亿级计数本分支已具备：`format-tokens.js` 输出 `T` 后缀，`format.ts` 输出中文「万亿」。

---

## 构建与运行

```powershell
# dashboard 构建（含桌面宠物）
$env:TOKENTRACKER_BUILD_PET=1
npm run build --prefix dashboard

# 本地运行
npm run serve
# 打开 http://localhost:7680

# 打包 Windows 桌面版
powershell -ExecutionPolicy Bypass -File bundle-node.ps1
```

API shim 配置示例见 `src/api-shim/config.example.json`，
复制为 `~/.tokentracker/api-shim/config.json` 填入自己的 key。

---

## 许可

本项目基于上游 [TokenTracker](https://github.com/xiufengsun/TokenTracker) MIT 许可二次开发，
遵循上游 [LICENSE](./LICENSE) 全部条款。第三方依赖见 `THIRD_PARTY_NOTICES.md`。