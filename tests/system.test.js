'use strict';
// 集成测试：双锁、过号恢复、消毒阻断、换道计费、退款幂等、复核流程。
// 运行：npm test  或  node --test tests/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

let app, base;

async function api(path, method = 'GET', body = null) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null,
  });
  const j = await res.json();
  return { status: res.status, body: j };
}

// 快捷流程：取号 → 叫号
async function takeAndCall(name, size, pkg, bumper = 0) {
  const t = await api('/api/queue', 'POST', { customer_name: name, party_size: size, package_id: pkg, need_bumper: bumper, desk_id: 1 });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const gid = t.body.data.id;
  const c = await api(`/api/queue/${gid}/call`, 'POST', { desk_id: 1 });
  assert.equal(c.status, 200);
  return gid;
}

// 找一条当前空闲球道（测试间共享应用，避免占用冲突）
async function idleLaneId() {
  const st = await api('/api/state');
  const lane = st.body.data.lanes.find(l => l.status === 'idle');
  assert.ok(lane, '需要至少一条空闲球道');
  return lane.id;
}

before(async () => {
  app = createApp({ dbPath: ':memory:', taskIntervalMs: 60_000 });
  await new Promise(r => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => {
  app.tasks.stop();
  app.server.close();
});

test('双锁：两个前台不能同时开同一球道', async () => {
  const g1 = await takeAndCall('双人锁甲', 2, 1);
  const g2 = await takeAndCall('双人锁乙', 2, 1);
  // 两个前台同时请求同一球道
  const [r1, r2] = await Promise.all([
    api('/api/sessions', 'POST', { group_id: g1, lane_id: 1, desk_id: 1, shoe_sizes: [36, 37] }),
    api('/api/sessions', 'POST', { group_id: g2, lane_id: 1, desk_id: 2, shoe_sizes: [38, 39] }),
  ]);
  const oks = [r1, r2].filter(r => r.status === 200);
  const conflicts = [r1, r2].filter(r => r.status === 409);
  assert.equal(oks.length, 1, '恰有一个前台开局成功');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].body.error, 'LANE_BUSY');
  // 球道只被占用一次
  const st = await api('/api/state');
  const lane1 = st.body.data.lanes.find(l => l.id === 1);
  assert.equal(lane1.status, 'occupied');
});

test('双锁：两个前台不能借到同一双鞋（最后一双 46 码）', async () => {
  // 清场：把 46 码占用到只剩一双
  app.db.prepare("UPDATE shoes SET status='rented' WHERE size=46 AND shoe_no<>'B46-1'").run();
  const g1 = await takeAndCall('抢鞋甲', 1, 1);
  const g2 = await takeAndCall('抢鞋乙', 1, 1);
  const [r1, r2] = await Promise.all([
    api('/api/sessions', 'POST', { group_id: g1, lane_id: 2, desk_id: 1, shoe_sizes: [46] }),
    api('/api/sessions', 'POST', { group_id: g2, lane_id: 3, desk_id: 2, shoe_sizes: [46] }),
  ]);
  const oks = [r1, r2].filter(r => r.status === 200);
  const fails = [r1, r2].filter(r => r.status === 409);
  assert.equal(oks.length, 1, '只有一人借到最后一双 46 码');
  assert.equal(fails.length, 1);
  assert.equal(fails[0].body.error, 'SIZE_SHORTAGE');
  // 缺码事件已记录
  const st = await api('/api/state');
  assert.ok(st.body.data.events.some(e => e.type === 'size_shortage'));
  // 还原 46 码库存
  app.db.prepare("UPDATE shoes SET status='available' WHERE size=46 AND status='rented' AND shoe_no<>'B46-1'").run();
});

