'use strict';
/* 保龄球馆运营台前端：轮询 /api/state，按七个工作台渲染 */
let STATE = null;
let TAB = 'queue';
let DESK = Number(localStorage.getItem('desk') || 1);

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yuan = (c) => '¥' + (Number(c || 0) / 100).toFixed(2);
const fmtDur = (sec) => {
  if (sec == null) return '--:--';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false }) : '-';

const TABS = [
  ['queue', '候场叫号'],
  ['lanes', '球道平面图'],
  ['control', '开局控制'],
  ['shoes', '球鞋库存'],
  ['uv', '消毒队列'],
  ['fault', '故障换道'],
  ['cash', '结账复核'],
];

async function api(path, method = 'GET', body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.message || `请求失败 ${res.status}`);
  return j.data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

async function act(p, okMsg) {
  try {
    const r = await p;
    if (okMsg) toast(okMsg, 'ok');
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, 'err');
    return null;
  }
}

async function refresh() {
  try {
    STATE = await api('/api/state');
    render();
  } catch (e) { /* 网络抖动时保持旧画面 */ }
}

/* ================= 渲染入口 ================= */

function render() {
  if (!STATE) return;
  $('#tabs').innerHTML = TABS.map(([k, label]) => {
    const badge = k === 'cash' && STATE.reviews.some(r => r.status === 'pending') ? ' ●' : '';
    return `<button class="${TAB === k ? 'active' : ''}" onclick="switchTab('${k}')">${label}${badge}</button>`;
  }).join('');
  $('#deskSwitch').innerHTML = STATE.desks.map(d =>
    `<button class="${DESK === d.id ? 'active' : ''}" onclick="switchDesk(${d.id})">${esc(d.name)}</button>`).join('');
  $('#clock').textContent = new Date(STATE.now).toLocaleTimeString('zh-CN', { hour12: false });
  const fn = { queue: renderQueue, lanes: renderLanes, control: renderControl, shoes: renderShoes, uv: renderUv, fault: renderFault, cash: renderCash }[TAB];
  $('#main').innerHTML = fn();
}

window.switchTab = (t) => { TAB = t; render(); };
window.switchDesk = (d) => { DESK = d; localStorage.setItem('desk', d); render(); };

/* ================= 候场叫号 ================= */

function pkgName(id) { const p = STATE.packages.find(x => x.id === id); return p ? p.name : '?'; }

function renderQueue() {
  const q = STATE.queue;
  const takeForm = `
    <div class="panel">
      <h2>取号 <span class="tag">按人数与护栏需求分配球道</span></h2>
      <div class="form-row">
        <label class="f">姓名<input id="tk-name" placeholder="顾客姓名"></label>
        <label class="f">电话<input id="tk-phone" placeholder="选填" style="width:110px"></label>
        <label class="f">人数<input id="tk-size" type="number" min="1" max="8" value="2" style="width:64px"></label>
        <label class="f">套餐<select id="tk-pkg">${STATE.packages.map(p =>
          `<option value="${p.id}">${esc(p.name)} · ${yuan(p.price_cents)}/人</option>`).join('')}</select></label>
        <label class="f">护栏<select id="tk-bumper"><option value="0">不需要</option><option value="1">需要</option></select></label>
        <button class="btn primary" onclick="A.takeNumber()">取号</button>
      </div>
      <div class="form-row" style="margin-top:8px">
        <button class="btn" onclick="A.callNext()">叫下一位</button>
        <button class="btn" onclick="A.callNextBumper()">叫下一位（护栏道）</button>
        <span class="muted">叫号 ${STATE.config.call_timeout_sec} 秒未开局自动记过号</span>
      </div>
    </div>`;

  const col = (title, list, cls, actions) => `
    <div class="qcol"><h3>${title}（${list.length}）</h3>
      ${list.length ? list.map(g => `
        <div class="qitem ${cls}">
          <div class="qnum">${esc(g.group_no)}</div>
          <div class="qmeta">${esc(g.customer_name)} · ${g.party_size}人 · ${pkgName(g.package_id)}${g.need_bumper ? ' · 护栏' : ''}</div>
          ${g.est_wait_min != null ? `<div class="qwait">预计等待约 ${g.est_wait_min} 分钟</div>` : ''}
          ${g.miss_count ? `<div class="qmeta">已过号 ${g.miss_count} 次</div>` : ''}
          <div class="qactions">${actions(g)}</div>
        </div>`).join('') : '<div class="muted">暂无</div>'}
    </div>`;

  return takeForm + `<div class="queue-board">
    ${col('等待中', q.waiting, '', g => `
      <button class="btn sm primary" onclick="A.call(${g.id})">叫号</button>
      <button class="btn sm" onclick="A.cancel(${g.id})">取消</button>`)}
    ${col('已叫号 · 请到前台开局', q.called, 'called', g => `
      <span class="badge blue flash">待开局</span>
      <button class="btn sm warn" onclick="A.miss(${g.id})">过号</button>`)}
    ${col('已过号', q.missed, 'missed', g => `
      <button class="btn sm primary" onclick="A.requeue(${g.id})">恢复排队</button>
      <button class="btn sm" onclick="A.cancel(${g.id})">取消</button>`)}
    <div class="qcol"><h3>现场事件</h3><div class="events">${renderEvents(18)}</div></div>
  </div>`;
}

