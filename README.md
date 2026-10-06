# ModCraft · 方块梦工厂

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek V4.1 Flash）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

**线上地址**：https://modcraft.top （域名接入中）
**临时入口**：https://modcraft.modcraft-xiaohei.workers.dev

| 层 | 技术 | 位置 |
|---|---|---|
| 网页 | 原生 HTML/CSS/JS（零依赖，双主题，MC 贴图图标） | `public/` |
| 后端 | Cloudflare Workers + D1 | `worker/` |
| 构建器 | GitHub Actions + Python 代码生成器 | `.github/` `modgen/` |

支持版本：**Fabric 1.20.1 / 1.20.4 / 1.21.1 / 1.21**（工具 / 食物 / 方块 / 物品，自动配方与贴图）。

---

## 一、本地预览

双击 **`本地预览.bat`**（或 `python -m http.server 8787 --directory public`）→ http://localhost:8787
想连真实后端：`npm run dev`（wrangler dev，端口 8788；密钥读 `.dev.vars`）。

## 二、已完成的部署（2026-10-06）

- Cloudflare 账户：A114514kkkk@outlook.com 的账户
- D1 数据库：`modcraft`（id `a4a32b66-2935-43a8-879e-33e0bb2c5a85`，已建表）
- Worker：`modcraft`，已部署，密钥 `DEEPSEEK_API_KEY / SESSION_SECRET / GITHUB_TOKEN` 已写入
- 自定义域名：`modcraft.top` 已绑定（等待域名 NS 生效）

### ⚠️ 域名还要做一步

到 **modcraft.top 的购买商后台**，把域名的 DNS 服务器（NS）改成：

```
elle.ns.cloudflare.com
louis.ns.cloudflare.com
```

改完后（几分钟到几小时），modcraft.top 就会正式指向本站。

## 三、GitHub 构建通道

仓库：`xiaoheiHZ/modcraft`（构建工作流 `.github/workflows/build-mod.yml`）

用户点「构建 JAR」后的完整链路：
1. Worker 调 GitHub API dispatch 工作流（携带 spec）
2. Actions 里 `modgen/generate.py` 把 spec 变成完整 Fabric 工程
3. `./gradlew build` 编译出 jar → 上传 artifact
4. Worker 轮询状态 → 完成后提供下载（zip 内含 jar）

> 本地构建小贴士（国内网络）：生成的工程默认从 services.gradle.org 下载 Gradle，国内慢可换镜像：
> ```powershell
> $env:GRADLE_DIST_URL = 'https://mirrors.cloud.tencent.com/gradle/gradle-9.7.1-bin.zip'
> python modgen/generate.py --spec spec.json --out project
> ```

## 四、套餐与限流（盈利开关）

`worker/src/index.js` 顶部 `PLANS`：

| 套餐 | 模型 | 思考档 | 单次输出 | 每天 | 物品数 |
|---|---|---|---|---|---|
| free | deepseek-flash | low | 2000 tokens | 3 次 | 10 |
| pro | deepseek-v4-pro | high | 6000 tokens | 30 次 | 24 |

邮箱注册：未配置邮件服务时自动激活；配 `RESEND_API_KEY` + `MAIL_FROM` 后发真实验证码。

## 五、常用命令

```powershell
npm run dev                # 本地后端（8788）
npm run deploy             # 重新部署到 Cloudflare
npm run db:init            # 远程初始化数据库（幂等）
npx wrangler tail modcraft # 线上实时日志
```

## 六、安全须知

1. 密钥只放 `.dev.vars`（本地）与 `wrangler secret`（线上），**永不进仓库/前端**。
2. 曾在聊天中出现过的密钥建议定期轮换。
3. AI 生成内容由用户自行检查后使用；本项目非 Mojang / Microsoft 官方产品。

## 七、Roadmap

- [ ] 1.21.4+ / Forge / NeoForge 支持
- [ ] 护甲套、生物、附魔、生物蛋
- [ ] AI 贴图生成升级、作品广场
- [ ] 产物存 R2 直链下载
- [ ] 支付接入 → Pro 上线
