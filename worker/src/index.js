/**
 * 方块梦工厂 · Cloudflare Worker 后端
 * ------------------------------------------------------------
 * 路由：
 *   GET  /api/health            健康检查（前端据此判定演示模式）
 *   POST /api/register          邮箱注册        {email, password}
 *   POST /api/login             登录            {email, password}
 *   POST /api/logout            退出
 *   GET  /api/me                当前用户 + 配额
 *   POST /api/verify            邮箱验证码      {email, code}
 *   POST /api/generate          AI 生成模组规格 {idea, mc_version, loader, assets[]}
 *   POST /api/build             触发 GitHub Actions 构建 {task_id}
 *   GET  /api/task/:id          任务状态（构建中会自动同步 GitHub 状态）
 *   GET  /api/tasks             我的任务列表
 *   GET  /api/download/:id      下载构建产物（zip，内含 jar）
 *   POST /api/hook/build        Actions 回调（HMAC 签名）
 *   GET  /api/tex?p=&v=         MC 贴图代理（带边缘缓存，可选）
 * ------------------------------------------------------------
 * 需要的密钥（wrangler secret put XXX）：
 *   DEEPSEEK_API_KEY   DeepSeek API Key（必须）
 *   SESSION_SECRET     会话签名密钥（必须，任意 32+ 随机字符）
 *   GITHUB_TOKEN       GitHub Token（构建通道需要）
 *   GITHUB_REPO        owner/repo（构建通道需要，也可写在 [vars]）
 *   RESEND_API_KEY     邮件服务（可选，不配则注册自动激活）
 *   MAIL_FROM          发件人地址（可选）
 *   DEEPSEEK_MODEL_FREE / DEEPSEEK_MODEL_PRO  覆盖默认模型（可选）
 */

/* ================= 套餐定义（盈利开关都在这里） ================= */
const CREDIT_PRICE = 5;                 // 单次购买：¥5 = 1 次生成加油包
const PLAN_DEFS = {
  free: {
    label: '标准版', price: 0, days: 0,
    model: 'flash', effort: 'low', maxTokens: 2000, dailyTasks: 3, maxItems: 10,
  },
  plus35: {
    label: '进阶版', price: 35, days: 30,
    model: 'flash', effort: 'high', maxTokens: 4000, dailyTasks: 10, maxItems: 16,
  },
  pro89: {
    label: '高级版', price: 89, days: 30,
    model: 'flash', effort: 'high', maxTokens: 6000, dailyTasks: 20, maxItems: 24,
  },
  max159: {
    label: '专业版', price: 159, days: 30,
    model: 'pro', effort: 'high', maxTokens: 6500, dailyTasks: 25, maxItems: 32,
  },
};

/* 套餐是否在有效期内（到期自动回落到标准版） */
function effectivePlanName(user) {
  if (!user) return 'free';
  if (user.plan === 'free' || !PLAN_DEFS[user.plan]) return 'free';
  if (user.plan_expires_at && user.plan_expires_at < Date.now()) return 'free';
  return user.plan;
}
function planOf(env, userOrName) {
  const name = typeof userOrName === 'string' ? userOrName : effectivePlanName(userOrName);
  const key = PLAN_DEFS[name] ? name : 'free';
  const def = PLAN_DEFS[key];
  return {
    key,
    label: def.label,
    price: def.price,
    days: def.days,
    paid: def.price > 0,
    model: def.model === 'pro'
      ? ((env && env.DEEPSEEK_MODEL_PRO) || 'deepseek-v4-pro')
      : ((env && env.DEEPSEEK_MODEL_FREE) || 'deepseek-flash'),
    effort: def.effort,
    maxTokens: def.maxTokens,
    dailyTasks: def.dailyTasks,
    maxItems: def.maxItems,
  };
}

const KINDS = ['item', 'sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'helmet', 'chestplate', 'leggings', 'boots', 'food', 'block'];
const MC_VERSIONS = [
  '1.20', '1.20.1', '1.20.2', '1.20.4', '1.20.5', '1.20.6',
  '1.21', '1.21.1', '1.21.2', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.7',
  '1.21.8', '1.21.9', '1.21.10', '1.21.11',
  '26.1', '26.2', '26.3',
];
const isPremiumVersion = v => String(v).startsWith('26.');
const RESERVED_IDS = new Set(['minecraft', 'mod', 'test', 'modcraft', 'fabric', 'forge']);

/* ================= 小工具 ================= */
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
const ok = (data, status = 200, extra = {}) => json({ ok: true, ...data }, status, extra);
const fail = (error, status = 400, code = 'bad_request') => json({ ok: false, error, code }, status);

const enc = new TextEncoder();
const bytesToHex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = h => new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));
const randomHex = (n = 16) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));
function b64urlEncode(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64EncodeUtf8(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToHex(new Uint8Array(sig));
}
async function pbkdf2Hex(password, saltHex, iterations = 20000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
    key, 256
  );
  return bytesToHex(new Uint8Array(bits));
}
function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isValidEmail(s) { return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254; }
function dayStartMs() {
  const tz = 8 * 3600 * 1000;                       // 按北京时间切日
  return Math.floor((Date.now() + tz) / 86400000) * 86400000 - tz;
}
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch {}
  }
  return null;
}