/* ================= 球道平面图 ================= */

function pinsSvg() {
  // 瓶体白 10 瓶三角阵
  let c = '';
  const rows = [[4, 42], [3, 30], [2, 18], [1, 6]];
  for (const [n, y] of rows) {
    for (let i = 0; i < n; i++) {
      c += `<circle cx="${8 + i * 12 + (4 - n) * 6}" cy="${y}" r="4.4" fill="#faf7f1" stroke="#cbb894" stroke-width="1"/>`;
    }
  }
  return `<svg width="56" height="48" viewBox="0 0 56 48">${c}</svg>`;
}

function renderLanes() {
  const rows = STATE.lanes.map(l => {
    const sess = STATE.sessions.active.find(s => s.id === l.active_session);
    const cls = l.status === 'fault' ? 'fault' : (l.status === 'occupied' ? 'occupied' : '');
    const statusBadge = {
      idle: '<span class="badge green">空闲</span>',
      occupied: '<span class="badge blue">进行中</span>',
      fault: '<span class="badge red">故障</span>',
      maintenance: '<span class="badge grey">维护</span>',
    }[l.status] || '';
    const scorerBadge = l.scorer === 'interrupted'
      ? `<span class="badge red">计分器中断</span>
         <button class="btn sm" onclick="A.scorerRestore(${l.id})">恢复</button>` : '';
    const faultBtn = l.status === 'fault'
      ? `<button class="btn sm primary" onclick="A.resolveFault(${l.id})">故障已修复</button>`
      : `<button class="btn sm danger" onclick="A.reportFault(${l.id})">报告故障</button>`;
    return `
      <div class="lane-row ${cls} ${l.bumper_capable ? 'bumper' : ''}">
        <div class="lane-no">${l.id}号道</div>
        <div class="lane-bed">
          <span class="arrows">❯❯❯❯❯</span>
          <div class="lane-info">
            ${l.bumper_capable ? '<span class="badge green">护栏</span>' : ''}
            ${sess ? `<span class="badge blue">${esc(sess.group_no)} ${esc(sess.customer_name)}</span>
              <span class="muted">${fmtDur(sess.elapsed_sec)} / 约${Math.round(sess.est_sec / 60)}分</span>` : ''}
            ${l.status === 'fault' ? '<span class="badge red flash">⚠ 故障停用</span>' : ''}
          </div>
        </div>
        <div class="lane-pins">${pinsSvg()}</div>
        <div class="lane-status">${statusBadge}${scorerBadge}${faultBtn}</div>
      </div>`;
  }).join('');

  return `
    <div class="panel">
      <h2>球道平面图 <span class="tag">1-4 号道带护栏 · 并列真实位置</span></h2>
      <div class="lanemap">${rows}</div>
      <div class="legend">
        <span><i style="background:var(--wood)"></i>空闲</span>
        <span><i style="background:#b9cff1"></i>进行中</span>
        <span><i style="background:repeating-linear-gradient(45deg,#e7b6b6 0 4px,#f5e9e9 4px 8px)"></i>故障</span>
        <span><i style="background:var(--arrow-blue)"></i>球道箭头</span>
        <span><i style="background:var(--pin-white);border:1px solid #ccc"></i>瓶体</span>
      </div>
    </div>
    <div class="panel"><h2>现场事件流</h2><div class="events">${renderEvents(40)}</div></div>`;
}

