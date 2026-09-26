/* 星瓶保龄球馆 前端逻辑 */
let STATE = null;
let DESK = "前台1";
let switchCtx = null;      // {session_id, fromLaneId}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const yuan = c => (c / 100).toFixed(2);
const fmtETA = s => s >= 60 ? `约 ${Math.round(s / 60)} 分钟` : `${s} 秒`;
const hms = sec => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:` +
  `${String(Math.floor(sec % 3600 / 60)).padStart(2, "0")}:` +
  `${String(Math.floor(sec % 60)).padStart(2, "0")}`;

async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ desk: DESK, ...body }),
  });
  const j = await res.json();
  if (!res.ok || j.ok === false) throw new Error(j.error || "请求失败");
  return j.data;
}

async function act(path, body = {}) {
  try { await api(path, body); await refresh(); }
  catch (e) { toast(e.message, true); }
}

function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (err ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ------------------------------------------------------------- modal */
function modal(title, html, onOk) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").classList.remove("hidden");
  $("#modal-ok").onclick = async () => {
    try {
      const r = await onOk();
      if (r !== false) { $("#modal").classList.add("hidden"); await refresh(); }
    } catch (e) { toast(e.message, true); }
  };
}
$("#modal-cancel").onclick = () => $("#modal").classList.add("hidden");

/* ------------------------------------------------------------- render */
function render() {
  if (!STATE) return;
  $("#clock").textContent = STATE.now.slice(11, 19);
  renderCallboard();
  renderFloor();
  renderSessions();
  renderShoeMatrix();
  renderBatches();
  renderBills();
  renderEvents();
}

function renderCallboard() {
  const el = $("#callboard");
  const ps = STATE.parties;
  if (!ps.length) { el.innerHTML = `<span class="sub" style="color:#8c7a5c;font-size:13px">暂无候场组</span>`; return; }
  el.innerHTML = ps.map((p, i) => {
    const cls = p.status === "called" ? "called" : p.status === "no_show" ? "no_show"
      : (i === 0 && p.status === "waiting" ? "queue-front" : "");
    const bumper = p.bumper ? `<span class="bumper-tag">护栏</span>` : "";
    const sizes = p.shoe_sizes.join("/");
    let actions = "";
    if (p.status === "waiting") {
      actions = `<button class="btn mini" onclick="addPerson(${p.id})">加人</button>
                 <button class="btn mini ghost" onclick="act('/api/parties/${p.id}/noshow')">置过号</button>`;
    } else if (p.status === "called") {
      actions = `<button class="btn mini primary" onclick="startSession(${p.id})">开局</button>
                 <button class="btn mini danger" onclick="act('/api/parties/${p.id}/noshow')">过号</button>`;
    } else if (p.status === "no_show") {
      actions = `<button class="btn mini" style="background:#fff" onclick="act('/api/parties/${p.id}/restore')">恢复队首</button>`;
    }
    const etaTxt = p.status === "called" ? "请前往前台确认"
      : p.status === "no_show" ? `过号 · ${p.restore_at ? p.restore_at.slice(11, 16) + " 前可恢复" : ""}`
      : `预计等待 ${fmtETA(p.eta_seconds)}`;
    return `<div class="call-chip ${cls}">
      <div class="gno">${p.group_no}${bumper}</div>
      <div class="meta">${p.customer_name} · ${p.size}人<br>鞋码 ${sizes}</div>
      <div class="eta">${etaTxt}</div>
      <div class="row-actions">${actions}</div>
    </div>`;
  }).join("");
}

function renderFloor() {
  const el = $("#floor");
  const rows = {};
  STATE.lanes.forEach(l => (rows[l.row_no] ??= []).push(l));
  el.innerHTML = Object.keys(rows).sort().map(rn => {
    const lanes = rows[rn];
    const cells = lanes.map(l => laneCell(l)).join("");
    let banner = "";
    if (switchCtx && switchCtx.row === Number(rn)) {
      const from = STATE.lanes.find(x => x.id === switchCtx.fromLaneId);
      banner = `<div class="switch-banner">
        <span>换道（同水平排）：</span>
        <span class="seg bad">${from.code}（故障/原道）</span>
        <span>➜</span><span><b>选择右侧空闲道</b>（已有时段的球道不可点）</span>
        <button class="btn mini" style="margin-left:auto" onclick="cancelSwitch()">取消换道</button>
      </div>`;
    }
    return `<div class="lane-row" style="--n:${lanes.length}">
      <div class="row-label">${Number(rn) === 1 ? "前排" : "后排"}</div>
      ${cells}${banner}
    </div>`;
  }).join("");
}

function laneCell(l) {
  let cls = "lane";
  if (l.needs_repair) cls += " fault";
  else if (l.active_session_id) cls += " busy";
  else cls += " free";
  if (!l.has_bumper) cls += " no-bumper";
  let tag = "";
  let click = "";
  if (l.needs_repair) {
    tag = `<div class="party-tag" style="color:var(--fault)">⚠ ${l.repair_reason || "设备故障"}</div>`;
    click = `onclick="laneMenu(${l.id})"`;
  } else if (l.active_session_id) {
    const p = l.party || {};
    tag = `<div class="party-tag">${p.group_no || ""} ${p.customer_name || ""} · ${p.size || ""}人${p.bumper ? " 🛡" : ""}</div>`;
    click = `onclick="sessionOfLane(${l.active_session_id})"`;
  } else {
    click = `onclick="freeLaneClick(${l.id})"`;
    tag = `<div class="party-tag" style="color:#5d4a2c">空闲 · ${l.capacity}人</div>`;
  }
  return `<button class="${cls}" ${click} title="${l.code} 容量${l.capacity}">
    <span class="code">${l.code}</span>
    <span class="arrow-mark">▲</span>
    <span class="cap">${l.capacity}人</span>
    ${tag}
  </button>`;
}

function renderSessions() {
  const el = $("#sessions");
  if (!STATE.sessions.length) {
    el.innerHTML = `<span class="sub" style="color:#8c7a5c;font-size:13px">当前无进行中场次</span>`;
    return;
  }
  el.innerHTML = STATE.sessions.map(s => {
    const over = s.actual_games > s.planned_games;
    const loans = (s.loans || []).map(ln =>
      `<span class="tag ${ln.status !== "loaned" ? "ret" : ""}"
         title="点击归还 ${ln.code}" onclick="returnShoe(${ln.id})">${ln.code}${ln.status === "loaned" ? "" : " ✓"}</span>`
    ).join("");
    return `<div class="srow ${s.timed_out ? "outage" : ""}">
      <div class="g">${s.group_no}</div>
      <div class="who">${s.customer_name}<br><small>${s.lane_code} · 套餐${s.planned_games}局</small></div>
      <div class="timer">⏱ ${hms(s.elapsed)}</div>
      <div class="games">
        ${s.timed_out
          ? `<span style="color:var(--fault);font-weight:700">计分器中断</span>
             <button class="btn mini" onclick="recoverScorer(${s.id})">恢复并补录</button>`
          : `局数 <input type="number" step="0.5" min="0" value="${s.actual_games}" id="g-${s.id}">
             <button class="btn mini" onclick="pushGames(${s.id})">同步计分器</button>`}
      </div>
      <div class="shoe-loans">球鞋 ${loans || "<i>无</i>"}</div>
      <div class="ops">
        <button class="btn mini" onclick="ballStuck(${s.id})">卡球</button>
        <button class="btn mini" onclick="breakOutage(${s.id})">计分器中断</button>
        <button class="btn mini" onclick="beginSwitch(${s.id},${s.lane_id})">换道</button>
        <button class="btn mini danger" onclick="endSession(${s.id})">结束结账</button>
      </div>
      ${over ? `<div style="width:100%"><span class="over">超局：实际 ${s.actual_games} > ${s.planned_games}，按实际局数计费</span></div>` : ""}
    </div>`;
  }).join("");
}

function renderShoeMatrix() {
  const total = STATE.shoe_matrix.reduce((a, m) => a + m.total, 0);
  const stock = STATE.shoe_matrix.reduce((a, m) => a + m.in_stock, 0);
  $("#shoe-summary").textContent = `共 ${total} 双 · 可借 ${stock} 双（点击圆点看编号）`;
  $("#shoe-matrix").innerHTML = STATE.shoe_matrix.map(m => {
    const zero = m.in_stock === 0 ? "zero" : "";
    const dots = [];
    for (let i = 0; i < m.total; i++) {
      const it = m.items[i];
      dots.push(`<span class="dot ${it.status}" title="${it.code} · ${statusText(it.status)}"></span>`);
    }
    return `<div class="scell ${zero}">
      <div class="sz">${m.size}</div>
      <div class="dots">${dots.join("")}</div>
      <div class="cnt">可借 ${m.in_stock}/${m.total} · 消${m.sanitizing} · 修${m.repair}</div>
    </div>`;
  }).join("");
}

function statusText(s) {
  return { in_stock: "在库可借", on_loan: "借出中", sanitizing: "待消毒", repair: "维修/损坏" }[s] || s;
}

function renderBatches() {
  const el = $("#batches");
  const pending = STATE.batches.filter(b => b.status === "pending");
  const list = STATE.batches.length ? STATE.batches : [];
  if (!list.length) { el.innerHTML = `<span class="sub" style="color:#8c7a5c;font-size:13px">暂无消毒批次</span>`; return; }
  el.innerHTML = list.map(b => `
    <div class="batch ${b.status}">
      <div class="bh">
        <span class="bid">批次 #${b.id}</span>
        <span>${b.status === "pending" ? "待消毒 / 消毒中" : "已完成"}</span>
        <span style="color:#8c7a5c">${b.items.length} 双</span>
        <span style="margin-left:auto;color:#8c7a5c;font-size:11px">${(b.finished_at || b.created_at).slice(5, 16).replace("T", " ")}</span>
        ${b.status === "pending"
          ? `<button class="btn mini primary" onclick="act('/api/batches/${b.id}/finish',{operator:'值班员'})">消毒完成</button>` : ""}
      </div>
      <div class="items">${b.items.map(i => `<span class="tag">${i.code} (${i.size_eu})</span>`).join("")}</div>
    </div>`).join("");
}

function renderBills() {
  const el = $("#bills");
  if (!STATE.bills.length) {
    el.innerHTML = `<span class="sub" style="color:#8c7a5c;font-size:13px">暂无账单</span>`;
    return;
  }
  el.innerHTML = STATE.bills.map(b => {
    const st = b.status;
    const adjs = (b.adjustments || []).filter(a => a.amount_cents > 0 || a.kind === "compensation")
      .map(a => `<span class="a ${a.kind}">${adjLabel(a.kind)} ${yuan(a.amount_cents)} · ${a.reviewer}</span>`).join("");
    return `<div class="bill ${st}">
      <div class="bhead">
        <span class="g">${b.group_no}</span>
        <span>${b.customer_name} · ${b.lane_code}</span>
        <span class="status-pill ${st}">${{ draft: "待结账", paid: "已付款", refunded: "已退款", refunding: "退款中" }[st] || st}</span>
        ${b.payment_ref ? `<small style="color:#8c7a5c">${b.payment_ref}${b.refund_ref ? " / " + b.refund_ref : ""}</small>` : ""}
        <div class="amounts"><div class="total">¥${yuan(b.total_cents)}</div></div>
      </div>
      <div class="lines">
        <span>球道局费 ¥${yuan(b.lane_fee_cents)}</span>
        <span>球鞋 ¥${yuan(b.shoe_fee_cents)}</span>
        ${b.surcharge_cents ? `<span>超局加收 ¥${yuan(b.surcharge_cents)}</span>` : ""}
        ${b.discount_cents ? `<span>免单 -¥${yuan(b.discount_cents)}</span>` : ""}
        ${b.compensation_cents ? `<span>赔付 -¥${yuan(b.compensation_cents)}</span>` : ""}
      </div>
      ${adjs ? `<div class="adj">${adjs}</div>` : ""}
      <div class="bops">
        ${st === "draft" ? `<button class="btn mini primary" onclick="act('/api/bills/${b.id}/pay')">收款</button>
          <button class="btn mini" onclick="adjustBill(${b.id},'comp')">免单</button>
          <button class="btn mini" onclick="adjustBill(${b.id},'compensation')">赔付</button>
          <button class="btn mini" onclick="adjustBill(${b.id},'damage')">鞋损加收</button>` : ""}
        ${st === "paid" ? `<button class="btn mini danger" onclick="refundBill(${b.id})">退款（幂等）</button>` : ""}
        ${st === "refunded" ? `<button class="btn mini" onclick="refundBill(${b.id})">再次退款（返回同一流水）</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

function adjLabel(k) {
  return { comp: "免单", compensation: "赔付", damage: "鞋损", surcharge: "加收" }[k] || k;
}

function renderEvents() {
  const label = {
    enqueue: "入队", call: "叫号", no_show: "过号", restore: "过号恢复",
    add_person: "临时加人", shoe_shortage: "球鞋缺码", start: "开局",
    over_game: "超局", scorer_outage: "计分器中断", scorer_recover: "计分器恢复",
    ball_stuck: "卡球", ball_freed: "卡球排除", lane_fault: "设备故障",
    repair_done: "修复", switch: "换道", shoe_damage: "鞋件损坏",
    sanitize: "消毒完成", end: "结束", pay: "收款", refund: "退款",
  };
  $("#events").innerHTML = STATE.events.map(e => `
    <li><span class="t">${e.created_at.slice(5, 19).replace("T", " ")}</span>
    <span class="k k-${e.kind}">${label[e.kind] || e.kind}</span>
    <span>${e.detail}</span></li>`).join("");
}

/* ------------------------------------------------------------- actions */
function startSession(pid) {
  const pkgs = STATE.packages.map(p =>
    `<option value="${p.id}">${p.name}（${p.games}局 ¥${yuan(p.price_cents)}）</option>`).join("");
  modal("开局 · 选择局数套餐", `
    <label>局数套餐</label><select id="m-pkg">${pkgs}</select>
    <p style="font-size:12px;color:#8c7a5c;margin-top:10px">开局将锁定球道并登记所借球鞋；若球鞋缺码将阻止开局。</p>`,
    async () => {
      await api("/api/sessions/start", { party_id: pid, package_id: Number($("#m-pkg").value) });
    });
}

function addPerson(pid) {
  modal("临时加人", `
    <label>增加人数</label><input id="m-add" type="number" min="1" value="1">
    <label>新增尺码（逗号分隔，可留空默认42）</label><input id="m-sizes" placeholder="如 40,43">`,
    async () => {
      const sizes = $("#m-sizes").value.split(",").map(s => Number(s.trim())).filter(Boolean);
      await api(`/api/parties/${pid}/add`, { add: Number($("#m-add").value), shoe_sizes: sizes });
    });
}

function pushGames(sid) {
  act(`/api/sessions/${sid}/games`, { games: Number($(`#g-${sid}`).value) });
}
function breakOutage(sid) { act(`/api/sessions/${sid}/outage`); }
function recoverScorer(sid) {
  modal("计分器恢复 · 补录实际局数",
    `<label>当前已打局数</label><input id="m-g" type="number" step="0.5" value="1">`,
    async () => { await api(`/api/sessions/${sid}/recover`, { games: Number($("#m-g").value) }); });
}
function ballStuck(sid) {
  modal("卡球登记", `
    <label>相关球（可选）</label>
    <select id="m-ball"><option value="">不指定</option>
      ${STATE.balls.map(b => `<option value="${b.id}">${b.code} · ${b.weight_lb}磅</option>`).join("")}
    </select>
    <label>说明</label><input id="m-note" value="回球机卡球">`,
    async () => { await api(`/api/sessions/${sid}/ball-stuck`,
      { ball_id: Number($("#m-ball").value) || null, note: $("#m-note").value }); });
}
function endSession(sid) {
  if (!confirm("确认结束该场次并生成账单（按实际局数结算）？")) return;
  act(`/api/sessions/${sid}/end`);
}