/* ================= 会话 ================= */
const COOKIE = 'bd_session';
const SESSION_DAYS = 30;

async function makeSession(env, userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  const sig = await hmacHex(env.SESSION_SECRET || 'dev-secret-change-me', payload);
  return `${payload}.${sig}`;
}
async function readSession(env, request) {
  const token = parseCookies(request)[COOKIE];
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (Number(exp) * 1000 < Date.now()) return null;
  const expect = await hmacHex(env.SESSION_SECRET || 'dev-secret-change-me', `${uid}.${exp}`);
  if (expect !== sig) return null;
  return uid;
}
function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`;
}
const clearCookie = () => `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`;

/* ================= D1 ================= */
async function getUserById(env, id) {
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}
async function countTodayTasks(env, userId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM tasks WHERE user_id = ? AND created_at >= ?')
    .bind(userId, dayStartMs()).first();
  return row ? row.c : 0;
}
async function quotaInfo(env, user) {
  const plan = planOf(env, user);
  const used = await countTodayTasks(env, user.id);
  return {
    plan: plan.key,
    plan_label: plan.label,
    paid: plan.paid,
    daily: plan.dailyTasks,
    used_today: used,
    left: Math.max(0, plan.dailyTasks - used),
    credits: user.extra_credits || 0,
    credit_price: CREDIT_PRICE,
    expires_at: user.plan_expires_at || null,
    max_tokens: plan.maxTokens,
    max_items: plan.maxItems,
  };
}
function publicUser(u) {
  return {
    id: u.id, email: u.email, plan: effectivePlanName(u),
    plan_expires_at: u.plan_expires_at || null,
    credits: u.extra_credits || 0,
    tokens_used: u.tokens_used, created_at: u.created_at,
  };
}

/* ================= DeepSeek 调用 ================= */
const SYSTEM_PROMPT = `你是「ModCraft 方块梦工厂」的 Minecraft 模组设计师。玩家会用中文描述想要的模组，你要把它设计成一份可以由程序自动生成 Fabric 模组源码的 JSON 规格。

只输出一个 JSON 对象（不要 markdown 代码块、不要多余解释），结构如下：
{
  "mod_id": "snake_case 标识符，符合 [a-z][a-z0-9_]{1,23}",
  "mod_name": "中文模组名，≤16字",
  "description": "英文一句话描述，≤120字符",
  "theme": "#RRGGBB 主题色",
  "items": [
    {
      "id": "物品英文id，[a-z0-9_]{2,32}",
      "name_zh": "中文名 ≤12字",
      "name_en": "English name",
      "kind": "item | sword | pickaxe | axe | shovel | hoe | helmet | chestplate | leggings | boots | food | block",
      "material": "可选：配方材料，原版物品id（如 emerald / iron_ingot / amethyst_shard）",
      "base_texture": "可选：贴图基底，原版物品或方块id（如 diamond_sword / potato / pumpkin）",
      "color": "可选：#RRGGBB，用于自动调色",
      "max_damage": "可选：工具耐久（数字，默认钻石级 1561）",
      "nutrition": "可选：食物饥饿值 1-20（kind=food 时必填）",
      "saturation": "可选：食物饱和度系数 0.1-2.0，默认 0.6",
      "attack": "可选：剑/斧攻击伤害加成 1-30"
    }
  ]
}

规则：
1. items 数量 1 到 {MAX_ITEMS} 个，建议 4-8 个，尽量丰富且贴合玩家想法。
2. 主题统一、风格鲜明；物品之间数值不要全部照抄原版，可略作强化但别太夸张。
3. mod_id 不要使用 minecraft、mod、test 等保留词。
4. 输出必须是纯 JSON（UTF-8），不要注释、不要多余文本。
5. base_texture 与 material 请使用原版常用的贴图/物品名（剑类参考 diamond_sword，食物参考 apple，方块参考 emerald_block 等）。
6. 护甲（helmet/chestplate/leggings/boots）用 material 指定材质：diamond / netherite_ingot / iron_ingot / gold_ingot / leather，其他材质按钻石档。`;

async function callDeepSeek(env, plan, userPrompt) {
  const base = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const sys = SYSTEM_PROMPT.replace('{MAX_ITEMS}', String(plan.maxItems));
  const body = {
    model: plan.model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: plan.maxTokens,
    temperature: 0.8,
    stream: false,
    thinking: { type: 'enabled' },
    reasoning_effort: plan.effort,
    response_format: { type: 'json_object' },
  };
  const doFetch = () => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify(body),
  });

  let res = await doFetch();
  if (res.status === 400) { delete body.response_format; res = await doFetch(); }        // 兼容不支持 json_object 的情况
  if (res.status === 400) { delete body.thinking; delete body.reasoning_effort; res = await doFetch(); }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`AI 服务错误 ${res.status}：${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  return { content: (message && message.content) || '', usage: data.usage || {} };
}