/* ================= 开局控制 ================= */

function renderControl() {
  const called = STATE.queue.called;
  const idleLanes = STATE.lanes.filter(l => l.status === 'idle');
  const sizes = Object.keys(STATE.shoes.matrix).map(Number).sort((a, b) => a - b);
  const sizeOpts = (sz) => sizes.map(s => {
    const avail = STATE.shoes.matrix[s].filter(x => x.status === 'available').length;
    return `<option value="${s}" ${s === sz ? 'selected' : ''} ${avail === 0 ? 'disabled' : ''}>${s}码（余${avail}）</option>`;
  }).join('');
  const ballOpts = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(w => `<option value="${w}">${w}磅</option>`).join('');
  void ballOpts;

  const openForm = `
    <div class="panel">
      <h2>开局 <span class="tag">锁定球道并登记所借球鞋 · 当前前台：${esc((STATE.desks.find(d => d.id === DESK) || {}).name || '')}</span></h2>
      <div class="form-row">
        <label class="f">已叫号组
          <select id="op-group" onchange="A.buildSizeRows()">
            <option value="">请选择</option>
            ${called.map(g => `<option value="${g.id}" data-size="${g.party_size}" data-bumper="${g.need_bumper}">${esc(g.group_no)} · ${esc(g.customer_name)} · ${g.party_size}人${g.need_bumper ? ' · 需护栏' : ''}</option>`).join('')}
          </select></label>
        <label class="f">球道
          <select id="op-lane">${idleLanes.map(l =>
            `<option value="${l.id}">${l.id}号道${l.bumper_capable ? '（护栏）' : ''}</option>`).join('')}</select></label>
        <label class="f">护栏<select id="op-bumper"><option value="0">放下</option><option value="1">升起</option></select></label>
      </div>
      <div id="op-players" style="margin:8px 0"></div>
      <button class="btn primary" onclick="A.openSession()">开局并借鞋</button>
      <span class="muted">每位顾客一行：球鞋尺码 + 用球磅数；缺码会整单拒绝并记录事件</span>
    </div>`;

  const active = STATE.sessions.active.map(s => `
    <div class="session-row">
      <span class="badge blue">${esc(s.group_no)}</span>
      <b>${esc(s.customer_name)}</b>
      <span>${s.lane_name}</span>
      <span class="timer ${s.over_estimate ? 'over' : ''}">${fmtDur(s.elapsed_sec)}${s.over_estimate ? ' 超时' : ''}</span>
      <span class="muted">${esc(s.package_name)} · ${s.players}人 · 已借 ${s.shoes.filter(x => !x.returned_at).map(x => x.shoe_no).join('、') || '无'}</span>
      <button class="btn sm" onclick="A.finish(${s.id})">结束结算</button>
      <button class="btn sm" onclick="A.addPlayer(${s.id})">临时加人</button>
      <button class="btn sm warn" onclick="A.ballStuck(${s.id})">卡球</button>
      <button class="btn sm warn" onclick="A.scorerInterrupt(${s.id}, ${s.lane_id})">计分器中断</button>
      <button class="btn sm" onclick="A.returnShoes(${s.id})">还鞋</button>
    </div>`).join('') || '<div class="muted">暂无进行中场次</div>';

  return openForm + `<div class="panel"><h2>进行中场次（${STATE.sessions.active.length}）</h2>${active}</div>`;
}

/* ================= 球鞋库存 ================= */