test('过号：叫号超时自动过号，恢复后优先再叫', async () => {
  const gid = await takeAndCall('过号顾客', 2, 1);
  // 时间快进到超时之后，由进程内任务扫描
  const missed = app.services.sweepMissed(new Date(Date.now() + 120_000));
  assert.ok(missed.some(g => g.id === gid), '超时未开局被记过号');
  let st = await api('/api/state');
  assert.ok(st.body.data.queue.missed.some(g => g.id === gid));
  assert.ok(st.body.data.events.some(e => e.type === 'miss' && e.ref_id === gid));
  // 恢复排队 → 优先级 +1
  const rq = await api(`/api/queue/${gid}/requeue`, 'POST', { desk_id: 1 });
  assert.equal(rq.status, 200);
  assert.equal(rq.body.data.status, 'waiting');
  assert.equal(rq.body.data.priority, 1);
  // 再叫下一位：过号恢复的组优先
  const next = await api('/api/queue/call-next', 'POST', { desk_id: 1 });
  assert.equal(next.body.data.id, gid);
  assert.equal(next.body.data.status, 'called');
});

test('消毒阻断：归还→待消毒→消毒中均不可借，完成后可借', async () => {
  const gid = await takeAndCall('消毒流程', 1, 1);
  const open = await api('/api/sessions', 'POST', { group_id: gid, lane_id: 4, desk_id: 1, shoe_sizes: [44] });
  assert.equal(open.status, 200);
  const sid = open.body.data.id;
  const shoeNo = open.body.data.shoes[0];
  const shoeId = app.db.prepare('SELECT id FROM shoes WHERE shoe_no=?').get(shoeNo).id;

  await api(`/api/sessions/${sid}/finish`, 'POST', { actual_games: 1, desk_id: 1 });
  const ret = await api(`/api/sessions/${sid}/return-shoes`, 'POST', { items: [{ shoe_id: shoeId }], desk_id: 1 });
  assert.equal(ret.status, 200);
  assert.equal(ret.body.data[0].status, 'pending_disinfection');

  // 待消毒状态不可借：独占该尺码其余库存后尝试再借
  app.db.prepare("UPDATE shoes SET status='rented' WHERE size=44 AND id<>? AND status='available'").run(shoeId);
  const g2 = await takeAndCall('借鞋受阻', 1, 1);
  const blocked = await api('/api/sessions', 'POST', { group_id: g2, lane_id: 5, desk_id: 1, shoe_sizes: [44] });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'SIZE_SHORTAGE');

  // 开始消毒 → 消毒中依然不可借
  const batch = await api('/api/disinfection/start', 'POST', { operator: '测试员' });
  assert.equal(batch.status, 200);
  const stillBlocked = await api('/api/sessions', 'POST', { group_id: g2, lane_id: 5, desk_id: 1, shoe_sizes: [44] });
  assert.equal(stillBlocked.status, 409);

  // 完成消毒 → 可借
  await api(`/api/disinfection/${batch.body.data.id}/complete`, 'POST', {});
  const ok = await api('/api/sessions', 'POST', { group_id: g2, lane_id: 5, desk_id: 1, shoe_sizes: [44] });
  assert.equal(ok.status, 200, '消毒完成后可再次借出');
  assert.equal(ok.body.data.shoes[0], shoeNo);
  // 还原 44 码其余库存
  app.db.prepare("UPDATE shoes SET status='available' WHERE size=44 AND status='rented' AND id NOT IN (SELECT shoe_id FROM session_shoes WHERE returned_at IS NULL)").run();
});

