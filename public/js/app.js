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
  orders: [],
};
let pendingAuth = null;   // 注册后等待邮箱验证的 {email, password}
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
  if (!res.ok || data.ok === false) {
    const e = new Error(data.error || `请求失败 (HTTP ${res.status})`);
    e.code = data.code;
    e.data = data;
    throw e;
  }
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

const KIND_LABEL = { item: '物品', sword: '剑', pickaxe: '镐', axe: '斧', shovel: '锹', hoe: '锄', helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子', food: '食物', block: '方块' };

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
    if (e.code === 'quota_exceeded') { setTimeline('queued'); openCreditModal(e.message); }
    else if (e.code === 'premium_version') { setTimeline('queued'); openPremiumModal(e.message); }
    else if (e.code === 'unauthorized') { setTimeline('queued'); toast('请先登录'); goto('account'); }
    else setTimeline('err', e.message);
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
  <a class="btn primary dl" href="${API_BASE}/api/download/${encodeURIComponent(task.id)}"><img class="mc-icon" data-mc="hopper" alt="">下载 ${esc(name)}</a>
  <button class="btn ghost dl" data-jarview="${esc(task.id)}"><img class="mc-icon" data-mc="shulker_box" alt="">查看内容</button>`;
  fillStaticIcons(box);
}

function renderQuotaHint() {
  const el = $('#quotaHint');
  if (state.demo) { el.textContent = '演示模式：不限次数；部署后端后按套餐限流（标准版每天 3 次）。'; return; }
  if (!state.user) { el.textContent = '登录后可生成（标准版每天 3 次）。'; return; }
  const q = state.quota || {};
  const extra = (q.credits > 0) ? ` · 单次额度 ${q.credits} 个` : '';
  el.textContent = `今日剩余 ${q.left ?? '-'} 次${extra} · 单次输出上限 ${q.max_tokens ?? '-'} tokens · 套餐：${q.plan_label || state.user.plan}`;
}

/* ================= 购买 / 支付 ================= */
function openBuyModal(title, bodyHtml, wide) {
  $('#buyTitle').textContent = title;
  $('#buyBody').innerHTML = bodyHtml;
  const card = $('#buyModal').querySelector('.modal-card');
  if (card) card.classList.toggle('wide', !!wide);
  $('#buyModal').classList.remove('hidden');
  fillStaticIcons($('#buyModal'));
}
function closeBuyModal() {
  $('#buyModal').classList.add('hidden');
  const card = $('#buyModal').querySelector('.modal-card');
  if (card) card.classList.remove('wide');
}

async function startBuy(kind, planKey, payType) {
  if (state.demo) { toast('演示模式：下单需要连接后端'); return; }
  if (!state.user) { toast('请先登录后再购买'); goto('account'); return; }
  try {
    const d = await jpost('/api/order/create', { kind, plan: planKey, pay_type: payType || 'wxpay' });
    const o = d.order;
    const pay = d.pay || {};
    const title = o.kind === 'credit' ? `单次购买 ¥${o.amount}` : `购买套餐 ¥${o.amount}`;
    if (pay.mode === 'epay' && pay.pay_url) {
      openBuyModal(title, `
        <div>订单号：<span class="order-id">${esc(o.id)}</span> · 金额：<b>¥${o.amount}</b></div>
        <div class="hint" style="margin-top:8px">已为你打开支付页面（微信/支付宝扫码）。支付完成后自动到账，本窗口会自动检测，请勿先关闭本页面。</div>
        <div class="modal-actions">
          <button class="btn small" id="reopenPay">重新打开支付页</button>
          <button class="btn ghost small" id="switchAli">改用支付宝</button>
          <button class="btn primary small" id="paidDone">已支付，立即刷新</button>
        </div>
        <div class="hint">若超过半分钟未到账，可点「立即刷新」，或稍后在「我的」页查看订单状态。</div>`);
      window.open(pay.pay_url, '_blank');
      $('#reopenPay').onclick = () => window.open(pay.pay_url, '_blank');
      $('#switchAli').onclick = () => startBuy(kind, planKey, 'alipay');
      $('#paidDone').onclick = () => pollOrderPaid(o.id, true);
      pollOrderPaid(o.id);
      return;
    }
    const rows = [];
    rows.push(`<div>订单号：<span class="order-id">${esc(o.id)}</span>（支付时请备注订单号）</div>`);
    rows.push(`<div>金额：<b>¥${o.amount}</b> · 状态：<b>待支付</b></div>`);
    if (pay.qr) rows.push(`<div style="margin-top:8px"><img src="${esc(pay.qr)}" alt="收款码" style="max-width:220px;border:2px solid var(--line);border-radius:4px"></div>`);
    if (pay.instructions) rows.push(`<div class="hint" style="margin-top:8px">${esc(pay.instructions)}</div>`);
    if (pay.contact) rows.push(`<div class="hint">联系管理员：${esc(pay.contact)}</div>`);
    rows.push(`<div class="modal-actions"><button class="btn small" id="copyOrder">复制订单号</button><button class="btn primary small" id="paidDone">我已支付</button></div>`);
    rows.push(`<div class="hint">管理员确认收款后立即生效（可在「我的」页面查看订单状态）。</div>`);
    openBuyModal(title, rows.join(''));
    $('#copyOrder').onclick = () => { try { navigator.clipboard.writeText(o.id); toast('订单号已复制'); } catch { toast(o.id); } };
    $('#paidDone').onclick = () => { closeBuyModal(); toast('已记录，请等待管理员确认收款'); };
  } catch (e) { toast('下单失败：' + e.message); }
}

let payPollTimer = null;
async function pollOrderPaid(orderId, single) {
  if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; }
  let n = 0;
  const check = async () => {
    n++;
    try {
      const d = await jget('/api/orders');
      const ord = (d.orders || []).find(x => x.id === orderId);
      if (ord && ord.status === 'paid') {
        if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; }
        closeBuyModal();
        toast('支付成功，已到账！');
        try { const me = await jget('/api/me'); state.user = me.user; state.quota = me.quota; renderUserChip(); renderAccount(); } catch {}
      }
    } catch {}
    if (n >= 60 && payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; }
  };
  await check();
  if (!single) payPollTimer = setInterval(check, 3000);
}

function openCreditModal(msg) {
  const html = `<p>${esc(msg || '今日额度已用完')}</p>
  <p><b>¥5 单次购买</b>：立即增加 1 次生成额度（随时可用，用完为止）。</p>
  <div class="modal-actions"><button class="btn primary" id="buyCreditBtn">单次购买 ¥5</button><button class="btn ghost" id="closeCreditBtn">再看看</button></div>`;
  openBuyModal('额度用完啦', html);
  $('#buyCreditBtn').onclick = () => { closeBuyModal(); startBuy('credit'); };
  $('#closeCreditBtn').onclick = closeBuyModal;
}

function openPremiumModal(msg) {
  const html = `<p>${esc(msg || '26.x 新版本需要套餐或单次购买')}</p>
  <ul>
    <li>进阶版 ¥35/月 · 高思考 · 10 次/天</li>
    <li>高级版 ¥89/月 · 最高推理 · 20 次/天 · 解锁 26.x</li>
    <li>专业版 ¥159/月 · DeepSeek V4 Pro · 25 次/天 · 解锁 26.x</li>
    <li><b>或者单次购买 ¥5</b>：用加油包生成一次 26.x 模组</li>
  </ul>
  <div class="modal-actions">
    <button class="btn small" id="pmBuy35">进阶版 ¥35</button>
    <button class="btn gold small" id="pmBuy89">高级版 ¥89</button>
    <button class="btn gold small" id="pmBuy159">专业版 ¥159</button>
    <button class="btn primary small" id="pmCredit">单次 ¥5</button>
  </div>`;
  openBuyModal('解锁 26.x 新版本', html);
  $('#pmBuy35').onclick = () => { closeBuyModal(); startBuy('plan', 'plus35'); };
  $('#pmBuy89').onclick = () => { closeBuyModal(); startBuy('plan', 'pro89'); };
  $('#pmBuy159').onclick = () => { closeBuyModal(); startBuy('plan', 'max159'); };
  $('#pmCredit').onclick = () => { closeBuyModal(); startBuy('credit'); };
}

/* ================= 构建产物内容查看器 ================= */
let jarCtx = { taskId: null, files: [] };

async function openJarViewer(taskId) {
  jarCtx = { taskId, files: [] };
  openBuyModal('构建产物内容', '<div class="hint">正在读取 jar…</div>', true);
  try {
    const d = await jget('/api/task/' + encodeURIComponent(taskId) + '/tree');
    jarCtx.files = d.files || [];
    renderJarViewer(d.jar, jarCtx.files);
  } catch (e) {
    $('#buyBody').innerHTML = `<div class="hint bad">读取失败：${esc(e.message)}</div>`;
  }
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}

function renderJarViewer(jarName, files) {
  const groups = {};
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = i < 0 ? '(根目录)' : f.path.slice(0, i);
    (groups[dir] = groups[dir] || []).push(f);
  }
  const order = Object.keys(groups).sort((a, b) => {
    if (a === '(根目录)') return -1;
    if (b === '(根目录)') return 1;
    if (a.startsWith('assets/') && !b.startsWith('assets/')) return -1;
    if (b.startsWith('assets/') && !a.startsWith('assets/')) return 1;
    return a.localeCompare(b);
  });
  const treeHtml = order.map(dir => {
    const rows = groups[dir].sort((x, y) => x.path.localeCompare(y.path)).map(f => {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      return `<button class="file" data-jarpath="${esc(f.path)}">${esc(name)}<span class="jar-size">${fmtSize(f.size)}</span></button>`;
    }).join('');
    return `<div class="dir">${esc(dir)}/</div>${rows}`;
  }).join('');
  $('#buyBody').innerHTML = `
    <div class="hint"><b>${esc(jarName)}</b> · 共 ${files.length} 个文件 —— 左边点文件，右边预览（贴图、模型、配方、语言文件都能看）</div>
    <div class="jar-grid">
      <div class="jar-tree" id="jarTree">${treeHtml}</div>
      <div class="jar-preview" id="jarPreview"><div class="hint">← 点左边的文件预览</div></div>
    </div>`;
  const tree = $('#jarTree');
  tree.querySelectorAll('[data-jarpath]').forEach(b => {
    b.onclick = () => {
      tree.querySelectorAll('.file.active').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      previewJarFile(jarCtx.taskId, b.dataset.jarpath);
    };
  });
  const firstImg = files.find(f => /\.png$/i.test(f.path));
  if (firstImg) {
    const btn = [...tree.querySelectorAll('[data-jarpath]')].find(x => x.dataset.jarpath === firstImg.path);
    if (btn) btn.click();
  }
}

async function previewJarFile(taskId, path) {
  const box = $('#jarPreview');
  box.innerHTML = '<div class="hint">加载中…</div>';
  const url = API_BASE + '/api/task/' + encodeURIComponent(taskId) + '/file?p=' + encodeURIComponent(path);
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ext = path.split('.').pop().toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif'].includes(ext)) {
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      box.innerHTML = `<div class="hint">${esc(path)}</div><div><img src="${objUrl}" alt=""></div>`;
      return;
    }
    if (['json', 'txt', 'toml', 'mcmeta', 'lang', 'properties', 'cfg', 'md', 'java', 'json5'].includes(ext)) {
      const text = await res.text();
      box.innerHTML = `<div class="hint">${esc(path)}</div><pre class="jar-text">${esc(text.slice(0, 30000))}</pre>`;
      return;
    }
    box.innerHTML = `<div class="hint">${esc(path)}</div><div class="hint">二进制文件（编译后的 .class），不提供预览。</div>`;
  } catch (e) {
    box.innerHTML = `<div class="hint bad">预览失败：${esc(e.message)}</div>`;
  }
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

const PLAN_LABELS = { free: '标准版', plus35: '进阶版', pro89: '高级版', max159: '专业版' };
function renderAccount() {
  const logged = !!state.user;
  $('#authPanel').classList.toggle('hidden', logged);
  $('#profilePanel').classList.toggle('hidden', !logged);
  if (!logged) return;
  $('#profileEmail').textContent = state.user.email;
  const planLabel = PLAN_LABELS[state.user.plan] || '标准版';
  const exp = state.user.plan_expires_at ? `（${new Date(state.user.plan_expires_at).toLocaleDateString('zh-CN')} 到期）` : '';
  $('#profilePlan').textContent = planLabel + exp;
  $('#profileQuota').textContent = state.quota ? (state.quota.left ?? '-') : '-';
  const credits = state.user.credits || 0;
  const creditsEl = $('#profileCredits');
  if (creditsEl) creditsEl.textContent = credits;
  const used = state.user.tokens_used || 0;
  $('#tokenBarText').textContent = `累计消耗 ${used.toLocaleString()} tokens · 单次额度加油包 ${credits} 个`;
  $('#tokenBarFill').style.width = Math.min(100, used / 5000) + '%';
  renderTasks();
  if (!state.demo) { loadOrders().then(renderOrders); renderOrders(); }
}

async function loadOrders() {
  try { const d = await jget('/api/orders'); state.orders = d.orders || []; } catch {}
}

function renderOrders() {
  const box = $('#orderList');
  if (!box) return;
  const list = state.orders || [];
  if (!list.length) { box.innerHTML = '<div class="hint">还没有订单。</div>'; return; }
  const st = { pending: '待支付', paid: '已支付', cancelled: '已取消' };
  box.innerHTML = list.map(o => `<div class="order-row"><span class="order-id">${esc(o.id)}</span> ${esc(o.kind === 'credit' ? '单次额度' : (PLAN_LABELS[o.plan] || o.plan || '-'))} ¥${o.amount} <b>${st[o.status] || o.status}</b> <span class="hint">${new Date((o.created_at || 0)).toLocaleString('zh-CN')}</span></div>`).join('');
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
      dl = `<a class="btn ghost small" style="text-decoration:none" href="${API_BASE}/api/download/${encodeURIComponent(t.id)}">下载</a>` +
           `<button class="btn ghost small" data-jarview="${esc(t.id)}">查看内容</button>`;
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
      if (d.need_verify) {
        pendingAuth = { email, password };
        $('#verifyHint').textContent = `验证码已发送到 ${email}，请查收（15 分钟内有效）。`;
        $('#registerForm').classList.add('hidden');
        $('#verifyForm').classList.remove('hidden');
        return;
      }
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
    if (e.code === 'unverified') {
      pendingAuth = { email: (isReg ? $('#regEmail').value : $('#loginEmail').value).trim(), password: isReg ? $('#regPassword').value : $('#loginPassword').value };
      $('#verifyHint').textContent = '账号尚未验证，请输入邮箱验证码（收不到可点击重新发送）。';
      $('#loginForm').classList.add('hidden');
      $('#registerForm').classList.add('hidden');
      $('#verifyForm').classList.remove('hidden');
      msg.textContent = '';
      return;
    }
    msg.textContent = '失败：' + e.message;
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
  $$('.atab').forEach(b => {
    const old = b.onclick;
    b.addEventListener('click', () => { $('#verifyForm').classList.add('hidden'); }, true);
  });
  $('#verifyForm').onsubmit = async e => {
    e.preventDefault();
    if (!pendingAuth) { toast('请先注册'); return; }
    const code = $('#verifyCode').value.trim();
    const msg = $('#authMsg');
    try {
      await jpost('/api/verify', { email: pendingAuth.email, code });
      const d = await jpost('/api/login', { email: pendingAuth.email, password: pendingAuth.password });
      state.user = d.user;
      state.quota = d.quota;
      msg.classList.remove('err');
      msg.textContent = '邮箱验证成功，已自动登录！';
      $('#verifyForm').classList.add('hidden');
      renderUserChip(); renderAccount();
      await loadTasks(); renderTasks();
      pendingAuth = null;
    } catch (e2) {
      msg.textContent = '失败：' + e2.message;
      msg.classList.add('err');
    }
  };
  $('#btnResendCode').onclick = async () => {
    if (!pendingAuth) { toast('请先注册'); return; }
    try { const d = await jpost('/api/verify/send', { email: pendingAuth.email }); toast(d.message); }
    catch (e) { toast('发送失败：' + e.message); }
  };
  $('#btnLogout').onclick = doLogout;
  $('#btnRefreshTasks').onclick = () => loadTasks().then(renderTasks);
  $$('[data-buy]').forEach(b => b.onclick = () => startBuy('plan', b.dataset.buy));
  $('#buyClose').onclick = closeBuyModal;
  const jarDelegate = e => { const b = e.target.closest('[data-jarview]'); if (b) openJarViewer(b.dataset.jarview); };
  const _tl = $('#taskList'); if (_tl) _tl.addEventListener('click', jarDelegate);
  const _rb = $('#resultBox'); if (_rb) _rb.addEventListener('click', jarDelegate);
  $('#buyModal').addEventListener('click', e => { if (e.target === $('#buyModal')) closeBuyModal(); });
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