function renderShoes() {
  const m = STATE.shoes.matrix;
  const sizes = Object.keys(m).map(Number).sort((a, b) => a - b);
  const maxN = Math.max(...sizes.map(s => m[s].length));
  const c = STATE.shoes.counts;
  const head = `<tr><th>尺码</th>${Array.from({ length: maxN }, (_, i) => `<th>#${i + 1}</th>`).join('')}<th>可用</th></tr>`;
  const rows = sizes.map(s => {
    const short = STATE.shoes.shortage_sizes.includes(s);
    const avail = m[s].filter(x => x.status === 'available').length;
    return `<tr>
      <th class="${short ? 'short' : ''}">${s}码${short ? ' ⚠缺码' : ''}</th>
      ${m[s].map(sh => `<td><span class="shoe-chip ${sh.status}" title="${sh.status}">${esc(sh.shoe_no)}</span></td>`).join('')}
      ${'<td></td>'.repeat(maxN - m[s].length)}
      <td><b class="${avail === 0 ? 'short' : ''}" style="color:${avail ? 'var(--ok)' : 'var(--bad)'}">${avail}</b></td>
    </tr>`;
  }).join('');
  return `
    <div class="panel">
      <h2>球鞋库存矩阵
        <span class="tag">可借 ${c.available || 0} · 租出 ${c.rented || 0} · 待消毒 ${c.pending_disinfection || 0} · 消毒中 ${c.disinfecting || 0} · 损坏 ${c.damaged || 0}</span>
      </h2>
      ${STATE.shoes.shortage_sizes.length ? `<div style="margin-bottom:8px"><span class="badge red">缺码：${STATE.shoes.shortage_sizes.join('、')} 码</span></div>` : ''}
      <div class="matrix-wrap"><table class="matrix">${head}${rows}</table></div>
      <div class="shoe-legend">
        <span><span class="shoe-chip available">可借</span></span>
        <span><span class="shoe-chip rented">租出</span></span>
        <span><span class="shoe-chip pending_disinfection">待消毒</span></span>
        <span><span class="shoe-chip disinfecting">消毒中</span></span>
        <span><span class="shoe-chip damaged">损坏</span></span>
        <span class="muted">归还的球鞋必须完成消毒才能再次借出</span>
      </div>
    </div>`;
}

/* ================= 消毒队列 ================= */

function renderUv() {
  const p = STATE.disinfection.pending;
  const batches = STATE.disinfection.batches;
  return `
    <div class="grid cols-2">
      <div class="panel uv-box">
        <h2>待消毒（${p.length}）</h2>
        <div>${p.length ? p.map(s => `<span class="shoe-chip pending_disinfection" style="margin:2px">${esc(s.shoe_no)}</span>`).join('') : '<span class="muted">暂无待消毒球鞋</span>'}</div>
        <div style="margin-top:10px">
          <button class="btn uv" onclick="A.startUv()" ${p.length ? '' : 'disabled'}>开始消毒批次</button>
        </div>
      </div>
      <div class="panel">
        <h2>消毒批次</h2>
        ${batches.map(b => `
          <div class="batch-line">
            <span class="badge ${b.status === 'running' ? 'purple flash' : 'green'}">${b.status === 'running' ? '消毒中' : '已完成'}</span>
            <b>批次 #${b.id}</b>
            <span class="muted">${esc(b.operator)} · ${fmtTime(b.started_at)}</span>
            <span>${b.items.map(i => `<span class="shoe-chip ${i.status}" style="margin:1px">${esc(i.shoe_no)}</span>`).join('')}</span>
            ${b.status === 'running' ? `<button class="btn sm primary" onclick="A.completeUv(${b.id})">消毒完成</button>` : `<span class="muted">${fmtTime(b.completed_at)}</span>`}
          </div>`).join('') || '<div class="muted">暂无批次</div>'}
      </div>
    </div>`;
}

/* ================= 故障换道 ================= */

