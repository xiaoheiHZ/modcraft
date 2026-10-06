/* 方块梦工厂 · 前端主逻辑
 * 后端可达时走真实 API（Cloudflare Worker）；不可达时自动进入「演示模式」。
 */
(() => {
'use strict';

/* ================= 基础工具 ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* 本地预览(8787) 时指向 wrangler dev(8788)；线上同源 */
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '8787')
  ? 'http://localhost:8788' : '';

const state = {
  demo: true,
  user: null,
  tasks: [],
  basket: new Set(),
  assetsVersion: '1.21.1',
  group: '全部',
  query: '',
  currentSpec: null,
  currentTask: null,
  pollTimer: null,
  quota: null,
};
try { state.basket = new Set(JSON.parse(localStorage.getItem('bd_basket') || '[]')); } catch {}

/* ================= MC 贴图 CDN（多级回退） ================= */
const CDNS = [
  { name: 'jsdelivr', url: (v, p) => `https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/${p}` },
  { name: 'fastly',   url: (v, p) => `https://fastly.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/${p}` },
  { name: 'gcore',    url: (v, p) => `https://gcore.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@${v}/assets/minecraft/${p}` },
  { name: 'github',   url: (v, p) => `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${v}/assets/minecraft/${p}` },
];
let cdnPref = 0;
try { cdnPref = Math.min(Number(localStorage.getItem('bd_cdn_pref') || 0), CDNS.length - 1); } catch {}

function texCandidates(tex, id) {
  if (tex === 'i') return [`textures/item/${id}.png`];
  if (tex === 'b') return [`textures/block/${id}.png`];
  // 自定义路径（可用 | 配多个候选，按顺序回退），如 block/grass_block_side 或 item/turtle_scute|item/scute
  return String(tex).split('|').map(x => `textures/${x}.png`);
}

function hashColor(id) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h}, 62%, 55%)`;
}

/* 图标：按 CDN 回退 → 全失败用色块占位 */
function attachChain(img, paths, onFail) {
  let k = cdnPref, pi = 0, curK = k;
  const next = () => {
    if (k >= CDNS.length) { onFail(); return; }
    curK = k;
    img.src = CDNS[k].url(state.assetsVersion, paths[pi]);
    pi++;
    if (pi >= paths.length) { pi = 0; k++; }
  };
  img.onerror = next;
  img.onload = () => {
    if (curK !== cdnPref) { cdnPref = curK; try { localStorage.setItem('bd_cdn_pref', String(curK)); } catch {} }
  };
  next();
}

function makeIcon(item, size = 42) {
  const wrap = document.createElement('div');
  wrap.className = 'asset-icon';
  wrap.style.width = size + 'px';
  wrap.style.height = size + 'px';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = item.zh || item.id;
  attachChain(img, texCandidates(item.tex || 'i', item.id), () => {
    wrap.innerHTML = '';
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.style.background = item.color || hashColor(item.id);
    ph.textContent = (item.zh || item.id || '?')[0];
    wrap.appendChild(ph);
  });
  wrap.appendChild(img);
  return wrap;
}

/* 页面静态图标：<img class="mc-icon" data-mc="物品id"> */
function fillStaticIcons(root) {
  (root || document).querySelectorAll('img.mc-icon:not([data-icon-done])').forEach(el => {
    const id = el.dataset.mc;
    const item = ITEM_BY_ID.get(id) || { id, zh: id, tex: 'i' };
    el.dataset.iconDone = '1';
    attachChain(el, texCandidates(item.tex || 'i', id), () => { el.style.visibility = 'hidden'; });
  });
}

/* ================= 素材数据 ================= */
const ITEMS = [];
const ITEM_BY_ID = new Map();
(function () {
  const seen = new Set();
  for (const row of (window.MC_ITEMS || [])) {
    const [id, zh, en, group, tex] = row;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = { id, zh, en, group, tex };
    ITEMS.push(item);
    ITEM_BY_ID.set(id, item);
  }
})();

/* ================= API ================= */
async function jreq(path, method = 'GET', body) {
  const res = await fetch(API_BASE + path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('服务器响应格式错误'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (HTTP ${res.status})`);
  return data;
}
const jget = p => jreq(p);
const jpost = (p, b) => jreq(p, 'POST', b);

