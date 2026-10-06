# 方块梦工厂 · BlockDream

> 玩家输入 Minecraft 模组想法 → AI（DeepSeek V4.1 Flash）设计规格 → GitHub Actions 自动构建 JAR → 一键下载。

本仓库是一个"三合一"项目：

| 层 | 技术 | 位置 | 作用 |
|---|---|---|---|
| 网页 | 原生 HTML/CSS/JS（零依赖） | `public/` | 素材库、想法输入、注册登录、任务面板 |
| 后端 | Cloudflare Workers + D1 | `worker/` | 账号、配额、调 DeepSeek、触发构建、下载代理 |
| 构建器 | GitHub Actions + Python 代码生成器 | `.github/` `modgen/` | 把 AI 规格变成可编译的 Fabric 模组工程并编译成 JAR |

---

## 一、本地预览（30 秒）

双击 **`本地预览.bat`**（或手动 `python -m http.server 8787 --directory public`），打开 http://localhost:8787

- 没连后端时自动进入 **演示模式**：注册/登录/生成流程会本地模拟，方便先看 UI。
- 想跑真实后端：`npm install` 后 `npx wrangler dev`（需要先按下面配置 D1 和密钥）。

---

## 二、部署到 Cloudflare

### A. 只部署静态页（最快，演示模式）

- 网页版：Cloudflare Dashboard → Workers & Pages → 创建 → Pages → 直接上传 `public` 文件夹。
- 命令行：`npx wrangler pages deploy public --project-name blockdream`

### B. 完整后端（推荐，解锁真实 AI + 构建）

```powershell
npm install                                   # 装 wrangler
npx wrangler login                            # 浏览器授权
npx wrangler d1 create blockdream             # 创建数据库，复制返回的 database_id
# 把 database_id 填到 wrangler.toml 里
npx wrangler d1 execute blockdream --file worker/schema.sql --remote   # 建表

# 设置密钥（按提示粘贴，不要写进文件）
npx wrangler secret put DEEPSEEK_API_KEY      # DeepSeek 的 sk-xxx
npx wrangler secret put SESSION_SECRET        # 随便一串 32 位以上随机字符
npx wrangler secret put GITHUB_TOKEN          # GitHub Token（见下）
npx wrangler secret put GITHUB_REPO           # 形如 xiaoheiHZ/blockdream

npx wrangler deploy                           # 部署（静态页 + API 一起上）
```

本地开发用的密钥放在 **`.dev.vars`**（已在 .gitignore 中，不会进仓库）。

---

## 三、GitHub 仓库与构建通道

1. **安装 Git**（本机还没装）：`winget install --id Git.Git` 或去 https://git-scm.com 下载。
2. 用 gh 建仓库并推送（已登录 xiaoheiHZ）：
   ```powershell
   git init && git add -A && git commit -m "init: BlockDream"
   gh repo create blockdream --public --source . --push
   ```
3. **GITHUB_TOKEN**：网页 GitHub → Settings → Developer settings → Fine-grained token：
   - 权限：`Actions: Read and write`、`Contents: Read and write`（挂到本仓库）。
   - 或者偷懒：`gh auth token`（复用 gh 的 token，权限较大，仅自用建议）。
4. 之后用户点「开始构建.jar」时：Worker 会 dispatch `build-mod.yml`，Actions 用 Python 生成器把 AI 规格编译成 Fabric 模组 jar，Worker 轮询状态并提供下载。

> 构建器支持 MC **1.20.1（稳定）**，**1.21.1（测试中）**；Forge/NeoForge 在路上。

**本地构建小贴士（国内网络）**：生成的工程默认从 `services.gradle.org` 下载 Gradle。国内直连容易超时，可给生成器设环境变量换镜像后再生成：

```powershell
$env:GRADLE_DIST_URL = 'https://mirrors.cloud.tencent.com/gradle/gradle-9.7.1-bin.zip'
python modgen/generate.py --spec spec.json --out project
```

（maven.fabricmc.net 的依赖下载偶尔也会受网络影响，建议直接用 GitHub Actions 云端编译，稳定。）

---

## 四、邮箱注册 / 邮件验证（可选）

- 默认：不配置邮件服务 → 注册自动激活（开发模式），页面会提示。
- 要真发验证邮件：注册 Resend（https://resend.com），然后
  ```powershell
  npx wrangler secret put RESEND_API_KEY
  npx wrangler secret put MAIL_FROM     # 如 noreply@yourdomain.com（需已验证域名）
  ```

---

## 五、套餐与限流（以后盈利的开关都在这）

`worker/src/index.js` 顶部 `PLANS`：

| 套餐 | 模型 | 思考档位 | 单次输出上限 | 每天次数 | 单模组物品数 |
|---|---|---|---|---|---|
| free 免费版 | deepseek-flash | low（低思考） | 2000 tokens | 3 次 | 10 个 |
| pro 专业版 | deepseek-v4-pro | high | 6000 tokens | 30 次 | 24 个 |

- 所有调用都强制 `max_tokens` 上限并累计用户 token 用量（`users.tokens_used`）。
- 想调价/改额度：直接改这几个数字即可；前端套餐展示在 `public/index.html` 里改成一致。

---

## 六、安全须知 ⚠️

1. **你贴在聊天里的 DeepSeek Key 建议立刻轮换**（已在对话中出现过的密钥应视为泄露）；新 Key 放进 `.dev.vars` / `wrangler secret`。
2. 密钥永远不要写进前端代码或提交仓库（.gitignore 已排除 `.dev.vars`）。
3. Worker 对生成内容做了 JSON 结构校验，构建在一次性 Actions 容器中进行，不会碰你的本机。

---

## 七、Roadmap

- [ ] 1.21.1 构建转正、Forge / NeoForge 支持
- [ ] 护甲套、食物效果、附魔、生物蛋
- [ ] AI 生成贴图（Pillow 色相迁移已上线：选一个原版贴图作为基底 + 主题色自动调色）
- [ ] 产物存 R2，直链下载 / 社区作品墙
- [ ] 支付接入（Stripe / 爱发电）→ Pro 套餐上线