function renderFault() {
  const openFaults = STATE.faults.filter(f => f.status === 'open');
  const idleLanes = STATE.lanes.filter(l => l.status === 'idle');
  const laneChip = (lane, cls = '') => `
    <div class="lane-chip ${cls}">${lane.name}<span class="mini-arrows">❯❯❯</span></div>`;

  const swapLines = openFaults.map(f => {
    const lane = STATE.lanes.find(l => l.id === f.lane_id);
    const sess = STATE.sessions.active.find(s => s.id === f.affected_session);
    return `
      <div class="panel" style="border-left:5px solid var(--bad)">
        <h2><span class="badge red">故障</span> ${esc(lane.name)} · ${esc(f.type)} <span class="tag">${esc(f.note || '')} · ${fmtTime(f.started_at)}</span></h2>
        ${sess ? `
          <div class="swap-line">
            ${laneChip(lane, 'fault')}
            <div class="swap-arrow"></div>
            <select id="swap-to-${sess.id}">
              ${idleLanes.filter(l => !STATE.queue.called.find(g => g.id === sess.group_id && g.need_bumper && !l.bumper_capable)).map(l =>
                `<option value="${l.id}">${l.name}${l.bumper_capable ? '（护栏）' : ''}</option>`).join('')}
            </select>
            <button class="btn primary" onclick="A.changeLane(${sess.id})">确认换道</button>
            <span class="muted">受影响订单保留：${esc(sess.group_no)} ${esc(sess.customer_name)}（${sess.players}人）</span>
          </div>` : '<div class="muted">该道暂无进行中场次，故障期间暂停叫号分配。</div>'}
        <div style="margin-top:6px"><button class="btn sm" onclick="A.resolveFault(${lane.id})">故障已修复</button></div>
      </div>`;
  }).join('');

  const manual = `
    <div class="panel">
      <h2>手动换道 <span class="tag">换道不得占用已有时段，目标道必须空闲</span></h2>
      <div class="form-row">
        <label class="f">进行中场次
          <select id="mv-sess">${STATE.sessions.active.map(s =>
            `<option value="${s.id}">${esc(s.group_no)} · ${esc(s.customer_name)} · ${s.lane_name}</option>`).join('')}</select></label>
        <label class="f">目标球道
          <select id="mv-lane">${idleLanes.map(l => `<option value="${l.id}">${l.name}${l.bumper_capable ? '（护栏）' : ''}</option>`).join('')}</select></label>
        <label class="f">原因<input id="mv-reason" placeholder="如：空调直吹"></label>
        <button class="btn primary" onclick="A.changeLaneManual()">换道</button>
      </div>
    </div>`;

  const history = STATE.lane_changes.length ? `
    <div class="panel"><h2>换道记录</h2>
      ${STATE.lane_changes.map(c => `
        <div class="swap-line" style="padding:4px 0">
          ${laneChip({ name: c.from_name }, '')}
          <div class="swap-arrow"></div>
          ${laneChip({ name: c.to_name }, 'target')}
          <span class="muted">场次#${c.session_id} · ${esc(c.reason || '—')} · ${fmtTime(c.changed_at)}</span>
        </div>`).join('')}
    </div>` : '';

  const faultHistory = `
    <div class="panel"><h2>故障记录</h2>
      ${STATE.faults.map(f => `
        <div class="pay-row">
          <span class="badge ${f.status === 'open' ? 'red' : 'green'}">${f.status === 'open' ? '未处理' : '已修复'}</span>
          <b>${esc(f.lane_name)}</b><span>${esc(f.type)}</span>
          <span class="muted">${esc(f.note || '')} · ${fmtTime(f.started_at)}${f.resolved_at ? ' → ' + fmtTime(f.resolved_at) : ''}</span>
        </div>`).join('')}
    </div>`;

  return (swapLines || '<div class="panel"><h2>故障换道</h2><div class="muted">当前没有未处理故障。</div></div>') + manual + history + faultHistory;
}

/* ================= 结账复核 ================= */