test('换道计费：故障换道不占已有时段，按实际局数结算', async () => {
  const gid = await takeAndCall('换道顾客', 2, 2); // 双局套餐 4500/人
  const open = await api('/api/sessions', 'POST', { group_id: gid, lane_id: 6, desk_id: 1, shoe_sizes: [41, 42] });
  assert.equal(open.status, 200);
  const sid = open.body.data.id;

  // 6 号道故障，受影响订单保留
  await api('/api/lanes/6/fault', 'POST', { type: 'pin_jam', note: '卡瓶', desk_id: 1 });
  let st = await api('/api/state');
  assert.equal(st.body.data.lanes.find(l => l.id === 6).status, 'fault');
  assert.ok(st.body.data.sessions.active.some(s => s.id === sid), '故障后订单保留');

  // 换到 8 号道
  const mv = await api(`/api/sessions/${sid}/change-lane`, 'POST', { to_lane_id: 8, reason: '设备故障', desk_id: 1 });
  assert.equal(mv.status, 200);
  st = await api('/api/state');
  assert.equal(st.body.data.lanes.find(l => l.id === 8).status, 'occupied');
  assert.equal(st.body.data.lanes.find(l => l.id === 6).status, 'fault', '原道保持故障');
  assert.ok(st.body.data.events.some(e => e.type === 'lane_change' && e.ref_id === sid));

  // 换道不得占用已有时段：另一场次想换入 8 号道被拒
  const gid2 = await takeAndCall('抢道顾客', 1, 1);
  const open2 = await api('/api/sessions', 'POST', { group_id: gid2, lane_id: 7, desk_id: 1, shoe_sizes: [43] });
  const conflict = await api(`/api/sessions/${open2.body.data.id}/change-lane`, 'POST', { to_lane_id: 8, reason: '测试', desk_id: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'SLOT_BUSY');

  // 超局结算：套餐 2 局，实际 3 局 → 2人 × (4500 + 2000) = 13000
  const fin = await api(`/api/sessions/${sid}/finish`, 'POST', { actual_games: 3, desk_id: 1 });
  assert.equal(fin.body.data.extra_games, 1);
  assert.equal(fin.body.data.amount_cents, 13000);
  st = await api('/api/state');
  assert.ok(st.body.data.events.some(e => e.type === 'extra_game' && e.ref_id === sid));

  const pay = await api(`/api/sessions/${sid}/checkout`, 'POST', { desk_id: 1, idempotency_key: 'TEST-LANE-CHANGE-1' });
  assert.equal(pay.body.data.payment.amount_cents, 13000);
  assert.equal(pay.body.data.payment.status, 'paid');
});

test('退款幂等：重复退款不重复执行，结账幂等键防重复扣款', async () => {
  const gid = await takeAndCall('退款顾客', 2, 1); // 单局 2500/人 × 2
  const lane = await idleLaneId();
  const open = await api('/api/sessions', 'POST', { group_id: gid, lane_id: lane, desk_id: 1, shoe_sizes: [42, 43] });
  const sid = open.body.data.id;
  await api(`/api/sessions/${sid}/finish`, 'POST', { actual_games: 1, desk_id: 1 });

  // 同一幂等键重复结账 → 只扣一次
  const chargesBefore = app.adapters.payment.charges.size;
  const c1 = await api(`/api/sessions/${sid}/checkout`, 'POST', { desk_id: 1, idempotency_key: 'PAY-IDEM-1' });
  const c2 = await api(`/api/sessions/${sid}/checkout`, 'POST', { desk_id: 1, idempotency_key: 'PAY-IDEM-1' });
  assert.equal(c1.body.data.payment.id, c2.body.data.payment.id);
  assert.equal(c2.body.data.idempotent, true);
  assert.equal(app.adapters.payment.charges.size, chargesBefore + 1, '支付网关只收到一次扣款');
  const pid = c1.body.data.payment.id;
  assert.equal(c1.body.data.payment.amount_cents, 5000);

  // 并发重复退款（同一退款键）→ 只退一次
  const refundsBefore = app.adapters.payment.refunds.size;
  const [r1, r2] = await Promise.all([
    api(`/api/payments/${pid}/refund`, 'POST', { idempotency_key: 'RF-IDEM-1' }),
    api(`/api/payments/${pid}/refund`, 'POST', { idempotency_key: 'RF-IDEM-1' }),
  ]);
  const refunded = [r1, r2].filter(r => r.body.data && r.body.data.payment.status === 'refunded');
  assert.equal(refunded.length, 2, '两次请求都拿到退款结果');
  assert.equal(app.adapters.payment.refunds.size, refundsBefore + 1, '网关只执行一次退款');
  assert.ok((r1.body.data.idempotent || r2.body.data.idempotent), '其中一次为幂等重放');

  // 换幂等键再退 → 拒绝
  const r3 = await api(`/api/payments/${pid}/refund`, 'POST', { idempotency_key: 'RF-IDEM-2' });
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error, 'ALREADY_REFUNDED');
});