/* ================= 规格校验 ================= */
function sanitizeId(s, fallback) {
  let id = String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(id)) id = fallback;
  return id;
}
function validateSpec(raw, plan) {
  if (!raw || typeof raw !== 'object') return { error: 'AI 输出不是 JSON 对象' };
  let mod_id = String(raw.mod_id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z][a-z0-9_]{1,23}$/.test(mod_id) || RESERVED_IDS.has(mod_id)) mod_id = 'dream_' + randomHex(3);
  const spec = {
    mod_id,
    mod_name: String(raw.mod_name || '梦想模组').slice(0, 24),
    description: String(raw.description || 'Generated by BlockDream.').slice(0, 200),
    theme: /^#[0-9a-fA-F]{6}$/.test(raw.theme || '') ? raw.theme : '#34d399',
    mc_version: raw.mc_version,
    items: [],
  };
  const used = new Set();
  const items = Array.isArray(raw.items) ? raw.items.slice(0, plan.maxItems) : [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    let id = sanitizeId(it.id, 'item_' + (i + 1));
    while (used.has(id)) id = id.slice(0, 28) + '_' + randomHex(1);
    used.add(id);
    const kind = KINDS.includes(it.kind) ? it.kind : 'item';
    const out = {
      id,
      name_zh: String(it.name_zh || it.name_en || id).slice(0, 24),
      name_en: String(it.name_en || id).slice(0, 48),
      kind,
    };
    if (/^[a-z0-9_]{2,40}$/.test(it.material || '')) out.material = it.material;
    if (/^[a-z0-9_]{2,40}$/.test(it.base_texture || '')) out.base_texture = it.base_texture;
    if (/^#[0-9a-fA-F]{6}$/.test(it.color || '')) out.color = it.color;
    if (Number.isFinite(it.max_damage)) out.max_damage = Math.min(10000, Math.max(10, Math.round(it.max_damage)));
    if (Number.isFinite(it.attack)) out.attack = Math.min(30, Math.max(1, Math.round(it.attack)));
    if (kind === 'food') {
      out.nutrition = Number.isFinite(it.nutrition) ? Math.min(20, Math.max(1, Math.round(it.nutrition))) : 4;
      out.saturation = Number.isFinite(it.saturation) ? Math.min(2, Math.max(0.1, Number(it.saturation))) : 0.6;
    }
    spec.items.push(out);
  }
  if (!spec.items.length) return { error: 'AI 没有生成任何物品，请调整描述后重试' };
  return { spec };
}

/* ================= GitHub 构建通道 ================= */
function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'blockdream-worker',
    'x-github-api-version': '2022-11-28',
  };
}
async function dispatchBuild(env, origin, task, spec) {
  const repo = env.GITHUB_REPO;
  const sig = await hmacHex(env.SESSION_SECRET || 'dev-secret-change-me', 'hook:' + task.id);
  const hookUrl = `${origin}/api/hook/build?task=${encodeURIComponent(task.id)}&sig=${sig}`;
  const javaVersion = task.mc_version.startsWith('1.21') ? '21' : '17';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/build-mod.yml/dispatches`, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        task_id: task.id,
        spec_b64: b64EncodeUtf8(JSON.stringify(spec)),
        java_version: javaVersion,
        hook_url: hookUrl,
      },
    }),
  });
  if (res.status !== 204) {
    const t = await res.text().catch(() => '');
    throw new Error(`触发构建失败（HTTP ${res.status}）：${t.slice(0, 200)}`);
  }
}
async function syncTaskFromGitHub(env, task) {
  const repo = env.GITHUB_REPO;
  const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=30`, { headers: ghHeaders(env) });
  if (!runsRes.ok) return task;
  const runs = await runsRes.json();
  const run = (runs.workflow_runs || []).find(r => r.display_title === `build-${task.id}`);
  if (!run) return task;
  task.gh_run_id = String(run.id);
  if (run.status !== 'completed') return task;
  if (run.conclusion === 'success') {
    const artRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts`, { headers: ghHeaders(env) });
    if (artRes.ok) {
      const arts = await artRes.json();
      const art = (arts.artifacts || []).find(a => a.name === `mod-jar-${task.id}`);
      if (art) {
        task.artifact_id = String(art.id);
        task.status = 'done';
        task.error = null;
        return task;
      }
    }
    task.status = 'building';       // 构建成功但产物还没就绪，稍后再查
  } else if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    task.status = 'error';
    task.error = `CI 构建失败（${run.conclusion}），请到 GitHub Actions 查看日志`;
  }
  return task;
}
async function saveTask(env, task) {
  task.updated_at = Date.now();
  await env.DB.prepare(
    `UPDATE tasks SET status = ?, gh_run_id = ?, artifact_id = ?, jar_name = ?, error = ?, updated_at = ? WHERE id = ?`
  ).bind(task.status, task.gh_run_id || null, task.artifact_id || null, task.jar_name || null, task.error || null, task.updated_at, task.id).run();
}

/* ================= 贴图代理（可选，用于规避国内网络抖动） ================= */
const TEX_CDNS = [
  v => `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/`,
  v => `https://fastly.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/`,
  v => `https://gcore.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/`,
  v => `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${v}/assets/minecraft/`,
];
async function serveTexture(request, env, ctx) {
  const url = new URL(request.url);
  let p = url.searchParams.get('p') || '';
  const v = url.searchParams.get('v') || '1.21.1';
  if (!/^(textures\/)?(item|block|entity|gui)\/[a-z0-9_/.-]+\.(png|mcmeta)$/.test(p)) return fail('非法贴图路径', 400);
  if (!p.startsWith('textures/')) p = 'textures/' + p;
  if (!/^\d+\.\d+(\.\d+)?$/.test(v)) return fail('非法版本号', 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://blockdream.internal/tex/${v}/${p}`, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  for (const mk of TEX_CDNS) {
    try {
      const res = await fetch(mk(v) + p, { cf: { cacheTtl: 86400 } });
      if (res.ok) {
        const out = new Response(res.body, {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' },
        });
        ctx.waitUntil(cache.put(cacheKey, out.clone()));
        return out;
      }
    } catch {}
  }
  return new Response('not found', { status: 404 });
}