async function detectBackend() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 2500);
    const res = await fetch(API_BASE + '/api/health', { signal: ctl.signal });
    clearTimeout(timer);
    const d = await res.json();
    if (d && d.ok) state.demo = false;
  } catch { state.demo = true; }
  $('#demoBanner').classList.toggle('hidden', !state.demo);
  if (!state.demo) {
    try {
      const me = await jget('/api/me');
      state.user = me.user;
      state.quota = me.quota;
    } catch {}
  }
  renderUserChip();
}

async function refreshQuota() {
  if (state.demo) return;
  try { const d = await jget('/api/me'); state.user = d.user; state.quota = d.quota; renderUserChip(); renderQuotaHint(); } catch {}
}

/* ================= 视图切换 ================= */
function goto(tab) {
  $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  if (tab === 'assets') renderAssets();
  if (tab === 'create') { updateBasketUI(); renderQuotaHint(); }
  if (tab === 'account') renderAccount();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ================= 素材库渲染 ================= */
function renderGroups() {
  const box = $('#assetGroups');
  box.innerHTML = '';
  for (const g of (window.MC_GROUPS || ['全部'])) {
    const b = document.createElement('button');
    b.className = 'chip' + (g === state.group ? ' active' : '');
    b.textContent = g;
    b.onclick = () => { state.group = g; renderAssets(); };
    box.appendChild(b);
  }
}

function renderAssets() {
  renderGroups();
  const grid = $('#assetGrid');
  grid.innerHTML = '';
  const q = state.query.trim().toLowerCase();
  const list = ITEMS.filter(it =>
    (state.group === '全部' || it.group === state.group) &&
    (!q || it.id.includes(q) || it.zh.includes(q) || (it.en || '').toLowerCase().includes(q))
  );
  $('#assetCount').textContent = `共 ${list.length} 个素材`;
  const frag = document.createDocumentFragment();
  for (const it of list) {
    const card = document.createElement('div');
    card.className = 'asset-card' + (state.basket.has(it.id) ? ' picked' : '');
    card.title = `${it.zh} (${it.id})`;
    card.appendChild(makeIcon(it, 42));
    const n = document.createElement('div'); n.className = 'asset-name'; n.textContent = it.zh;
    const i = document.createElement('div'); i.className = 'asset-id'; i.textContent = it.id;
    card.append(n, i);
    card.onclick = () => {
      if (state.basket.has(it.id)) state.basket.delete(it.id); else state.basket.add(it.id);
      card.classList.toggle('picked', state.basket.has(it.id));
      saveBasket(); updateBasketUI();
    };
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function saveBasket() {
  try { localStorage.setItem('bd_basket', JSON.stringify([...state.basket])); } catch {}
}

function updateBasketUI() {
  const n = state.basket.size;
  $('#basketCount').textContent = n;
  $('#basketInlineCount').textContent = n;
  $('#basketBar').classList.toggle('hidden', n === 0);
  const prev = $('#basketPreview');
  prev.innerHTML = '';
  let shown = 0;
  for (const id of state.basket) {
    if (shown++ >= 18) { const more = document.createElement('span'); more.className = 'hint'; more.textContent = `…等 ${n} 个`; prev.appendChild(more); break; }
    const it = ITEM_BY_ID.get(id);
    if (!it) continue;
    prev.appendChild(makeIcon(it, 30));
  }
}

/* ================= 生成流程 ================= */
const STEPS = ['queued', 'ai', 'spec', 'build', 'done'];
function setTimeline(step, errText) {
  const lis = $$('#timeline li');
  if (step === 'err') {
    let marked = false;
    lis.forEach(li => {
      if (!marked && !li.classList.contains('ok')) { li.classList.remove('active'); li.classList.add('err'); marked = true; }
    });
    if (errText) toast('出错：' + errText);
    return;
  }
  const idx = STEPS.indexOf(step);
  lis.forEach((li, i) => {
    li.classList.remove('err');
    li.classList.toggle('ok', i < idx);
    li.classList.toggle('active', i === idx);
  });
}

function busy(btn, on) { btn.disabled = on; btn.style.opacity = on ? .6 : 1; }

const KIND_LABEL = { item: '物品', sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', food: '食物', block: '方块' };

function buildDemoSpec(idea, picked) {
  const base = {
    mod_id: 'emerald_workshop',
    mod_name: '绿宝石工坊',
    description: 'A shining emerald-themed toolkit crafted by BlockDream.',
    theme: '#34d399',
    items: [
      { id: 'emerald_sword', name_zh: '绿宝石剑', name_en: 'Emerald Sword', kind: 'sword', material: 'emerald', base_texture: 'diamond_sword', color: '#34d399' },
      { id: 'emerald_pickaxe', name_zh: '绿宝石镐', name_en: 'Emerald Pickaxe', kind: 'pickaxe', material: 'emerald', base_texture: 'diamond_pickaxe', color: '#34d399' },
      { id: 'emerald_apple', name_zh: '绿宝石果实', name_en: 'Emerald Fruit', kind: 'food', nutrition: 6, saturation: 1.2, base_texture: 'apple', color: '#4ade80' },
      { id: 'emerald_block', name_zh: '绿宝石晶块', name_en: 'Emerald Crystal Block', kind: 'block', material: 'emerald', color: '#22a865' },
    ],
  };
  let pi = 0;
  for (const id of picked) {
    if (pi >= base.items.length) break;
    const it = ITEM_BY_ID.get(id);
    if (it && !base.items[pi].base_texture) base.items[pi].base_texture = it.id;
    pi++;
  }
  if (idea) base.description = idea.slice(0, 100);
  return base;
}

async function doGenerate() {
  const idea = $('#ideaInput').value.trim();
  if (idea.length < 4) { toast('再多写几个字描述一下吧～'); return; }
  if (!state.demo && !state.user) { toast('请先登录后再生成'); goto('account'); return; }
  const btn = $('#btnGenerate');
  busy(btn, true);
  $('#buildActions').classList.add('hidden');
  $('#resultBox').classList.add('hidden');
  setTimeline('queued');
  try {
    if (state.demo) {
      setTimeline('ai');
      await sleep(1500);
      state.currentSpec = buildDemoSpec(idea, state.basket);
      state.currentTask = { id: 'demo-' + Date.now(), status: 'drafted', idea, created_at: Date.now() / 1000 };
      setTimeline('spec');
      renderSpec(state.currentSpec);
      $('#buildActions').classList.remove('hidden');
      toast('演示模式：规格为本地模拟生成');
      pushDemoTask(state.currentTask);
    } else {
      setTimeline('ai');
      const d = await jpost('/api/generate', {
        idea,
        mc_version: $('#mcVersion').value,
        loader: $('#loaderSelect').value,
        assets: $('#useBasket').checked ? [...state.basket] : [],
      });
      state.currentTask = d.task;
      state.currentSpec = d.spec;
      setTimeline('spec');
      renderSpec(d.spec);
      $('#buildActions').classList.remove('hidden');
      refreshQuota();
    }
  } catch (e) {
    setTimeline('err', e.message);
  }
  busy(btn, false);
}

function renderSpec(spec) {
  const box = $('#specPreview');
  box.classList.remove('empty');
  const items = (spec.items || []);
  const html = [];
  html.push(`<div class="spec-card">`);
  html.push(`<div class="spec-title"><span class="spec-theme-dot" style="background:${esc(spec.theme || '#34d399')}"></span>${esc(spec.mod_name || spec.mod_id)} <span class="hint">id: ${esc(spec.mod_id)} · ${items.length} 个物品</span></div>`);
  html.push(`<div class="spec-desc">${esc(spec.description || '')}</div>`);
  html.push(`<div class="spec-items">`);
  items.forEach((it, i) => {
    html.push(`<div class="spec-item"><span class="icon" data-spec-icon="${i}"></span><span class="kind">${KIND_LABEL[it.kind] || esc(it.kind)}</span><b>${esc(it.name_zh || it.id)}</b><span class="hint">${esc(it.id)}${it.material ? ' · 材料 ' + esc(it.material) : ''}</span></div>`);
  });
  html.push(`</div>`);
  html.push(`<details class="spec-json"><summary>查看完整 JSON 规格</summary><pre>${esc(JSON.stringify(spec, null, 2))}</pre></details>`);
  html.push(`</div>`);
  box.innerHTML = html.join('');

  items.forEach((it, i) => {
    const slot = box.querySelector(`[data-spec-icon="${i}"]`);
    if (!slot) return;
    slot.appendChild(makeSpecIcon(it));
  });
}

function makeSpecIcon(it) {
  const wrap = document.createElement('div');
  wrap.style.width = '26px'; wrap.style.height = '26px';
  const bt = it.base_texture;
  if (!bt) {
    wrap.innerHTML = `<div class="ph" style="width:100%;height:100%;border-radius:3px;background:${esc(it.color || hashColor(it.id))}"></div>`;
    return wrap;
  }
  const img = document.createElement('img');
  img.style.cssText = 'width:100%;height:100%;image-rendering:pixelated';
  const ver = state.assetsVersion;
  const paths = [`textures/item/${bt}.png`, `textures/block/${bt}.png`];
  let pi = 0, k = cdnPref;
  const next = () => {
    if (pi >= paths.length) { k++; pi = 0; }
    if (k >= CDNS.length) {
      wrap.innerHTML = `<div class="ph" style="width:100%;height:100%;border-radius:3px;background:${esc(it.color || hashColor(it.id))}"></div>`;
      return;
    }
    img.src = CDNS[k].url(ver, paths[pi]);
    pi++;
  };
  img.onerror = next;
  wrap.appendChild(img);
  next();
  return wrap;
}

function pushDemoTask(task) {
  state.tasks.unshift(task);
  state.tasks = state.tasks.slice(0, 20);
  saveDemoTasks();
}

function saveDemoTasks() {
  try { localStorage.setItem('bd_demo_tasks', JSON.stringify(state.tasks)); } catch {}
}

async function doBuild() {
  if (!state.currentSpec) return;
  const btn = $('#btnBuild');
  busy(btn, true);
  if (state.demo) {
    setTimeline('build');
    await sleep(2200);
    if (state.currentTask) { state.currentTask.status = 'done'; saveDemoTasks(); }
    setTimeline('done');
    showResult(null);
    busy(btn, false);
    return;
  }
  try {
    setTimeline('build');
    await jpost('/api/build', { task_id: state.currentTask.id });
    pollTask(state.currentTask.id);
  } catch (e) {
    setTimeline('err', e.message);
    busy(btn, false);
  }
}

function pollTask(id) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const d = await jget('/api/task/' + id);
      state.currentTask = d.task;
      if (d.task.status === 'done') {
        clearInterval(state.pollTimer);
        setTimeline('done');
        showResult(d.task);
        busy($('#btnBuild'), false);
        renderTasksIfVisible();
      } else if (d.task.status === 'error') {
        clearInterval(state.pollTimer);
        setTimeline('err', d.task.error || '构建失败');
        busy($('#btnBuild'), false);
        renderTasksIfVisible();
      } else {
        renderTasksIfVisible();
      }
    } catch {}
  }, 5000);
}