/* ---------- 故障 / 换道：沿同一水平排显示前后位置 ---------- */
function beginSwitch(sid, fromLaneId) {
  const lane = STATE.lanes.find(l => l.id === fromLaneId);
  switchCtx = { session_id: sid, fromLaneId, row: lane.row_no };
  renderFloor();
  toast("请在同一水平排选择目标球道（点击空闲道）");
}
function cancelSwitch() { switchCtx = null; renderFloor(); }

function freeLaneClick(laneId) {
  if (switchCtx) {
    act(`/api/sessions/${switchCtx.session_id}/switch`, { lane_id: laneId, reason: "fault" })
      .finally(() => { switchCtx = null; });
    return;
  }
  // free lane click without context: hint
  toast("空闲球道：先叫号并开局，或在进行中场次上点「换道」");
}

function laneMenu(laneId) {
  const l = STATE.lanes.find(x => x.id === laneId);
  if (l.needs_repair) {
    if (confirm(`球道 ${l.code}：${l.repair_reason || "故障"}\n确定已修复并恢复叫号？`)) {
      act(`/api/lanes/${laneId}/repair`);
    }
  } else {
    modal(`球道 ${l.code} · 设备故障登记`,
      `<label>故障原因（该道暂停叫号，进行中订单保留可换道）</label>
       <input id="m-reason" value="回球机故障">`,
      async () => { await api(`/api/lanes/${laneId}/fault`, { reason: $("#m-reason").value }); });
  }
}