/* ================= 邮件（可选） ================= */
async function sendMail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'ModCraft <onboarding@resend.dev>', to: [to], subject, html }),
  });
  return res.ok;
}

/* 好看的验证码邮件模板 */
function verifyEmailHtml(code) {
  const icon = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.21.1/assets/minecraft/textures/block/grass_block_side.png';
  return `<div style="background:#0d1117;padding:32px 12px;font-family:'Segoe UI','Microsoft YaHei',Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#161d29;border:1px solid #2c3a4f;border-radius:8px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#0f7a52,#34d399);padding:20px 26px">
      <span style="font-size:19px;font-weight:700;color:#04160e"><img src="${icon}" width="20" height="20" style="vertical-align:-3px;image-rendering:pixelated"> ModCraft 方块梦工厂</span>
      <div style="font-size:12px;color:#08331f;margin-top:4px">用一句话，造一个 Minecraft 模组</div>
    </div>
    <div style="padding:26px">
      <p style="color:#e8eef7;font-size:14px;margin:0 0 14px">你好！感谢注册 ModCraft，你的邮箱验证码是：</p>
      <div style="text-align:center;margin:22px 0">
        <span style="display:inline-block;background:#0c1119;border:2px dashed #34d399;border-radius:6px;padding:14px 30px;font-size:30px;letter-spacing:8px;font-weight:700;color:#34d399;font-family:Consolas,monospace">${code}</span>
      </div>
      <p style="color:#8ea0b8;font-size:13px;margin:0 0 6px">验证码 15 分钟内有效，请勿泄露给他人。</p>
      <p style="color:#8ea0b8;font-size:13px;margin:0">如果这不是你的操作，忽略本邮件即可。</p>
      <hr style="border:none;border-top:1px solid #2c3a4f;margin:20px 0">
      <p style="color:#5d6f82;font-size:12px;margin:0">ModCraft · 方块梦工厂 · <a href="https://modcraft.top" style="color:#34d399">modcraft.top</a><br>AI 生成 Minecraft 模组 · Fabric 1.20 ~ 26.3</p>
    </div>
  </div>
</div>`;
}

