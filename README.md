# ModCraft · 方块梦工厂 v0.3

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

**线上地址**：https://modcraft.top ｜ **代码仓库**：https://github.com/xiaoheiHZ/modcraft

## v0.3 新增

- **10 个游戏版本、4 个代码代系**：`1.20 / 1.20.1 / 1.20.2 / 1.20.4 / 1.21 / 1.21.1 / 1.21.4 / 26.1 / 26.2 / 26.3`
- **26.x 新版本需要套餐或单次购买**解锁（前端锁定 + 后端强制校验）
- **四档套餐 + 单次购买（¥5 加油包）+ 订单系统**（默认人工确认收款，可配收款码；Stripe 通道预留）
- **管理后台**：`/admin.html`（统计 / 用户管理 / 订单确认 / 任务列表）
- 邮箱注册（未配置邮件服务自动激活；配 `RESEND_API_KEY` + `MAIL_FROM` 后用验证码）

## 套餐（worker/src/index.js 顶部 PLAN_DEFS 可改）

| 套餐 | 价格 | 模型 | 思考 | 单次 tokens | 每天 | 物品 | 26.x |
|---|---|---|---|---|---|---|---|
| 标准版 | ¥0 | deepseek-flash | low | ≤2000 | 3 次 | ≤10 | 否 |
| 进阶版 | ¥35/月 | deepseek-flash | high | ≤4000 | 10 次 | ≤16 | 否 |
| 高级版 | ¥89/月 | deepseek-flash | 最高推理 | ≤6000 | 20 次 | ≤24 | 是 |
| 专业版 | ¥159/月 | deepseek-v4-pro | high | ≤6500 | 25 次 | ≤32 | 是 |
| 单次购买 | ¥5/次 | 用当前套餐配置 | - | - | +1 次 | - | 可解锁 26.x |

额度用完时会弹出购买提示；后台「确认收款」后套餐/加油包立即生效。

## 管理后台

- 入口：`https://modcraft.top/admin.html`（本地：`http://localhost:8787/admin.html`）
- 登录令牌：`ADMIN_TOKEN`（线上 `wrangler secret`；本地 `.dev.vars`）
- 功能：数据总览（用户/任务/收入）、用户管理（设套餐、加单次额度、激活）、订单确认、任务列表

## 支付配置（可选）

在 `.dev.vars` / `wrangler secret` 里可配：
- `PAY_INSTRUCTIONS`：支付说明文案（默认"请支付 ¥N，备注订单号"）
- `PAY_QR_URL`：收款码图片地址（可选）
- `PAY_CONTACT`：联系方式（可选）
- 自动支付（预留）：`STRIPE_SECRET_KEY` + `PAYMENT_MODE=stripe`

## 目录结构

| 层 | 技术 | 位置 |
|---|---|---|
| 网页 | 原生 HTML/CSS/JS（双主题、MC 贴图图标） | `public/` |
| 后端 | Cloudflare Workers + D1 | `worker/` |
| 构建器 | GitHub Actions + Python 生成器（4 代系） | `.github/` `modgen/` |

## 常用命令

```powershell
npm run dev                # 本地后端（8788）
npm run deploy             # 部署到 Cloudflare
python -m http.server 8787 --directory public   # 本地前端
npx wrangler d1 execute modcraft --file worker/migrate_0.3.sql --remote  # 数据库升级
npx wrangler tail modcraft # 线上日志
```

## 验证记录

- Actions 真机编译：1.20.1 ✓、1.21.1 ✓（v0.2）；1.20.2 / 1.21.4 / 26.1 ✓（v0.3）
- 完整闭环：注册 → AI 生成 → 派发 → 编译 → 下载 jar ✓（demo-jars/ 有真实产物）

## Roadmap

- [ ] 1.20.5/1.20.6 与 1.21.2~1.21.11 补全
- [ ] 护甲套、生物、附魔
- [ ] 自动支付接入（Stripe/微信/支付宝）
- [ ] 作品广场、产物存 R2 直链
