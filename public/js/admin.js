/* ModCraft · 管理后台逻辑 */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const API_BASE = (['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '8787') ? 'http://localhost:8788' : '';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = '';
try { token = sessionStorage.getItem('mc_admin_token') || ''; } catch {}

async function api(path, method = 'GET', body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new Error('响应不是 JSON'); }
  if (!res.ok || data.ok === false) { const e = new Error(data.error || ('HTTP ' + res.status)); e.code = data.code; throw e; }
  return data;
}

let toastTimer;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}
const fmtTime = ms => ms ? new Date(Number(ms)).toLocaleString('zh-CN') : '-';
const PLAN_LABELS = { free: '标准版', plus35: '进阶版', pro89: '高级版', max159: '专业版' };
const ORDER_STATUS = { pending: '待支付', paid: '已支付', cancelled: '已取消' };

function showDash(show) {
  $('#loginPanel').classList.toggle('hidden', show);
  $('#dashPanel').classList.toggle('hidden', !show);
}

let currentTab = 'stats';
function switchTab(tab) {
  currentTab = tab;
  $$('#adminTabs .chip').forEach(c => c.classList.toggle('active', c.dataset.atab === tab));
  ({ stats: renderStats, users: renderUsers, orders: renderOrders, tasks: renderTasks }[tab] || renderStats)();
}

/* ---------- 总览 ---------- */
async function renderStats() {
  $('#adminBody').innerHTML = '<div class="hint">加载中…</div>';
  try {
    const { stats } = await api('/api/admin/stats');
    $('#adminBody').innerHTML = `
      <div class="admin-grid">
        <div class="stat-card">用户数<b>${stats.users}</b></div>
        <div class="stat-card">今日任务<b>${stats.tasks_today}</b></div>
        <div class="stat-card">总任务<b>${stats.tasks_total}</b></div>
        <div class="stat-card">已完成<b>${stats.tasks_done}</b></div>
        <div class="stat-card">待处理订单<b class="${stats.orders_pending ? 'warn' : ''}">${stats.orders_pending}</b></div>
        <div class="stat-card">累计收入<b>¥${stats.revenue}</b></div>
        <div class="stat-card">累计 tokens<b>${Number(stats.tokens_total).toLocaleString()}</b></div>
      </div>
      <button class="btn small" id="rfBtn">刷新</button>`;
    $('#rfBtn').onclick = renderStats;
  } catch (e) { $('#adminBody').innerHTML = `<div class="hint bad">加载失败：${esc(e.message)}</div>`; }
}

/* ---------- 用户 ---------- */
async function renderUsers() {
  $('#adminBody').innerHTML = `
    <div class="toolbar">
      <input id="uq" class="input" placeholder="按邮箱搜索…">
      <button class="btn small" id="ub">搜索</button>
    </div>
    <div id="utable"><div class="hint">加载中…</div></div>`;
  const load = async () => {
    const q = $('#uq').value.trim();
    const { users } = await api('/api/admin/users?q=' + encodeURIComponent(q));
    $('#utable').innerHTML = users.length
      ? `<table class="admin">
          <tr><th>邮箱</th><th>套餐</th><th>到期</th><th>单次额度</th><th>tokens</th><th>注册时间</th><th>操作</th></tr>` +
        users.map(u => `<tr>
          <td>${esc(u.email)}${u.verified ? '' : ' <span class="warn">未验证</span>'}</td>
          <td>${esc(PLAN_LABELS[u.plan] || u.plan)}</td>
          <td>${u.plan_expires_at ? fmtTime(u.plan_expires_at).slice(0, 10) : '-'}</td>
          <td>${u.extra_credits}</td>
          <td>${Number(u.tokens_used).toLocaleString()}</td>
          <td class="hint">${fmtTime(u.created_at)}</td>
          <td>
            <button class="btn ghost small" data-act="plan" data-id="${u.id}">设套餐</button>
            <button class="btn ghost small" data-act="credit" data-id="${u.id}">+1额度</button>
            <button class="btn ghost small" data-act="verify" data-id="${u.id}">激活</button>
          </td></tr>`).join('') + '</table>'
      : '<div class="hint">没有用户</div>';
    $$('#utable [data-act]').forEach(b => b.onclick = async () => {
      try {
        if (b.dataset.act === 'plan') {
          const plan = prompt('输入套餐：free / plus35 / pro89 / max159', 'plus35');
          if (!plan) return;
          const days = prompt('有效天数', '30');
          const r = await api('/api/admin/user', 'POST', { user_id: b.dataset.id, action: 'set_plan', plan: plan.trim(), days: Number(days || 30) });
          toast(r.message);
        } else if (b.dataset.act === 'credit') {
          const r = await api('/api/admin/user', 'POST', { user_id: b.dataset.id, action: 'add_credits', n: 1 });
          toast(r.message);
        } else if (b.dataset.act === 'verify') {
          const r = await api('/api/admin/user', 'POST', { user_id: b.dataset.id, action: 'verify' });
          toast(r.message);
        }
        load();
      } catch (e) { toast('失败：' + e.message); }
    });
  };
  $('#ub').onclick = load;
  $('#uq').addEventListener('keydown', e => { if (e.key === 'Enter') load(); });
  try { await load(); } catch (e) { $('#utable').innerHTML = '<div class="hint bad">加载失败：' + esc(e.message) + '</div>'; }
}