function sessionOfLane(sid) {
  const el = $(`#g-${sid}`);
  if (el) el.closest(".srow").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ---------- 球鞋归还 / 损坏照片 ---------- */
function returnShoe(loanId) {
  modal("归还球鞋", `
    <label style="display:flex;gap:6px;align-items:center">
      <input type="checkbox" id="m-damaged" style="width:auto"> 鞋件损坏（进入维修，不上消毒架）</label>
    <div id="damaged-fields" class="hidden">
      <label>损坏照片（存入本地 data/photos）</label>
      <input type="file" id="m-photo" accept="image/*">
      <label>损坏说明</label><textarea id="m-dnote" rows="2">鞋帮撕裂</textarea>
    </div>
    <p style="font-size:12px;color:#8c7a5c;margin-top:10px">完好归还后立即进入待消毒批次，消毒完成才可再次借出。</p>`,
    async () => {
      const damaged = $("#m-damaged").checked;
      if (!damaged) { await api(`/api/loans/${loanId}/return`, { damaged: false }); return; }
      const file = $("#m-photo").files[0];
      let photo = null;
      if (file) photo = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.readAsDataURL(file);
      });
      await api(`/api/loans/${loanId}/return`,
        { damaged: true, photo, note: $("#m-dnote").value });
    });
  $("#m-damaged").onchange = e =>
    $("#damaged-fields").classList.toggle("hidden", !e.target.checked);
}

