# Luffy 人生私董会

12 位智者（乔布斯、Paul Graham、马斯克、Naval、芒格、塔勒布、曾国藩、稻盛和夫、任正非、张一鸣、王阳明、老子）同时为你的人生抉择出谋划策。一个最小的 Node.js + SQLite + SSE demo。

## 快速开始

```bash
npm install
cp .env.example .env       # 填上 NVIDIA_API_KEY
npm run dev
# → http://localhost:3001
```

## 流程

1. **澄清（step 2）**：主持人镜像情绪 + 1 个澄清问题；2-4 轮后输出 `【议题锁定】`
2. **发言（step 4）**：根据议题里"推荐幕僚"自动选 4-6 位同时流式发言；可对任意一位继续追问
3. **汇总（step 7）**：秘书生成结构化报告（核心张力 / 关键洞见 / 争议焦点 / 行动清单 / 7 天小实验）

## 核心能力

| 能力 | 说明 |
|---|---|
| 持久化 | SQLite，重启不丢 session |
| 鉴权 | Cookie 匿名 owner token；session 仅 owner 可见 |
| 限流 | per-IP 滑动窗口（默认 5 召集/小时、60 LLM 调用/小时） |
| 中断恢复 | 已写 persona 直接回放（不重复扣 LLM 配额）；前端按 `step` 自动跳页 |
| 错误兜底 | 创建阶段重试 1 次 + 超时；单路失败可重试，整体不挂起 |
| 推荐解析 | 主持人锁定时识别 `【议题锁定】` 中点名的幕僚，仅跑这部分 |
| 历史 / 分享 | `/history.html` 列出当前 cookie 拥有的 session；`/shared.html?t=token` 公开只读视图 |
| 导出 | phase 7 一键导出 Markdown |
| 追问 | 每位幕僚独立线程，刷新可恢复 |

## 路由

| Method | Path | 说明 |
|---|---|---|
| `POST` | `/api/sessions` | 建会，返回 `{id, question}`，下发 cookie |
| `GET`  | `/api/sessions` | 列出当前 cookie 拥有的 session |
| `GET`  | `/api/sessions/:id` | 获取 session 全量状态 |
| `POST` | `/api/sessions/:id/facilitator` | SSE：主持人对话，body `{message}` |
| `POST` | `/api/sessions/:id/personas` | SSE：触发幕僚发言（缓存命中即回放）；可选 body `{personas:[id...]}` 覆盖选择 |
| `POST` | `/api/sessions/:id/personas/:pid/followup` | SSE：对单位幕僚追问，body `{message}` |
| `POST` | `/api/sessions/:id/summary` | SSE：秘书汇总（缓存命中即回放） |
| `POST` | `/api/sessions/:id/share` | 创建/获取分享 token（幂等） |
| `DELETE` | `/api/sessions/:id/share` | 撤销分享 |
| `GET`  | `/api/share/:token` | 公开只读视图数据 |

## 开发

```bash
npx tsc --noEmit          # 类型检查
node --test test/         # 跑测试
```

数据文件在 `data/luffy.db`（git ignore）。删了即重置。

## 当前限制

- 完全本地：无水平扩展（限流和 prepared statements 都是单进程）
- 没有 retry budget：若 LLM 服务持续抖动，仍会按限流额度耗尽
- shared.html 暂不渲染追问线程
- 没有真人专家路由：`facilitator.ts` 提示词包含心理危机引导语，但目前只是文字