/* ---------- 订单 ---------- */
async function renderOrders() {
  $('#adminBody').innerHTML = `
    <div class="chips">
      <button class="chip" data-of="">全部</button>
      <button class="chip active" data-of="pending">待处理</button>
      <button class="chip" data-of="paid">已支付</button>
      <button class="chip" data-of="cancelled">已取消</button>
    </div>
    <div id="otable"><div class="hint">加载中…</div></div>`;
  let filter = 'pending';
  const load = async () => {
    const { orders } = await api('/api/admin/orders?status=' + filter);
    $('#otable').innerHTML = orders.length
      ? `<table class="admin">
          <tr><th>订单号</th><th>用户</th><th>内容</th><th>金额</th><th>状态</th><th>创建时间</th><th>操作</th></tr>` +
        orders.map(o => `<tr>
          <td class="order-id">${esc(o.id)}</td>
          <td>${esc(o.email || o.user_id)}</td>
          <td>${o.kind === 'credit' ? '单次额度' : (PLAN_LABELS[o.plan] || o.plan || '-')}</td>
          <td>¥${o.amount}</td>
          <td class="${o.status === 'paid' ? 'ok' : o.status === 'pending' ? 'warn' : ''}">${ORDER_STATUS[o.status] || o.status}</td>
          <td class="hint">${fmtTime(o.created_at)}</td>
          <td>${o.status === 'pending'
            ? `<button class="btn primary small" data-oid="${o.id}" data-st="paid">确认收款</button>
               <button class="btn ghost small" data-oid="${o.id}" data-st="cancelled">取消</button>`
            : '-'}</td>
        </tr>`).join('') + '</table>'
      : '<div class="hint">没有订单</div>';
    $$('#otable [data-oid]').forEach(b => b.onclick = async () => {
      if (b.dataset.st === 'paid' && !confirm('确认已收到该笔款项并发放？')) return;
      try {
        const r = await api('/api/admin/order', 'POST', { order_id: b.dataset.oid, status: b.dataset.st });
        toast(r.message);
        load();
      } catch (e) { toast('失败：' + e.message); }
    });
  };
  $$('#adminBody .chip[data-of]').forEach(c => c.onclick = () => {
    filter = c.dataset.of;
    $$('#adminBody .chip[data-of]').forEach(x => x.classList.toggle('active', x === c));
    load();
  });
  try { await load(); } catch (e) { $('#otable').innerHTML = '<div class="hint bad">加载失败：' + esc(e.message) + '</div>'; }
}

/* ---------- 任务 ---------- */
async function renderTasks() {
  $('#adminBody').innerHTML = `
    <div class="chips">
      <button class="chip active" data-tf="">最近</button>
      <button class="chip" data-tf="done">完成</button>
      <button class="chip" data-tf="error">失败</button>
      <button class="chip" data-tf="building">构建中</button>
    </div>
    <div id="ttable"><div class="hint">加载中…</div></div>`;
  let filter = '';
  const load = async () => {
    const { tasks } = await api('/api/admin/tasks?limit=60&status=' + filter);
    $('#ttable').innerHTML = tasks.length
      ? `<table class="admin">
          <tr><th>任务</th><th>用户</th><th>想法</th><th>版本</th><th>状态</th><th>tokens</th><th>时间</th></tr>` +
        tasks.map(t => `<tr>
          <td class="order-id">${esc(t.id)}</td>
          <td>${esc(t.email || t.user_id)}</td>
          <td>${esc((t.idea || '').slice(0, 40))}</td>
          <td>${esc(t.mc_version)}</td>
          <td class="${t.status === 'done' ? 'ok' : t.status === 'error' ? 'bad' : 'warn'}">${esc(t.status)}</td>
          <td>${t.tokens_used || 0}</td>
          <td class="hint">${fmtTime(t.created_at)}</td>
        </tr>`).join('') + '</table>'
      : '<div class="hint">没有任务</div>';
  };
  $$('#adminBody .chip[data-tf]').forEach(c => c.onclick = () => {
    filter = c.dataset.tf;
    $$('#adminBody .chip[data-tf]').forEach(x => x.classList.toggle('active', x === c));
    load();
  });
  try { await load(); } catch (e) { $('#ttable').innerHTML = '<div class="hint bad">加载失败：' + esc(e.message) + '</div>'; }
}

/* ---------- 主题 & 事件 ---------- */
function applyTheme(t) {
  document.documentElement.classList.toggle('light', t === 'light');
  try { localStorage.setItem('bd_theme', t); } catch {}
  const btn = $('#themeToggle');
  if (btn) btn.textContent = t === 'light' ? '深色' : '浅色';
}

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  token = $('#adminToken').value.trim();
  try { sessionStorage.setItem('mc_admin_token', token); } catch {}
  try {
    await api('/api/admin/stats');
    showDash(true);
    switchTab('stats');
    toast('登录成功');
  } catch (err) {
    toast('令牌无效或后端未部署');
    showDash(false);
  }
};
$('#logoutBtn').onclick = () => {
  token = '';
  try { sessionStorage.removeItem('mc_admin_token'); } catch {}
  showDash(false);
};
$$('#adminTabs .chip').forEach(c => c.onclick = () => switchTab(c.dataset.atab));
$('#themeToggle').onclick = () => applyTheme(document.documentElement.classList.contains('light') ? 'dark' : 'light');
if (localStorage.getItem('bd_theme') === 'light') $('#themeToggle').textContent = '深色';

(async function init() {
  if (!token) { showDash(false); return; }
  try { await api('/api/admin/stats'); showDash(true); switchTab('stats'); }
  catch { showDash(false); }
})();

})();