function showResult(task) {
  const box = $('#resultBox');
  box.classList.remove('hidden', 'err');
  if (!task) {
    box.innerHTML = `<img class="mc-icon" data-mc="clock" alt=""><b>演示模式</b>：真实部署后端后，这一步会由 GitHub Actions 云端编译，编译完成后在这里出现 JAR 下载按钮。<br><span class="hint">流程：Worker 触发 workflow → 生成 Fabric 工程 → gradle 编译 → 回传产物。</span>`;
    fillStaticIcons(box);
    return;
  }
  const name = task.jar_name || 'mod.zip';
  box.innerHTML = `<img class="mc-icon" data-mc="emerald" alt=""><b>构建完成！</b> 下载后解压，把里面的 <code>.jar</code> 放进 <code>.minecraft/mods</code> 文件夹即可（需要 Fabric Loader + Fabric API）。<br>
  <a class="btn primary dl" href="${API_BASE}/api/download/${encodeURIComponent(task.id)}"><img class="mc-icon" data-mc="hopper" alt="">下载 ${esc(name)}</a>`;
  fillStaticIcons(box);
}

function renderQuotaHint() {
  const el = $('#quotaHint');
  if (state.demo) { el.textContent = '演示模式：不限次数；部署后端后按套餐限流（免费版 3 次/天）。'; return; }
  if (!state.user) { el.textContent = '登录后可生成（免费版每天 3 次）。'; return; }
  const q = state.quota || {};
  el.textContent = `今日剩余 ${q.left ?? '-'} 次 · 单次输出上限 ${q.max_tokens ?? '-'} tokens · 套餐：${q.plan_label || state.user.plan}`;
}