/* ---------- 结账复核 ---------- */
function managerField() {
  return `<label>值班经理工号（复核必填）</label><input id="m-manager" value="M01" placeholder="如 M01">
    <label>原因</label><input id="m-reason" value="">`;
}
function adjustBill(id, kind) {
  const title = { comp: "免单复核", compensation: "故障赔付复核", damage: "鞋损加收" }[kind];
  modal(title, `${managerField()}
    <label>金额（元）</label><input id="m-amount" type="number" step="0.01" value="0">`,
    async () => {
      if (!$("#m-manager").value.trim()) { toast("必须由值班经理复核", true); return false; }
      await api(`/api/bills/${id}/adjust`, {
        kind, amount: Math.round(Number($("#m-amount").value) * 100),
        reason: $("#m-reason").value, manager: $("#m-manager").value.trim() });
    });
}
function refundBill(id) {
  modal("退款复核（重复提交幂等）", `${managerField()}`,
    async () => {
      if (!$("#m-manager").value.trim()) { toast("必须由值班经理复核", true); return false; }
      const r = await api(`/api/bills/${id}/refund`,
        { manager: $("#m-manager").value.trim(), reason: $("#m-reason").value });
      if (r && r.refund_ref) toast(`退款流水 ${r.refund_ref}`);
    });
}

