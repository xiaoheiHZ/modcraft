# ModCraft · 方块梦工厂 v0.5

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

**线上地址**：https://modcraft.top ｜ **代码仓库**：https://github.com/xiaoheiHZ/modcraft

## v0.5 新增

- **注册严格验证**：未验证邮箱不能登录 / 生成 / 购买；注册后不再直接发登录态，验证码通过后才登录（防绕过）
- **自动支付（无需找管理员）**：接入「易支付」通用协议——支付成功后服务器自动回调到账
  - 启用方式：在 Cloudflare 配 3 个 secret：`EPAY_API_URL`（平台提交地址）/ `EPAY_PID` / `EPAY_KEY`
  - 支持微信/支付宝扫码；支付页新窗口打开，原页面自动轮询到账，返回页自动关窗
  - 未配置时保持人工确认模式（后台可确认收款）
- Worker 启用 `nodejs_compat`（用 node:crypto 的 MD5 做签名，保证签名正确）

## v0.4 新增

- **21 个游戏版本**，8 个代码代系全部通过 GitHub Actions 真机编译：
  `1.20 / 1.20.1 / 1.20.2 / 1.20.4 / 1.20.5 / 1.20.6 / 1.21 / 1.21.1 / 1.21.2 / 1.21.3 / 1.21.4 / 1.21.5 / 1.21.6 / 1.21.7 / 1.21.8 / 1.21.9 / 1.21.10 / 1.21.11 / 26.1 / 26.2 / 26.3`
- **新增护甲系统**：头盔 / 胸甲 / 护腿 / 靴子（钻石/下界合金/铁/金/皮革材质），全版本适配
- **SEO 优化**：标题/描述/关键词、Open Graph、结构化数据（WebApplication + FAQPage）、sitemap.xml、robots.txt，便于 Bing / Google 收录
- **邮箱验证**：接入 Resend，精美 HTML 验证邮件 + 网页端验证码输入 / 重新发送
- 后台管理密码已更新（令牌见 `.dev.vars` / `wrangler secret` 的 `ADMIN_TOKEN`）

## 26.x 与定价

| 套餐 | 价格 | 模型 | 思考 | 单次 tokens | 每天 | 物品 | 26.x |
|---|---|---|---|---|---|---|---|
| 标准版 | ¥0 | deepseek-flash | low | ≤2000 | 3 次 | ≤10 | 否 |
| 进阶版 | ¥35/月 | deepseek-flash | high | ≤4000 | 10 次 | ≤16 | 否 |
| 高级版 | ¥89/月 | deepseek-flash | 最高推理 | ≤6000 | 20 次 | ≤24 | 是 |
| 专业版 | ¥159/月 | deepseek-v4-pro | high | ≤6500 | 25 次 | ≤32 | 是 |
| 单次购买 | ¥5/次 | 用当前套餐配置 | - | - | +1 次 | - | 可解锁 |

支付默认人工确认（支持配收款码 `PAY_QR_URL` / 文案 `PAY_INSTRUCTIONS` / 联系方式 `PAY_CONTACT`），Stripe 通道预留。

## 邮件说明（重要）

当前为**严格验证模式**：必须收到验证码并通过校验才能使用。由于现有 Resend key 是「仅发送」权限且未验证域名，验证码只能发到 Resend 账号本人的邮箱。要支持所有用户，二选一：
1. 在 Resend 后台添加域名 `modcraft.top`，把 DKIM/SPF 记录加到 Cloudflare DNS，完成后把 `MAIL_FROM` 换成 `ModCraft <noreply@modcraft.top>`；
2. 把 Resend key 升级为 Full access，然后运行 `tools/resend_domain_setup.ps1 -ResendKey <key>` 一键完成域名+DNS+验证。

> 临时可用：把 `REQUIRE` 校验沿用当前逻辑（收不到码的用户可由管理员在后台「激活」）。

## 目录结构

| 层 | 技术 | 位置 |
|---|---|---|
| 网页 | 原生 HTML/CSS/JS（双主题、MC 贴图图标、SEO） | `public/` |
| 后端 | Cloudflare Workers + D1 | `worker/` |
| 构建器 | GitHub Actions + Python 生成器（8 代系） | `.github/` `modgen/` |

## 常用命令

```powershell
npm run dev                # 本地后端（8788）
npm run deploy             # 部署到 Cloudflare
python -m http.server 8787 --directory public   # 本地前端
npx wrangler tail modcraft # 线上日志
```

## 管理后台

- 入口：`https://modcraft.top/admin.html`（已加 noindex，不进搜索引擎）
- 功能：数据总览（用户/任务/收入）、用户管理（设套餐、加单次额度、激活）、订单确认收款、任务列表

## Roadmap

- [ ] Resend 域名验证 → 全用户邮件验证
- [ ] 自动支付接入（Stripe/微信/支付宝）
- [ ] 更多物品类型（生物、附魔、投掷物）
- [ ] 作品广场、产物存 R2 直链