function renderCash() {
  const billed = new Set(STATE.payments.filter(p => ['paid', 'pending_review', 'refunded'].includes(p.status)).map(p => p.session_id));
  const unbilled = STATE.sessions.finished.filter(s => !billed.has(s.id));
  const pendingReviews = STATE.reviews.filter(r => r.status === 'pending');

  const checkoutRows = unbilled.map(s => `
    <div class="session-row" style="border-left-color:var(--warn)">
      <span class="badge amber">待结账</span>
      <b>${esc(s.group_no)} ${esc(s.customer_name)}</b>
      <span class="muted">${esc(s.package_name)} · ${s.players}人 · 实际${s.actual_games}局${s.extra_games ? `（超${s.extra_games}局）` : ''}</span>
      <span class="money">${yuan(s.amount_cents)}</span>
      <label class="f">赔付(分)<input id="comp-${s.id}" type="number" min="0" value="0" style="width:90px"></label>
      <label class="f">赔付原因<input id="compr-${s.id}" placeholder="如鞋件损坏" style="width:130px"></label>
      <label class="f"><span>免单</span><input id="free-${s.id}" type="checkbox"></label>
      <button class="btn primary" onclick="A.checkout(${s.id})">结账</button>
      ${s.shoes.some(x => !x.returned_at) ? `<button class="btn sm" onclick="A.returnShoes(${s.id})">先还鞋</button>` : ''}
    </div>`).join('') || '<div class="muted">没有待结账场次</div>';

  const reviewRows = pendingReviews.map(r => `
    <div class="pay-row">
      <span class="badge ${r.kind === 'free' ? 'purple' : 'amber'}">${r.kind === 'free' ? '免单' : '赔付'}</span>
      <b>支付单 #${r.payment_id}</b>
      <span class="money">${yuan(r.amount_cents)}</span>
      <span class="muted">${esc(r.reason || '')} · 前台申请 · ${fmtTime(r.created_at)}</span>
      <button class="btn sm primary" onclick="A.decide(${r.id}, true)">批准</button>
      <button class="btn sm danger" onclick="A.decide(${r.id}, false)">拒绝</button>
    </div>`).join('') || '<div class="muted">没有待复核申请</div>';

  const payRows = STATE.payments.map(p => `
    <div class="pay-row">
      <span class="badge ${{ paid: 'green', pending_review: 'amber', rejected: 'grey', refunded: 'red' }[p.status] || 'grey'}">${{ paid: '已支付', pending_review: '待复核', rejected: '已驳回', refunded: '已退款' }[p.status]}</span>
      <b>#${p.id}</b><span>${esc(p.group_no)}</span>
      <span class="money">${yuan(p.amount_cents)}</span>
      <span class="muted">${esc(p.method)} · ${esc(p.txn_id || '—')} · ${fmtTime(p.paid_at)}</span>
      ${p.status === 'refunded' ? `<span class="muted">退 ${yuan(p.refund_amount_cents)} · ${esc(p.refund_id)}</span>` : ''}
      ${p.status === 'paid' ? `<button class="btn sm warn" onclick="A.refund(${p.id})">退款</button>` : ''}
    </div>`).join('') || '<div class="muted">暂无支付单</div>';

  return `
    <div class="grid cols-2">
      <div>
        <div class="panel"><h2>待结账（${unbilled.length}）</h2>${checkoutRows}
          <div class="muted" style="margin-top:6px">按实际局数结算；填写赔付或勾选免单后需值班经理复核。</div>
        </div>
        <div class="panel"><h2>复核台 <span class="tag">赔付 / 免单需值班经理复核</span></h2>${reviewRows}</div>
      </div>
      <div class="panel"><h2>支付单（幂等）</h2>${payRows}
        <div class="muted" style="margin-top:6px">结账与退款均使用幂等键，重复提交不会重复扣款或重复退款。</div>
      </div>
    </div>`;
}

/* ================= 事件流 ================= */

const EVENT_LABEL = {
  take_number: '取号', call: '叫号', miss: '过号', requeue: '过号恢复', cancel: '取消',
  session_open: '开局', session_finish: '结束', add_player: '临时加人', size_shortage: '球鞋缺码',
  ball_stuck: '卡球', scorer_interrupt: '计分器中断', lane_change: '换道', extra_game: '超局',
  shoe_damage: '鞋件损坏', fault: '设备故障', fault_resolved: '故障修复',
  checkout: '结账', refund: '退款', review: '复核',
  disinfection_start: '消毒开始', disinfection_done: '消毒完成',
};
const EVENT_BADGE = {
  miss: 'red', size_shortage: 'red', shoe_damage: 'red', fault: 'red', ball_stuck: 'amber',
  scorer_interrupt: 'amber', extra_game: 'amber', lane_change: 'blue', session_open: 'blue',
  checkout: 'green', refund: 'red', review: 'purple', disinfection_start: 'purple', disinfection_done: 'green',
};

function renderEvents(limit) {
  const list = STATE.events.slice(0, limit);
  if (!list.length) return '<div class="muted">暂无事件</div>';
  return list.map(e => {
    const p = e.payload || {};
    const detail = Object.entries(p)
      .filter(([k]) => !['photo'].includes(k))
      .map(([k, v]) => `${Array.isArray(v) ? v.join('/') : v}`).join(' · ');
    return `<div class="event-line">
      <time>${fmtTime(e.created_at)}</time>
      <span class="badge ${EVENT_BADGE[e.type] || 'grey'}">${EVENT_LABEL[e.type] || e.type}</span>
      <span>${esc(detail)}</span>
      ${p.photo ? `<img src="/${esc(p.photo)}" alt="损坏照片">` : ''}
    </div>`;
  }).join('');
}