/* ================= 账号 ================= */
function renderUserChip() {
  const chip = $('#userChip');
  if (state.user) {
    chip.textContent = state.user.email;
    chip.classList.add('on');
  } else {
    chip.textContent = '未登录';
    chip.classList.remove('on');
  }
}

function renderAccount() {
  const logged = !!state.user;
  $('#authPanel').classList.toggle('hidden', logged);
  $('#profilePanel').classList.toggle('hidden', !logged);
  if (!logged) return;
  $('#profileEmail').textContent = state.user.email;
  const planLabel = state.user.plan === 'pro' ? '专业版' : '免费版';
  $('#profilePlan').textContent = planLabel;
  $('#profileQuota').textContent = state.quota ? (state.quota.left ?? '-') : '-';
  const used = state.user.tokens_used || 0;
  $('#tokenBarText').textContent = `累计消耗 ${used.toLocaleString()} tokens`;
  $('#tokenBarFill').style.width = Math.min(100, used / 5000) + '%';
  renderTasks();
}

function statusLabel(s) {
  return { drafted: '规格已生成', building: '构建中…', done: '完成', error: '失败' }[s] || s;
}

function renderTasks() {
  const box = $('#taskList');
  box.innerHTML = '';
  const tasks = state.tasks || [];
  if (!tasks.length) { box.innerHTML = '<div class="hint">还没有任务。去「造模组」提交你的第一个想法吧！</div>'; return; }
  for (const t of tasks) {
    const card = document.createElement('div');
    card.className = 'task-card';
    const date = t.created_at ? new Date(t.created_at * 1000).toLocaleString('zh-CN') : '';
    let dl = '';
    if (t.status === 'done' && !state.demo) {
      dl = `<a class="btn ghost small" style="text-decoration:none" href="${API_BASE}/api/download/${encodeURIComponent(t.id)}">下载</a>`;
    }
    card.innerHTML = `
      <div class="task-head">
        <span class="status-chip ${esc(t.status)}">${esc(statusLabel(t.status))}</span>
        <span class="task-date">${esc(date)}</span>
      </div>
      <div class="task-idea">${esc((t.idea || '').slice(0, 120))}</div>
      ${dl ? `<div style="margin-top:8px">${dl}</div>` : ''}`;
    box.appendChild(card);
  }
}

