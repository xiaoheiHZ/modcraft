# ModCraft · 方块梦工厂 v0.4

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

**线上地址**：https://modcraft.top ｜ **代码仓库**：https://github.com/xiaoheiHZ/modcraft

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

当前 Resend key 为**仅发送权限**，只能发送到 Resend 账号本人的邮箱；要对全体用户发信需要：
1. 在 Resend 后台把 `modcraft.top` 添加为域名（或提供全权限 key / 把 DKIM 记录贴过来），
2. 我们把 DKIM/SPF 记录加进 Cloudflare DNS 完成验证，
3. 之后把 `MAIL_FROM` 换成 `ModCraft <noreply@send.modcraft.top>` 即可对所有用户发信。

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