/* ================= 动作 ================= */

window.A = {
  takeNumber() {
    act(api('/api/queue', 'POST', {
      customer_name: $('#tk-name').value.trim(), phone: $('#tk-phone').value.trim(),
      party_size: +$('#tk-size').value, need_bumper: +$('#tk-bumper').value,
      package_id: +$('#tk-pkg').value, desk_id: DESK,
    }), '取号成功');
  },
  callNext() { act(api('/api/queue/call-next', 'POST', { desk_id: DESK })); },
  callNextBumper() { act(api('/api/queue/call-next', 'POST', { desk_id: DESK, need_bumper: 1 })); },
  call(id) { act(api(`/api/queue/${id}/call`, 'POST', { desk_id: DESK })); },
  miss(id) { act(api(`/api/queue/${id}/miss`, 'POST', { desk_id: DESK })); },
  requeue(id) { act(api(`/api/queue/${id}/requeue`, 'POST', { desk_id: DESK })); },
  cancel(id) { act(api(`/api/queue/${id}/cancel`, 'POST', { desk_id: DESK })); },

  buildSizeRows() {
    const sel = $('#op-group');
    const opt = sel.options[sel.selectedIndex];
    const n = opt && opt.dataset.size ? +opt.dataset.size : 0;
    const box = $('#op-players');
    if (!n) { box.innerHTML = ''; return; }
    const sizes = Object.keys(STATE.shoes.matrix).map(Number).sort((a, b) => a - b);
    box.innerHTML = Array.from({ length: n }, (_, i) => `
      <div class="size-pick" style="margin-bottom:4px">
        <span class="muted">顾客${i + 1}</span>
        <select class="op-size">${sizes.map(s => {
          const avail = STATE.shoes.matrix[s].filter(x => x.status === 'available').length;
          return `<option value="${s}" ${avail === 0 ? 'disabled' : ''}>${s}码（余${avail}）</option>`;
        }).join('')}</select>
        <select class="op-ball">${[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].map(w => `<option value="${w}" ${w === 10 ? 'selected' : ''}>${w}磅</option>`).join('')}</select>
      </div>`).join('');
  },
  openSession() {
    const gid = +$('#op-group').value;
    if (!gid) return toast('请选择已叫号组', 'err');
    act(api('/api/sessions', 'POST', {
      group_id: gid, lane_id: +$('#op-lane').value, desk_id: DESK,
      shoe_sizes: [...document.querySelectorAll('.op-size')].map(x => +x.value),
      ball_weights: [...document.querySelectorAll('.op-ball')].map(x => +x.value),
      bumper_used: +$('#op-bumper').value,
    }), '开局成功，球道已锁定');
  },
  finish(id) {
    const s = STATE.sessions.active.find(x => x.id === id);
    const v = prompt(`实际局数（套餐 ${s.planned_games} 局）：`, String(s.planned_games));
    if (v == null) return;
    act(api(`/api/sessions/${id}/finish`, 'POST', { actual_games: +v, desk_id: DESK }), '已结束，按实际局数结算');
  },
  addPlayer(id) {
    const v = prompt('加几位？', '1');
    if (v == null || !(+v > 0)) return;
    const sizes = [];
    for (let i = 0; i < +v; i++) {
      const sz = prompt(`第 ${i + 1} 位球鞋尺码：`, '40');
      if (sz == null) return;
      sizes.push(+sz);
    }
    act(api(`/api/sessions/${id}/add-player`, 'POST', { count: +v, shoe_sizes: sizes, desk_id: DESK }), '已加人并借鞋');
  },
  ballStuck(id) { act(api(`/api/sessions/${id}/event`, 'POST', { type: 'ball_stuck', payload: {}, desk_id: DESK }), '已记录卡球'); },
  scorerInterrupt(id, laneId) {
    act(api(`/api/scorer/${laneId}/interrupt`, 'POST', { session_id: id, desk_id: DESK }), '已记录计分器中断');
  },
  scorerRestore(laneId) { act(api(`/api/scorer/${laneId}/restore`, 'POST', {}), '计分器已恢复'); },

  async returnShoes(sessionId) {
    const s = STATE.sessions.active.find(x => x.id === sessionId) || STATE.sessions.finished.find(x => x.id === sessionId);
    const unreturned = s.shoes.filter(x => !x.returned_at);
    const items = [];
    for (const sh of unreturned) {
      const dmg = confirm(`球鞋 ${sh.shoe_no}（${sh.size}码）是否损坏？\n确定=损坏 取消=正常归还`);
      let photo = null, note = '';
      if (dmg) {
        note = prompt('损坏说明：', '鞋面破损') || '';
        photo = await pickPhoto();
      }
      items.push({ shoe_id: sh.shoe_id, damaged: dmg, note, photo_b64: photo });
    }
    act(api(`/api/sessions/${sessionId}/return-shoes`, 'POST', { items, desk_id: DESK }), '球鞋已归还，进入待消毒');
  },

  reportFault(laneId) {
    const type = prompt('故障类型（pin_jam 卡瓶 / ball_return 回球 / scorer_down 计分器 / other）：', 'pin_jam');
    if (type == null) return;
    const note = prompt('故障说明：', '') || '';
    act(api(`/api/lanes/${laneId}/fault`, 'POST', { type, note, desk_id: DESK }), '故障已登记，该道暂停叫号');
  },
  resolveFault(laneId) { act(api(`/api/lanes/${laneId}/resolve`, 'POST', { desk_id: DESK }), '故障已修复'); },

  changeLane(sessionId) {
    const to = +$(`#swap-to-${sessionId}`).value;
    act(api(`/api/sessions/${sessionId}/change-lane`, 'POST', { to_lane_id: to, reason: '设备故障', desk_id: DESK }), '换道完成');
  },
  changeLaneManual() {
    const sid = +$('#mv-sess').value;
    if (!sid) return toast('没有进行中场次', 'err');
    act(api(`/api/sessions/${sid}/change-lane`, 'POST', {
      to_lane_id: +$('#mv-lane').value, reason: $('#mv-reason').value, desk_id: DESK,
    }), '换道完成');
  },

  startUv() { act(api('/api/disinfection/start', 'POST', { operator: '消毒员' }), '消毒批次已开始'); },
  completeUv(id) { act(api(`/api/disinfection/${id}/complete`, 'POST', {}), '消毒完成，球鞋可再次借出'); },

  checkout(sessionId) {
    const comp = +$(`#comp-${sessionId}`).value || 0;
    const free = $(`#free-${sessionId}`).checked;
    const compReason = $(`#compr-${sessionId}`).value;
    let freeReason = '';
    if (free) {
      freeReason = prompt('免单原因（需经理复核）：', '设备故障补偿') || '';
      if (!freeReason) return toast('免单需填写原因', 'err');
    }
    act(api(`/api/sessions/${sessionId}/checkout`, 'POST', {
      desk_id: DESK, method: 'cash',
      idempotency_key: `POS-${sessionId}-${Date.now()}`,
      comp_cents: comp, comp_reason: compReason, free, free_reason: freeReason,
    }), free || comp > 0 ? '已提交，待值班经理复核' : '结账完成');
  },
  decide(reviewId, approve) {
    const manager = approve ? (prompt('值班经理姓名：', '王经理') || '') : (prompt('驳回人（值班经理）：', '王经理') || '');
    if (!manager) return;
    act(api(`/api/reviews/${reviewId}/decide`, 'POST', { manager, approve }), approve ? '已批准' : '已驳回');
  },
  refund(paymentId) {
    if (!confirm(`确认对支付单 #${paymentId} 全额退款？`)) return;
    act(api(`/api/payments/${paymentId}/refund`, 'POST', {
      idempotency_key: `REFUND-${paymentId}`,
    }), '退款成功');
  },
};

function pickPhoto() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = () => {
      const f = inp.files[0];
      if (!f) return resolve(null);
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result);
      rd.readAsDataURL(f);
    };
    inp.click();
    // 用户取消选择时按无照片继续
    setTimeout(() => resolve(null), 60000);
  });
}

/* ================= 启动 ================= */

refresh();
setInterval(refresh, 3000);