function renderTasksIfVisible() {
  if ($('#view-account').classList.contains('active')) renderTasks();
}

async function loadTasks() {
  if (state.demo) return;
  try {
    const d = await jget('/api/tasks');
    state.tasks = d.tasks || [];
  } catch {}
}

async function doAuth(kind) {
  const isReg = kind === 'register';
  const email = $(isReg ? '#regEmail' : '#loginEmail').value.trim();
  const password = $(isReg ? '#regPassword' : '#loginPassword').value;
  const msg = $('#authMsg');
  msg.classList.remove('err');
  if (!email || password.length < 8) { msg.textContent = '请填写邮箱和至少 8 位密码'; msg.classList.add('err'); return; }
  try {
    if (state.demo) {
      await sleep(500);
      state.user = { email, plan: 'free', tokens_used: 0 };
      try { localStorage.setItem('bd_demo_user', JSON.stringify(state.user)); } catch {}
      msg.textContent = '演示模式：已本地登录（未连接后端）';
      renderUserChip(); renderAccount();
      return;
    }
    if (isReg) {
      const d = await jpost('/api/register', { email, password });
      msg.textContent = d.message || '注册成功！';
      state.user = d.user;
    } else {
      const d = await jpost('/api/login', { email, password });
      state.user = d.user;
      state.quota = d.quota;
      msg.textContent = '登录成功';
    }
    renderUserChip(); renderAccount();
    await loadTasks(); renderTasks();
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.classList.add('err');
  }
}

