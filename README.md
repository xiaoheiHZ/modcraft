# ModCraft · 方块梦工厂

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek V4.1 Flash）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

**线上地址**：https://modcraft.top（等待域名 NS 生效后正式启用）
**临时入口**：https://modcraft.modcraft-xiaohei.workers.dev
**代码仓库**：https://github.com/xiaoheiHZ/modcraft

| 层 | 技术 | 位置 |
|---|---|---|
| 网页 | 原生 HTML/CSS/JS（零依赖、MC 贴图图标、深色/浅色双主题） | `public/` |
| 后端 | Cloudflare Workers + D1 | `worker/` |
| 构建器 | GitHub Actions + Python 代码生成器 | `.github/` `modgen/` |

支持版本：**Fabric 1.20.1 / 1.20.4 / 1.21.1 / 1.21**（物品 / 工具 / 食物 / 方块，自动配方与贴图）

---

## 一、验证状态（2026-10-06 全部实测通过）

- ✅ 前端：素材库 404 个素材、贴图四级 CDN 自动回退、双主题、注册/登录/任务面板
- ✅ 后端：会话 Cookie、每日配额、贴图代理、未登录拦截（本地 wrangler 实测）
- ✅ AI：`deepseek-flash` 低思考实时生成（2.8~4.4 秒 / 千级 tokens）
- ✅ 构建：GitHub Actions 真机编译 —— **1.20.1 ✓（1m10s）**、**1.21.1 ✓（1m16s）**
- ✅ 完整闭环：输入想法 → AI 生成 → Worker 派发 → 云端编译 → **下载到 `emerald_glow-1.0.0.jar`**
- ✅ Cloudflare：Worker 已部署、D1 已建表、三个密钥已写入、`modcraft.top` 已绑定

真实产物见 `demo-jars/`。

## 二、待办（只差一步）

到 **modcraft.top 的域名购买商后台**，把 DNS 服务器改成：

```
elle.ns.cloudflare.com
louis.ns.cloudflare.com
```

改完后（几分钟~几小时）modcraft.top 即正式启用，全站可用。

## 三、本地开发

```powershell
# 前端预览（8787）
python -m http.server 8787 --directory public

# 后端（8788），密钥读 .dev.vars
npm run dev

# 重新部署到 Cloudflare
npm run deploy

# 线上试编译一个模组（GitHub Actions）
# 直接在 GitHub 仓库 Actions 页面手动 Run workflow 即可
```

> 国内网络提示：本地 gradle 构建建议换镜像 `$env:GRADLE_DIST_URL='https://mirrors.cloud.tencent.com/gradle/gradle-9.7.1-bin.zip'` 后用生成器产出工程；正式编译走 Actions（海外网络）最稳。

## 四、套餐与限流（盈利开关）

`worker/src/index.js` 顶部 `PLANS`：

| 套餐 | 模型 | 思考档 | 单次输出 | 每天 | 物品数 |
|---|---|---|---|---|---|
| free | deepseek-flash | low | 2000 tokens | 3 次 | 10 |
| pro | deepseek-v4-pro | high | 6000 tokens | 30 次 | 24 |

个人 GitHub 令牌（ModCraft-Worker，repo+workflow 权限）用于推送与 Worker 派发构建，保存在 `.dev.vars`（本地）与 `wrangler secret`（线上）。

## 五、安全须知

1. 密钥只放 `.dev.vars` 与 `wrangler secret`，永不进仓库/前端。
2. 在聊天中出现过的密码/密钥建议尽快轮换。
3. 非 Mojang / Microsoft 官方产品；AI 生成内容请自行检查。

## 六、Roadmap

- [ ] 1.21.4+ / Forge / NeoForge 支持
- [ ] 护甲套、生物、附魔、生物蛋
- [ ] 作品广场、产物存 R2 直链
- [ ] 支付接入 → Pro 上线