/* ================= API 路由 ================= */
async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const readJson = async () => { try { return await request.json(); } catch { return {}; } };

  /* ---- 健康检查 ---- */
  if (path === '/api/health') {
    return ok({
      version: '0.4.0',
      mail: !!(env && env.RESEND_API_KEY),
      github: !!(env && env.GITHUB_TOKEN && env.GITHUB_REPO),
      deepseek: !!(env && env.DEEPSEEK_API_KEY),
    });
  }

  /* ---- 注册 ---- */
  if (path === '/api/register' && method === 'POST') {
    const { email, password } = await readJson();
    if (!isValidEmail(email)) return fail('邮箱格式不正确');
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) return fail('密码需 8-72 位');
    const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (exists) return fail('该邮箱已注册，直接登录即可', 409);
    const id = 'u_' + randomHex(8);
    const salt = randomHex(16);
    const hash = await pbkdf2Hex(password, salt, Number(env.PBKDF2_ITERS || 20000));
    const mailConfigured = !!env.RESEND_API_KEY;
    const verified = mailConfigured ? 0 : 1;
    await env.DB.prepare(
      'INSERT INTO users (id, email, pass_hash, salt, plan, verified, tokens_used, created_at) VALUES (?,?,?,?,?,?,0,?)'
    ).bind(id, email.toLowerCase(), hash, salt, 'free', verified, Date.now()).run();

    let message = '注册成功！';
    let needVerify = false;
    if (mailConfigured) {
      needVerify = true;
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await env.DB.prepare(
        'INSERT INTO verify_codes (email, code, kind, expires_at) VALUES (?,?,?,?) ON CONFLICT(email, kind) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at'
      ).bind(email.toLowerCase(), code, 'verify', Date.now() + 15 * 60 * 1000).run();
      const sent = await sendMail(env, email, '【ModCraft】邮箱验证码', verifyEmailHtml(code));
      message = sent ? '注册成功！验证码已发送到你的邮箱，请查收。' : '注册成功，但验证邮件发送失败，可点击「重新发送验证码」。';
    } else {
      message = '注册成功！（未配置邮件服务，已自动激活）';
    }
    const token = await makeSession(env, id);
    const user = await getUserById(env, id);
    return ok({ message, need_verify: needVerify, user: publicUser(user), quota: await quotaInfo(env, user) }, 200, { 'set-cookie': sessionCookie(request, token) });
  }

  /* ---- 登录 ---- */
  if (path === '/api/login' && method === 'POST') {
    const { email, password } = await readJson();
    if (!isValidEmail(email) || typeof password !== 'string') return fail('邮箱或密码错误', 401);
    const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (!user) return fail('邮箱或密码错误', 401);
    const hash = await pbkdf2Hex(password, user.salt, Number(env.PBKDF2_ITERS || 20000));
    if (hash !== user.pass_hash) return fail('邮箱或密码错误', 401);
    if (env.RESEND_API_KEY && !user.verified) return fail('账号尚未验证，请查收注册邮件里的验证码', 403);
    const token = await makeSession(env, user.id);
    return ok({ user: publicUser(user), quota: await quotaInfo(env, user) }, 200, { 'set-cookie': sessionCookie(request, token) });
  }

  /* ---- 退出 ---- */
  if (path === '/api/logout' && method === 'POST') {
    return ok({}, 200, { 'set-cookie': clearCookie() });
  }

  /* ---- 读取会话（后面所有接口共用；必须在引用 user 之前声明） ---- */
  const uid = await readSession(env, request);
  const user = uid ? await getUserById(env, uid) : null;

  /* ================= 订单 / 支付 ================= */
  /* ---- 创建订单（套餐订阅或单次加油包） ---- */
  if (path === '/api/order/create' && method === 'POST') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const body = await readJson();
    const kind = body.kind === 'credit' ? 'credit' : 'plan';
    let amount = CREDIT_PRICE;
    let planKey = null;
    if (kind === 'plan') {
      planKey = String(body.plan || '');
      if (!PLAN_DEFS[planKey] || !PLAN_DEFS[planKey].price) return fail('套餐不存在');
      amount = PLAN_DEFS[planKey].price;
    }
    const id = 'o_' + randomHex(6);
    await env.DB.prepare(
      'INSERT INTO orders (id, user_id, kind, plan, amount, status, created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, user.id, kind, planKey, amount, 'pending', Date.now()).run();
    const pay = { mode: 'manual', amount, currency: 'CNY' };
    if (env.STRIPE_SECRET_KEY && env.PAYMENT_MODE === 'stripe') {
      pay.mode = 'stripe';
      pay.note = 'Stripe 通道已预留（需配置商户信息后启用）';
    } else {
      pay.instructions = env.PAY_INSTRUCTIONS || `请支付 ¥${amount}，支付时备注订单号（或支付后联系管理员告知订单号）。`;
      pay.contact = env.PAY_CONTACT || '';
      pay.qr = env.PAY_QR_URL || '';
    }
    return ok({ order: { id, kind, plan: planKey, amount, status: 'pending', created_at: Date.now() }, pay });
  }

  /* ---- 我的订单 ---- */
  if (path === '/api/orders' && method === 'GET') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const rows = await env.DB.prepare(
      'SELECT id, kind, plan, amount, status, created_at, paid_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
    ).bind(user.id).all();
    return ok({ orders: rows.results || [] });
  }

  /* ================= 管理后台（需要 ADMIN_TOKEN） ================= */
  if (path.startsWith('/api/admin/')) {
    const token = request.headers.get('x-admin-token') || '';
    if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return fail('管理员令牌无效', 401, 'admin_unauthorized');

    if (path === '/api/admin/stats' && method === 'GET') {
      const [u, t, tk, o, done, rev, toks] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS c FROM users').first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM tasks').first(),
        env.DB.prepare('SELECT COUNT(*) AS c FROM tasks WHERE created_at >= ?').bind(dayStartMs()).first(),
        env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'pending'").first(),
        env.DB.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'done'").first(),
        env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM orders WHERE status = 'paid'").first(),
        env.DB.prepare('SELECT COALESCE(SUM(tokens_used),0) AS s FROM users').first(),
      ]);
      return ok({ stats: {
        users: u.c, tasks_total: t.c, tasks_today: tk.c, tasks_done: done.c,
        orders_pending: o.c, revenue: rev.s, tokens_total: toks.s,
      } });
    }

    if (path === '/api/admin/users' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const rows = q
        ? await env.DB.prepare('SELECT id, email, plan, plan_expires_at, extra_credits, tokens_used, verified, created_at FROM users WHERE email LIKE ? ORDER BY created_at DESC LIMIT ?').bind('%' + q + '%', limit).all()
        : await env.DB.prepare('SELECT id, email, plan, plan_expires_at, extra_credits, tokens_used, verified, created_at FROM users ORDER BY created_at DESC LIMIT ?').bind(limit).all();
      return ok({ users: (rows.results || []).map(r => ({ ...r, plan: effectivePlanName(r) })) });
    }

    if (path === '/api/admin/user' && method === 'POST') {
      const body = await readJson();
      const target = await getUserById(env, String(body.user_id || ''));
      if (!target) return fail('用户不存在', 404);
      if (body.action === 'set_plan') {
        const pk = String(body.plan || 'free');
        if (pk !== 'free' && !PLAN_DEFS[pk]) return fail('套餐不存在');
        const days = Math.max(1, Math.min(Number(body.days || PLAN_DEFS[pk].days || 30), 3650));
        const expires = pk === 'free' ? null : Date.now() + days * 86400000;
        await env.DB.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').bind(pk, expires, target.id).run();
        return ok({ message: `已设置 ${PLAN_DEFS[pk].label}${expires ? '（' + days + ' 天）' : ''}` });
      }
      if (body.action === 'add_credits') {
        const n = Math.max(1, Math.min(Number(body.n || 1), 1000));
        await env.DB.prepare('UPDATE users SET extra_credits = extra_credits + ? WHERE id = ?').bind(n, target.id).run();
        return ok({ message: `已增加 ${n} 个单次额度` });
      }
      if (body.action === 'verify') {
        await env.DB.prepare('UPDATE users SET verified = 1 WHERE id = ?').bind(target.id).run();
        return ok({ message: '已激活账号' });
      }
      return fail('未知操作');
    }

    if (path === '/api/admin/tasks' && method === 'GET') {
      const status = url.searchParams.get('status') || '';
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      const rows = status
        ? await env.DB.prepare('SELECT t.id, t.user_id, u.email, t.idea, t.mc_version, t.status, t.tokens_used, t.created_at FROM tasks t LEFT JOIN users u ON u.id = t.user_id WHERE t.status = ? ORDER BY t.created_at DESC LIMIT ?').bind(status, limit).all()
        : await env.DB.prepare('SELECT t.id, t.user_id, u.email, t.idea, t.mc_version, t.status, t.tokens_used, t.created_at FROM tasks t LEFT JOIN users u ON u.id = t.user_id ORDER BY t.created_at DESC LIMIT ?').bind(limit).all();
      return ok({ tasks: rows.results || [] });
    }

    if (path === '/api/admin/orders' && method === 'GET') {
      const status = url.searchParams.get('status') || '';
      const rows = status
        ? await env.DB.prepare('SELECT o.*, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.status = ? ORDER BY o.created_at DESC LIMIT 100').bind(status).all()
        : await env.DB.prepare('SELECT o.*, u.email FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 100').all();
      return ok({ orders: rows.results || [] });
    }

    if (path === '/api/admin/order' && method === 'POST') {
      const body = await readJson();
      const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(String(body.order_id || '')).first();
      if (!order) return fail('订单不存在', 404);
      const status = body.status === 'paid' ? 'paid' : (body.status === 'cancelled' ? 'cancelled' : null);
      if (!status) return fail('非法状态');
      if (order.status === 'paid') return ok({ message: '该订单已处理' });
      if (status === 'paid') {
        const target = await getUserById(env, order.user_id);
        if (!target) return fail('用户不存在', 404);
        if (order.kind === 'plan') {
          const days = (PLAN_DEFS[order.plan] || {}).days || 30;
          const base = (target.plan === order.plan && target.plan_expires_at && target.plan_expires_at > Date.now()) ? target.plan_expires_at : Date.now();
          await env.DB.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').bind(order.plan, base + days * 86400000, target.id).run();
        } else {
          await env.DB.prepare('UPDATE users SET extra_credits = extra_credits + 1 WHERE id = ?').bind(target.id).run();
        }
        await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").bind(Date.now(), order.id).run();
        return ok({ message: '已确认收款并发放' });
      }
      await env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, order.id).run();
      return ok({ message: status === 'cancelled' ? '订单已取消' : '订单已更新' });
    }

    return fail('后台接口不存在', 404);
  }

  /* ---- 邮箱验证 ---- */
  if (path === '/api/verify' && method === 'POST') {
    const { email, code } = await readJson();
    if (!isValidEmail(email)) return fail('邮箱格式不正确');
    const row = await env.DB.prepare('SELECT * FROM verify_codes WHERE email = ? AND kind = ?').bind(email.toLowerCase(), 'verify').first();
    if (!row || row.code !== String(code) || row.expires_at < Date.now()) return fail('验证码错误或已过期');
    await env.DB.prepare('UPDATE users SET verified = 1 WHERE email = ?').bind(email.toLowerCase()).run();
    await env.DB.prepare('DELETE FROM verify_codes WHERE email = ? AND kind = ?').bind(email.toLowerCase(), 'verify').run();
    return ok({ message: '邮箱验证成功！' });
  }

  /* ---- 重新发送验证码 ---- */
  if (path === '/api/verify/send' && method === 'POST') {
    const { email } = await readJson();
    if (!isValidEmail(email)) return fail('邮箱格式不正确');
    if (!env.RESEND_API_KEY) return fail('邮件服务未配置', 500);
    const row = await env.DB.prepare('SELECT id, verified FROM users WHERE email = ?').bind(email.toLowerCase()).first();
    if (!row) return fail('该邮箱未注册', 404);
    if (row.verified) return fail('该邮箱已验证，直接登录即可', 409);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await env.DB.prepare(
      'INSERT INTO verify_codes (email, code, kind, expires_at) VALUES (?,?,?,?) ON CONFLICT(email, kind) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at'
    ).bind(email.toLowerCase(), code, 'verify', Date.now() + 15 * 60 * 1000).run();
    const sent = await sendMail(env, email, '【ModCraft】邮箱验证码', verifyEmailHtml(code));
    return sent ? ok({ message: '验证码已重新发送' }) : fail('发送失败，请稍后再试', 502);
  }

  /* ======== 以下都需要登录 ======== */

  if (path === '/api/me') {
    if (!user) return fail('未登录', 401, 'unauthorized');
    return ok({ user: publicUser(user), quota: await quotaInfo(env, user) });
  }

  /* ---- 生成模组规格 ---- */
  if (path === '/api/generate' && method === 'POST') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    if (!user.verified) return fail('请先完成邮箱验证', 403);
    const body = await readJson();
    const idea = String(body.idea || '').trim();
    if (idea.length < 4 || idea.length > 1200) return fail('想法描述需 4-1200 字');
    const mcVersion = MC_VERSIONS.includes(body.mc_version) ? body.mc_version : '1.20.1';
    const loader = 'fabric';
    const assets = Array.isArray(body.assets) ? body.assets.filter(a => /^[a-z0-9_]{2,40}$/.test(String(a))).slice(0, 40) : [];

    const plan = planOf(env, user);
    const usedToday = await countTodayTasks(env, user.id);

    /* 26.x 新版本：需要付费套餐，或消耗 1 个加油包（单次购买） */
    const premiumVer = isPremiumVersion(mcVersion);
    const credits = user.extra_credits || 0;
    const overDaily = usedToday >= plan.dailyTasks;
    let useCredit = false;
    if (overDaily) useCredit = true;                       // 超出每日额度 → 消耗加油包
    if (premiumVer && !plan.paid && !useCredit) {
      if (credits > 0) useCredit = true;                   // 免费用户用加油包解锁 26.x
      else return fail('26.x 新版本需要套餐用户或单次购买后使用', 403, 'premium_version');
    }
    if (useCredit && credits <= 0) {
      return fail(`今日生成次数已用完（${plan.label}每天 ${plan.dailyTasks} 次）。可单次购买 ¥${CREDIT_PRICE} 继续生成`, 429, 'quota_exceeded');
    }
    if (!env.DEEPSEEK_API_KEY) return fail('AI 服务未配置（缺少 DEEPSEEK_API_KEY）', 500);

    const userPrompt = [
      `玩家想法：${idea}`,
      `目标：Minecraft ${mcVersion} / Fabric`,
      assets.length ? `玩家挑选的参考素材（可用作 base_texture 或 material）：${assets.join(', ')}` : '',
    ].filter(Boolean).join('\n');

    let parsed = null, usage = {}, lastErr = '';
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      const extra = attempt === 0 ? '' : '\n\n注意：上一次输出不是合法 JSON。请只输出一个 JSON 对象，不要任何其他文字。';
      const { content, usage: u } = await callDeepSeek(env, plan, userPrompt + extra);
      usage = u;
      const raw = extractJson(content);
      const v = validateSpec(raw, plan);
      if (v.spec) parsed = v.spec; else lastErr = v.error || 'AI 输出解析失败';
    }
    if (!parsed) return fail(lastErr || 'AI 输出解析失败，请重试', 422);

    parsed.mc_version = mcVersion;
    const taskId = 't_' + randomHex(6);
    const now = Date.now();
    await env.DB.prepare(
      'INSERT INTO tasks (id, user_id, idea, mc_version, loader, spec_json, status, tokens_used, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(taskId, user.id, idea, mcVersion, loader, JSON.stringify(parsed), 'drafted', usage.total_tokens || 0, now, now).run();
    if (usage.total_tokens) {
      await env.DB.prepare('UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?').bind(usage.total_tokens, user.id).run();
    }
    if (useCredit) {
      await env.DB.prepare('UPDATE users SET extra_credits = extra_credits - 1 WHERE id = ?').bind(user.id).run();
    }
    const fresh = await getUserById(env, user.id);
    return ok({
      task: { id: taskId, status: 'drafted', idea, mc_version: mcVersion, created_at: Math.floor(now / 1000) },
      spec: parsed,
      usage: { total_tokens: usage.total_tokens || 0, model: plan.model },
      quota: await quotaInfo(env, fresh),
    });
  }

  /* ---- 触发构建 ---- */
  if (path === '/api/build' && method === 'POST') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return fail('构建通道未配置（需要 GITHUB_TOKEN 与 GITHUB_REPO）', 500);
    const { task_id } = await readJson();
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(task_id, user.id).first();
    if (!task) return fail('任务不存在', 404);
    if (task.status === 'building') return fail('该任务正在构建中', 409);
    if (task.status === 'done') return fail('该任务已经构建完成', 409);
    const spec = JSON.parse(task.spec_json);
    const origin = new URL(request.url).origin;
    await dispatchBuild(env, origin, task, spec);
    task.status = 'building';
    task.error = null;
    await saveTask(env, task);
    return ok({ task: { id: task.id, status: 'building' } });
  }

  /* ---- 任务状态 ---- */
  if (path.startsWith('/api/task/') && method === 'GET') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const id = decodeURIComponent(path.slice('/api/task/'.length));
    let task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!task) return fail('任务不存在', 404);
    if (task.status === 'building' && env.GITHUB_TOKEN && env.GITHUB_REPO) {
      try {
        const before = task.status;
        task = await syncTaskFromGitHub(env, { ...task });
        if (task.status === 'done') task.jar_name = `${JSON.parse(task.spec_json).mod_id}-1.0.0.zip`;
        if (task.status !== before || task.artifact_id) await saveTask(env, task);
      } catch {}
    }
    return ok({
      task: {
        id: task.id, status: task.status, idea: task.idea, mc_version: task.mc_version, loader: task.loader,
        error: task.error || null, jar_name: task.jar_name || null, created_at: task.created_at,
        gh_run_id: task.gh_run_id || null,
      },
    });
  }

  /* ---- 任务列表 ---- */
  if (path === '/api/tasks' && method === 'GET') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const rows = await env.DB.prepare(
      'SELECT id, idea, status, mc_version, loader, error, jar_name, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC LIMIT 40'
    ).bind(user.id).all();
    return ok({ tasks: (rows.results || []).map(r => ({ ...r, created_at: Math.floor(r.created_at / 1000) })) });
  }

  /* ---- 下载产物 ---- */
  if (path.startsWith('/api/download/') && method === 'GET') {
    if (!user) return fail('请先登录', 401, 'unauthorized');
    const id = decodeURIComponent(path.slice('/api/download/'.length));
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').bind(id, user.id).first();
    if (!task) return fail('任务不存在', 404);
    if (task.status !== 'done' || !task.artifact_id) return fail('产物尚未就绪', 409);
    const artUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/artifacts/${task.artifact_id}/zip`;
    let res = await fetch(artUrl, { headers: ghHeaders(env), redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return fail('下载地址获取失败', 502);
      res = await fetch(loc);
    }
    if (!res.ok || !res.body) return fail('下载产物失败，请稍后重试', 502);
    return new Response(res.body, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${task.jar_name || task.id + '.zip'}"`,
        'cache-control': 'no-store',
      },
    });
  }

  /* ---- Actions 回调 ---- */
  if (path === '/api/hook/build' && method === 'POST') {
    const id = url.searchParams.get('task') || '';
    const sig = url.searchParams.get('sig') || '';
    const expect = await hmacHex(env.SESSION_SECRET || 'dev-secret-change-me', 'hook:' + id);
    if (!id || sig !== expect) return fail('签名校验失败', 403);
    const body = await readJson();
    const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
    if (!task) return fail('任务不存在', 404);
    if (body.run_id) task.gh_run_id = String(body.run_id);
    if (body.status === 'failure' || body.status === 'cancelled') {
      task.status = 'error';
      task.error = 'Actions 构建失败，请到 GitHub 查看日志';
    }
    await saveTask(env, task);
    return ok({});
  }

  /* ---- 贴图代理 ---- */
  if (path === '/api/tex' && method === 'GET') return serveTexture(request, env, ctx);

  return fail('接口不存在', 404, 'not_found');
}

/* ================= 入口 ================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 开发模式跨域（本地 8787 页面 → 8788 worker）
    const devCors = env && env.DEV_MODE ? {
      'access-control-allow-origin': request.headers.get('origin') || '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    } : null;
    if (devCors && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: devCors });

    let res;
    try {
      if (url.pathname.startsWith('/api/')) {
        res = await handleApi(request, env, ctx);
      } else if (env && env.ASSETS) {
        res = await env.ASSETS.fetch(request);
        if (res.status === 404 && !url.pathname.includes('.')) {
          res = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), request));
        }
      } else {
        res = new Response('BlockDream worker: 静态资源未绑定（缺少 [assets] 配置）', { status: 200 });
      }
    } catch (e) {
      res = fail('服务器内部错误：' + (e && e.message ? e.message : e), 500, 'internal');
    }
    if (devCors) {
      // 直接改头；注意不能重新包装 Response（会把 set-cookie 丢掉，
      // 浏览器规范把它排除在 Headers 迭代之外）
      for (const [k, v] of Object.entries(devCors)) {
        try { res.headers.set(k, v); } catch { /* fetched 响应头只读，忽略 */ }
      }
    }
    return res;
  },
};