async function doLogout() {
  if (!state.demo) { try { await jpost('/api/logout'); } catch {} }
  state.user = null; state.quota = null; state.tasks = [];
  try { localStorage.removeItem('bd_demo_user'); localStorage.removeItem('bd_demo_tasks'); } catch {}
  renderUserChip(); renderAccount();
  toast('已退出登录');
}

/* ================= 主题切换 ================= */
function updateThemeBtn() {
  const btn = $('#themeToggle');
  const light = document.documentElement.classList.contains('light');
  btn.innerHTML = '';
  const img = document.createElement('img');
  img.className = 'mc-icon';
  img.dataset.mc = light ? 'glowstone' : 'torch';
  img.alt = '';
  btn.appendChild(img);
  btn.appendChild(document.createTextNode(light ? '深色' : '浅色'));
  fillStaticIcons(btn);
}

function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  try { localStorage.setItem('bd_theme', t); } catch {}
  updateThemeBtn();
}

/* ================= 通知 ================= */
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}

/* ================= 事件绑定 & 启动 ================= */
function bind() {
  $$('.tab').forEach(b => b.onclick = () => goto(b.dataset.tab));
  $$('[data-goto]').forEach(b => b.onclick = () => goto(b.dataset.goto));
  $('#assetSearch').oninput = e => { state.query = e.target.value; renderAssets(); };
  $('#assetVersion').onchange = e => { state.assetsVersion = e.target.value; renderAssets(); updateBasketUI(); };
  $('#btnBasketClear').onclick = () => { state.basket.clear(); saveBasket(); updateBasketUI(); renderAssets(); };
  $('#btnBasketGo').onclick = () => goto('create');
  $('#btnGenerate').onclick = doGenerate;
  $('#btnBuild').onclick = doBuild;
  $('#btnReset').onclick = () => {
    clearInterval(state.pollTimer);
    state.currentSpec = null; state.currentTask = null;
    $('#buildActions').classList.add('hidden');
    $('#resultBox').classList.add('hidden');
    $('#specPreview').classList.add('empty');
    $('#specPreview').textContent = '还没有任务。左边写好想法，点「让 AI 设计模组」。';
    setTimeline('queued');
  };
  $$('.atab').forEach(b => b.onclick = () => {
    $$('.atab').forEach(x => x.classList.toggle('active', x === b));
    $('#loginForm').classList.toggle('hidden', b.dataset.auth !== 'login');
    $('#registerForm').classList.toggle('hidden', b.dataset.auth !== 'register');
    $('#authMsg').textContent = '';
  });
  $('#loginForm').onsubmit = e => { e.preventDefault(); doAuth('login'); };
  $('#registerForm').onsubmit = e => { e.preventDefault(); doAuth('register'); };
  $('#btnLogout').onclick = doLogout;
  $('#btnRefreshTasks').onclick = () => loadTasks().then(renderTasks);
  $('#btnPro').onclick = () => toast('专业版内测通道即将开放（支付接入后上线）');
  $('#themeToggle').onclick = () => applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
}

async function init() {
  bind();
  fillStaticIcons();
  updateThemeBtn();
  renderGroups();
  updateBasketUI();
  await detectBackend();
  if (state.demo) {
    try {
      const u = JSON.parse(localStorage.getItem('bd_demo_user') || 'null');
      if (u) { state.user = u; renderUserChip(); }
      state.tasks = JSON.parse(localStorage.getItem('bd_demo_tasks') || '[]');
    } catch {}
  } else {
    await loadTasks();
  }
  renderQuotaHint();
}

init();

})();