/* ------------------------------------------------------------- bootstrap */
$("#desk1").onclick = () => setDesk("前台1");
$("#desk2").onclick = () => setDesk("前台2");
function setDesk(d) {
  DESK = d;
  $$(".desk-btn").forEach(b => b.classList.toggle("active", b.dataset.desk === d));
}
$("#enqueue-form").onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const sizes = f.shoe_sizes.value.split(",").map(s => Number(s.trim())).filter(Boolean);
  try {
    await api("/api/enqueue", {
      customer_name: f.customer_name.value, size: Number(f.size.value),
      bumper: f.bumper.checked, shoe_sizes: sizes,
    });
    f.reset(); f.size.value = 2;
    await refresh();
  } catch (err) { toast(err.message, true); }
};
$("#call-btn").onclick = async () => {
  try {
    const r = await api("/api/call", {});
    if (r && r.party) toast(`叫号 ${r.party.group_no} → ${r.lane.code}`);
    else toast(r.message || "暂无可叫号组");
    STATE = null;
    await refresh();
  } catch (e) { toast(e.message, true); }
};

async function demo(name) {
  try {
    const r = await api(`/api/demo/${name}`, {});
    toast("样例已载入：" + (r.hint || r.second_blocked_reason ||
      `新增 ${r.count || 1} 项，见候场屏`));
    await refresh();
  } catch (e) { toast(e.message, true); }
}

async function refresh() {
  const res = await fetch("/api/state");
  STATE = await res.json();
  render();
}
refresh();
setInterval(refresh, 4000);