test('复核：赔付与免单需值班经理批准', async () => {
  // 赔付：还鞋报损 → 结账加赔付 → 待复核 → 批准入账
  const gid = await takeAndCall('损坏顾客', 1, 1);
  const lane = await idleLaneId();
  const open = await api('/api/sessions', 'POST', { group_id: gid, lane_id: lane, desk_id: 1, shoe_sizes: [45] });
  const sid = open.body.data.id;
  const shoeId = app.db.prepare('SELECT id FROM shoes WHERE shoe_no=?').get(open.body.data.shoes[0]).id;
  await api(`/api/sessions/${sid}/finish`, 'POST', { actual_games: 1, desk_id: 1 });
  const ret = await api(`/api/sessions/${sid}/return-shoes`, 'POST', {
    items: [{ shoe_id: shoeId, damaged: true, note: '鞋底脱落' }], desk_id: 1,
  });
  assert.equal(ret.body.data[0].status, 'damaged');
  let st = await api('/api/state');
  assert.ok(st.body.data.events.some(e => e.type === 'shoe_damage' && e.ref_id === sid));

  const co = await api(`/api/sessions/${sid}/checkout`, 'POST', {
    desk_id: 1, idempotency_key: 'PAY-COMP-1', comp_cents: 20000, comp_reason: '鞋底脱落赔付',
  });
  assert.equal(co.body.data.payment.status, 'pending_review');
  assert.equal(co.body.data.payment.amount_cents, 2500 + 20000);
  const reviewId = co.body.data.review_id;
  assert.ok(reviewId);

  // 未经复核不入账；批准后入账
  const ok = await api(`/api/reviews/${reviewId}/decide`, 'POST', { manager: '王经理', approve: true });
  assert.equal(ok.body.data.status, 'approved');
  st = await api('/api/state');
  const pay = st.body.data.payments.find(p => p.id === co.body.data.payment.id);
  assert.equal(pay.status, 'paid');
  assert.equal(pay.amount_cents, 22500);

  // 免单：申请 → 驳回 → 支付单作废
  const gid2 = await takeAndCall('免单顾客', 1, 1);
  const lane2 = await idleLaneId();
  const open2 = await api('/api/sessions', 'POST', { group_id: gid2, lane_id: lane2, desk_id: 1, shoe_sizes: [39] });
  await api(`/api/sessions/${open2.body.data.id}/finish`, 'POST', { actual_games: 1, desk_id: 1 });
  const co2 = await api(`/api/sessions/${open2.body.data.id}/checkout`, 'POST', {
    desk_id: 1, idempotency_key: 'PAY-FREE-1', free: true, free_reason: '设备故障补偿',
  });
  assert.equal(co2.body.data.payment.status, 'pending_review');
  const rej = await api(`/api/reviews/${co2.body.data.review_id}/decide`, 'POST', { manager: '王经理', approve: false });
  assert.equal(rej.body.data.status, 'rejected');
  st = await api('/api/state');
  assert.equal(st.body.data.payments.find(p => p.id === co2.body.data.payment.id).status, 'rejected');
});

test('临时加人与卡球事件', async () => {
  const gid = await takeAndCall('加人顾客', 2, 2);
  const lane = await idleLaneId();
  const open = await api('/api/sessions', 'POST', { group_id: gid, lane_id: lane, desk_id: 1, shoe_sizes: [37, 38] });
  const sid = open.body.data.id;
  const add = await api(`/api/sessions/${sid}/add-player`, 'POST', { count: 1, shoe_sizes: [36], desk_id: 1 });
  assert.equal(add.body.data.players, 3);
  const bs = await api(`/api/sessions/${sid}/event`, 'POST', { type: 'ball_stuck', payload: { detail: '球卡回球槽' }, desk_id: 1 });
  assert.equal(bs.status, 200);
  const st = await api('/api/state');
  assert.ok(st.body.data.events.some(e => e.type === 'add_player' && e.ref_id === sid));
  assert.ok(st.body.data.events.some(e => e.type === 'ball_stuck' && e.ref_id === sid));
  // 加人后按 3 人结算
  const fin = await api(`/api/sessions/${sid}/finish`, 'POST', { actual_games: 2, desk_id: 1 });
  assert.equal(fin.body.data.amount_cents, 3 * 4500);
});
