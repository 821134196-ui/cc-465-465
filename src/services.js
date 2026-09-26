'use strict';
// 业务服务层：候场叫号、开局、球鞋周转、消毒、故障换道、结账复核。
// 所有多步写入都在 BEGIN IMMEDIATE 事务内完成；
// 资源占用一律用条件 UPDATE（... WHERE status='idle'/'available'）+ changes 校验，
// 保证两个前台不能同时开同一球道或借出同一双鞋。
const fs = require('fs');
const path = require('path');

const GAME_MIN = 10;            // 每局估算分钟数（用于等待/时长估算）
const PER_GAME_CENTS = 2500;    // 单局门市价 ¥25/人
const EXTRA_GAME_CENTS = 2000;  // 超局优惠价 ¥20/人/局

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

function createServices(db, adapters, config = {}) {
  const callTimeoutSec = config.callTimeoutSec ?? Number(process.env.CALL_TIMEOUT_SEC || 60);
  const photosDir = config.photosDir || path.join(process.cwd(), 'data', 'photos');
  fs.mkdirSync(photosDir, { recursive: true });

  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const nowIso = () => new Date().toISOString();

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  function logEvent(type, refType, refId, payload = {}, deskId = null, at = null) {
    run('INSERT INTO events(type, ref_type, ref_id, payload, desk_id, created_at) VALUES(?,?,?,?,?,?)',
      type, refType, refId, JSON.stringify(payload), deskId, at || nowIso());
  }

  // ---------- 候场叫号 ----------

  function takeNumber({ customer_name, phone = '', party_size, need_bumper = 0, package_id }, deskId = null) {
    if (!customer_name || !String(customer_name).trim()) throw new ApiError(400, 'BAD_INPUT', '请填写顾客姓名');
    party_size = Number(party_size);
    if (!Number.isInteger(party_size) || party_size < 1 || party_size > 8) {
      throw new ApiError(400, 'BAD_INPUT', '人数需为 1-8 人');
    }
    const pkg = get('SELECT * FROM packages WHERE id=?', package_id);
    if (!pkg) throw new ApiError(404, 'NO_PACKAGE', '套餐不存在');
    return tx(() => {
      const seq = get('SELECT COUNT(*) AS c FROM queue_groups').c + 1;
      const groupNo = 'A' + String(seq).padStart(3, '0');
      const r = run(
        `INSERT INTO queue_groups(group_no, customer_name, phone, party_size, need_bumper, package_id, status, desk_id, created_at)
         VALUES(?,?,?,?,?,?, 'waiting', ?, ?)`,
        groupNo, String(customer_name).trim(), String(phone || ''), party_size, need_bumper ? 1 : 0, pkg.id, deskId, nowIso());
      logEvent('take_number', 'group', Number(r.lastInsertRowid),
        { group_no: groupNo, name: customer_name, party_size, need_bumper: !!need_bumper, package: pkg.name }, deskId);
      return get('SELECT * FROM queue_groups WHERE id=?', r.lastInsertRowid);
    });
  }

  function callGroup(groupId, deskId) {
    return tx(() => {
      const g = get('SELECT * FROM queue_groups WHERE id=?', groupId);
      if (!g) throw new ApiError(404, 'NO_GROUP', '组号不存在');
      if (g.status !== 'waiting') throw new ApiError(409, 'BAD_STATE', `组号 ${g.group_no} 当前状态为 ${g.status}，不能叫号`);
      run("UPDATE queue_groups SET status='called', called_at=?, desk_id=? WHERE id=?", nowIso(), deskId, groupId);
      logEvent('call', 'group', groupId, { group_no: g.group_no }, deskId);
      return get('SELECT * FROM queue_groups WHERE id=?', groupId);
    });
  }

  function callNext(deskId, needBumper = null) {
    const g = needBumper == null
      ? get("SELECT * FROM queue_groups WHERE status='waiting' ORDER BY priority DESC, id ASC LIMIT 1")
      : get("SELECT * FROM queue_groups WHERE status='waiting' AND need_bumper=? ORDER BY priority DESC, id ASC LIMIT 1", needBumper);
    if (!g) throw new ApiError(404, 'QUEUE_EMPTY', '没有等待中的组号');
    return callGroup(g.id, deskId);
  }

  function missGroup(groupId, deskId, at = null) {
    return tx(() => {
      const g = get('SELECT * FROM queue_groups WHERE id=?', groupId);
      if (!g) throw new ApiError(404, 'NO_GROUP', '组号不存在');
      if (g.status !== 'called') throw new ApiError(409, 'BAD_STATE', '仅已叫号的组可标记过号');
      run("UPDATE queue_groups SET status='missed', miss_count=miss_count+1 WHERE id=?", groupId);
      logEvent('miss', 'group', groupId, { group_no: g.group_no, miss_count: g.miss_count + 1 }, deskId, at);
      return get('SELECT * FROM queue_groups WHERE id=?', groupId);
    });
  }

  function requeueGroup(groupId, deskId) {
    return tx(() => {
      const g = get('SELECT * FROM queue_groups WHERE id=?', groupId);
      if (!g) throw new ApiError(404, 'NO_GROUP', '组号不存在');
      if (g.status !== 'missed') throw new ApiError(409, 'BAD_STATE', '仅过号组可恢复排队');
      run("UPDATE queue_groups SET status='waiting', priority=priority+1, called_at=NULL WHERE id=?", groupId);
      logEvent('requeue', 'group', groupId, { group_no: g.group_no, priority: g.priority + 1 }, deskId);
      return get('SELECT * FROM queue_groups WHERE id=?', groupId);
    });
  }

  function cancelGroup(groupId, deskId) {
    return tx(() => {
      const g = get('SELECT * FROM queue_groups WHERE id=?', groupId);
      if (!g) throw new ApiError(404, 'NO_GROUP', '组号不存在');
      if (!['waiting', 'missed', 'called'].includes(g.status)) throw new ApiError(409, 'BAD_STATE', '当前状态不能取消');
      run("UPDATE queue_groups SET status='cancelled' WHERE id=?", groupId);
      logEvent('cancel', 'group', groupId, { group_no: g.group_no }, deskId);
      return get('SELECT * FROM queue_groups WHERE id=?', groupId);
    });
  }

  // 进程内任务：扫描叫号超时未开局的组，自动记过号
  function sweepMissed(now = new Date()) {
    const cutoff = now.getTime() - callTimeoutSec * 1000;
    const rows = all("SELECT * FROM queue_groups WHERE status='called'");
    const missed = [];
    for (const g of rows) {
      if (Date.parse(g.called_at) <= cutoff) missed.push(missGroup(g.id, g.desk_id, now.toISOString()));
    }
    return missed;
  }

  // ---------- 开局 ----------

  function openSession({ group_id, lane_id, desk_id, shoe_sizes = [], ball_weights = [], bumper_used = 0 }) {
    if (!Array.isArray(shoe_sizes) || shoe_sizes.length === 0) {
      throw new ApiError(400, 'BAD_INPUT', '请为每位顾客选择球鞋尺码');
    }
    let shortage = [];
    try {
      return tx(() => {
        const g = get('SELECT * FROM queue_groups WHERE id=?', group_id);
        if (!g) throw new ApiError(404, 'NO_GROUP', '组号不存在');
        if (g.status !== 'called') throw new ApiError(409, 'BAD_STATE', `组号 ${g.group_no} 未叫号，请先叫号再开局`);
        const lane = get('SELECT * FROM lanes WHERE id=?', lane_id);
        if (!lane) throw new ApiError(404, 'NO_LANE', '球道不存在');
        if (g.need_bumper && !lane.bumper_capable) {
          throw new ApiError(409, 'NO_BUMPER', `${lane.name} 无护栏，该组需要护栏球道`);
        }
        // 球道双锁：只有 idle 才能占用
        const lock = run("UPDATE lanes SET status='occupied' WHERE id=? AND status='idle'", lane_id);
        if (lock.changes !== 1) throw new ApiError(409, 'LANE_BUSY', `${lane.name} 已被占用或故障，开局失败`);

        // 球鞋双锁 + 缺码检测：按尺码自动分配库存最小的可用鞋
        const assigned = [];
        for (const size of shoe_sizes) {
          const shoe = get("SELECT * FROM shoes WHERE size=? AND status='available' ORDER BY shoe_no LIMIT 1", size);
          if (!shoe) { shortage.push(size); continue; }
          const u = run("UPDATE shoes SET status='rented' WHERE id=? AND status='available'", shoe.id);
          if (u.changes !== 1) { shortage.push(size); continue; }
          assigned.push(shoe);
        }
        if (shortage.length) {
          throw new ApiError(409, 'SIZE_SHORTAGE', `球鞋缺码：${[...new Set(shortage)].join('、')} 码暂无可用`, { shortage });
        }

        const pkg = get('SELECT * FROM packages WHERE id=?', g.package_id);
        const players = shoe_sizes.length;
        const r = run(
          `INSERT INTO sessions(lane_id, group_id, package_id, desk_id, status, players, planned_games, bumper_used, started_at)
           VALUES(?,?,?,?, 'active', ?,?,?,?)`,
          lane_id, group_id, pkg.id, desk_id, players, pkg.games, bumper_used ? 1 : 0, nowIso());
        const sessionId = Number(r.lastInsertRowid);
        for (const shoe of assigned) {
          run('INSERT INTO session_shoes(session_id, shoe_id, desk_id, rented_at) VALUES(?,?,?,?)',
            sessionId, shoe.id, desk_id, nowIso());
        }
        // 保龄球按重量分配，缺重不阻塞开局，仅记录
        const ballShort = [];
        for (const w of ball_weights) {
          const ball = get("SELECT * FROM balls WHERE weight=? AND status='available' ORDER BY ball_no LIMIT 1", w);
          if (!ball) { ballShort.push(w); continue; }
          run("UPDATE balls SET status='in_use' WHERE id=? AND status='available'", ball.id);
          run('INSERT INTO session_balls(session_id, ball_id, rented_at) VALUES(?,?,?)', sessionId, ball.id, nowIso());
        }
        run("UPDATE queue_groups SET status='playing' WHERE id=?", group_id);
        run('INSERT INTO lane_slots(lane_id, session_id, started_at) VALUES(?,?,?)', lane_id, sessionId, nowIso());
        logEvent('session_open', 'session', sessionId, {
          lane: lane.name, group_no: g.group_no, players,
          shoes: assigned.map(s => s.shoe_no), ball_short: ballShort,
        }, desk_id);
        const s = get('SELECT * FROM sessions WHERE id=?', sessionId);
        return { ...s, shoes: assigned.map(s => s.shoe_no), ball_short: ballShort };
      });
    } catch (e) {
      if (e.code === 'SIZE_SHORTAGE') {
        logEvent('size_shortage', 'group', group_id, { sizes: [...new Set(shortage)] }, desk_id);
      }
      throw e;
    }
  }

  // 临时加人：补录人数并借鞋
  function addPlayer({ session_id, count = 1, shoe_sizes = [], desk_id }) {
    count = Number(count);
    if (!Number.isInteger(count) || count < 1) throw new ApiError(400, 'BAD_INPUT', '加人数量不合法');
    if (!Array.isArray(shoe_sizes) || shoe_sizes.length !== count) {
      throw new ApiError(400, 'BAD_INPUT', '每位新顾客需选一双球鞋尺码');
    }
    let shortage = [];
    try {
      return tx(() => {
        const s = get('SELECT * FROM sessions WHERE id=?', session_id);
        if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
        if (s.status !== 'active') throw new ApiError(409, 'BAD_STATE', '场次已结束，不能加人');
        const assigned = [];
        for (const size of shoe_sizes) {
          const shoe = get("SELECT * FROM shoes WHERE size=? AND status='available' ORDER BY shoe_no LIMIT 1", size);
          if (!shoe) { shortage.push(size); continue; }
          const u = run("UPDATE shoes SET status='rented' WHERE id=? AND status='available'", shoe.id);
          if (u.changes !== 1) { shortage.push(size); continue; }
          assigned.push(shoe);
        }
        if (shortage.length) {
          throw new ApiError(409, 'SIZE_SHORTAGE', `球鞋缺码：${[...new Set(shortage)].join('、')} 码暂无可用`, { shortage });
        }
        for (const shoe of assigned) {
          run('INSERT INTO session_shoes(session_id, shoe_id, desk_id, rented_at) VALUES(?,?,?,?)',
            session_id, shoe.id, desk_id, nowIso());
        }
        run('UPDATE sessions SET players=players+? WHERE id=?', count, session_id);
        logEvent('add_player', 'session', session_id, { count, shoes: assigned.map(x => x.shoe_no) }, desk_id);
        return { players: get('SELECT players FROM sessions WHERE id=?', session_id).players, shoes: assigned.map(x => x.shoe_no) };
      });
    } catch (e) {
      if (e.code === 'SIZE_SHORTAGE') {
        logEvent('size_shortage', 'session', session_id, { sizes: [...new Set(shortage)] }, desk_id);
      }
      throw e;
    }
  }

  // 现场事件：卡球 / 计分器中断 / 备注
  function recordEvent({ session_id, type, payload = {}, desk_id }) {
    const allowed = ['ball_stuck', 'scorer_interrupt', 'note'];
    if (!allowed.includes(type)) throw new ApiError(400, 'BAD_INPUT', '不支持的事件类型');
    const s = get('SELECT * FROM sessions WHERE id=?', session_id);
    if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
    logEvent(type, 'session', session_id, payload, desk_id);
    return { ok: true };
  }

  // ---------- 结束与计费 ----------

  // 按实际局数结算：未超局取 套餐价 与 门市价×局数 的较低者；超局部分按优惠价
  function billAmount(pkg, players, actualGames) {
    if (actualGames <= pkg.games) {
      return players * Math.min(pkg.price_cents, actualGames * PER_GAME_CENTS);
    }
    return players * (pkg.price_cents + (actualGames - pkg.games) * EXTRA_GAME_CENTS);
  }

  function finishSession({ session_id, actual_games, desk_id }) {
    actual_games = Number(actual_games);
    if (!Number.isInteger(actual_games) || actual_games < 0 || actual_games > 20) {
      throw new ApiError(400, 'BAD_INPUT', '实际局数不合法');
    }
    return tx(() => {
      const s = get('SELECT * FROM sessions WHERE id=?', session_id);
      if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
      if (s.status !== 'active') throw new ApiError(409, 'BAD_STATE', '场次已结束');
      const pkg = get('SELECT * FROM packages WHERE id=?', s.package_id);
      const extra = Math.max(0, actual_games - s.planned_games);
      const amount = billAmount(pkg, s.players, actual_games);
      run(`UPDATE sessions SET status='finished', actual_games=?, extra_games=?, amount_cents=?, ended_at=? WHERE id=?`,
        actual_games, extra, amount, nowIso(), session_id);
      run('UPDATE lane_slots SET ended_at=? WHERE session_id=? AND ended_at IS NULL', nowIso(), session_id);
      // 故障未解除的球道保持 fault，否则释放
      const faultOpen = get("SELECT id FROM faults WHERE lane_id=? AND status='open'", s.lane_id);
      if (!faultOpen) run("UPDATE lanes SET status='idle' WHERE id=?", s.lane_id);
      run("UPDATE queue_groups SET status='finished' WHERE id=?", s.group_id);
      run(`UPDATE balls SET status='available' WHERE id IN
           (SELECT ball_id FROM session_balls WHERE session_id=? AND returned_at IS NULL)`, session_id);
      run('UPDATE session_balls SET returned_at=? WHERE session_id=? AND returned_at IS NULL', nowIso(), session_id);
      logEvent('session_finish', 'session', session_id,
        { actual_games, extra_games: extra, amount_cents: amount }, desk_id);
      if (extra > 0) {
        logEvent('extra_game', 'session', session_id,
          { planned: s.planned_games, actual: actual_games, extra_games: extra }, desk_id);
      }
      return get('SELECT * FROM sessions WHERE id=?', session_id);
    });
  }

  // ---------- 球鞋归还与消毒 ----------

  function savePhoto(sessionId, shoeId, b64) {
    const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/.exec(b64);
    const ext = m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'png';
    const data = Buffer.from(m ? m[2] : b64, 'base64');
    if (!data.length) throw new ApiError(400, 'BAD_PHOTO', '照片数据为空');
    if (data.length > 5 * 1024 * 1024) throw new ApiError(400, 'PHOTO_TOO_BIG', '照片超过 5MB');
    const name = `damage_s${sessionId}_shoe${shoeId}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(photosDir, name), data);
    return `photos/${name}`;
  }

  function returnShoes({ session_id, items, desk_id }) {
    if (!Array.isArray(items) || !items.length) throw new ApiError(400, 'BAD_INPUT', '请勾选要归还的球鞋');
    const damagedEvents = [];
    const result = tx(() => {
      const s = get('SELECT * FROM sessions WHERE id=?', session_id);
      if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
      const out = [];
      for (const item of items) {
        const ss = get('SELECT * FROM session_shoes WHERE session_id=? AND shoe_id=? AND returned_at IS NULL',
          session_id, item.shoe_id);
        if (!ss) throw new ApiError(409, 'BAD_STATE', `球鞋 #${item.shoe_id} 不属于该场次或已归还`);
        const damaged = item.damaged ? 1 : 0;
        let photoPath = '';
        if (damaged && item.photo_b64) photoPath = savePhoto(session_id, item.shoe_id, item.photo_b64);
        run('UPDATE session_shoes SET returned_at=?, damaged=?, damage_note=?, photo_path=? WHERE id=?',
          nowIso(), damaged, String(item.note || ''), photoPath, ss.id);
        // 归还即进入待消毒；损坏则退出周转
        run('UPDATE shoes SET status=? WHERE id=?', damaged ? 'damaged' : 'pending_disinfection', item.shoe_id);
        const shoe = get('SELECT * FROM shoes WHERE id=?', item.shoe_id);
        if (damaged) damagedEvents.push({ shoe, note: String(item.note || ''), photo: photoPath });
        out.push({ shoe_no: shoe.shoe_no, status: damaged ? 'damaged' : 'pending_disinfection', photo: photoPath });
      }
      return out;
    });
    for (const d of damagedEvents) {
      logEvent('shoe_damage', 'session', session_id,
        { shoe_no: d.shoe.shoe_no, size: d.shoe.size, note: d.note, photo: d.photo }, desk_id);
    }
    return result;
  }

  function startDisinfection({ operator = '消毒员' } = {}) {
    return tx(() => {
      const pending = all("SELECT * FROM shoes WHERE status='pending_disinfection' ORDER BY shoe_no");
      if (!pending.length) throw new ApiError(409, 'NOTHING_TO_DISINFECT', '没有待消毒球鞋');
      const r = run("INSERT INTO disinfection_batches(operator, status, started_at) VALUES(?, 'running', ?)", operator, nowIso());
      const batchId = Number(r.lastInsertRowid);
      for (const sh of pending) {
        run('INSERT INTO disinfection_items(batch_id, shoe_id) VALUES(?,?)', batchId, sh.id);
        run("UPDATE shoes SET status='disinfecting' WHERE id=?", sh.id);
      }
      logEvent('disinfection_start', 'batch', batchId, { count: pending.length, shoes: pending.map(s => s.shoe_no) });
      return get('SELECT * FROM disinfection_batches WHERE id=?', batchId);
    });
  }

  function completeDisinfection(batchId) {
    return tx(() => {
      const b = get('SELECT * FROM disinfection_batches WHERE id=?', batchId);
      if (!b) throw new ApiError(404, 'NO_BATCH', '消毒批次不存在');
      if (b.status !== 'running') throw new ApiError(409, 'BAD_STATE', '该批次已完成');
      run("UPDATE disinfection_batches SET status='done', completed_at=? WHERE id=?", nowIso(), batchId);
      run(`UPDATE shoes SET status='available' WHERE id IN
           (SELECT shoe_id FROM disinfection_items WHERE batch_id=?)`, batchId);
      logEvent('disinfection_done', 'batch', batchId, {});
      return get('SELECT * FROM disinfection_batches WHERE id=?', batchId);
    });
  }

  // ---------- 故障与换道 ----------

  function reportFault({ lane_id, type, note = '' }, deskId = null) {
    return tx(() => {
      const lane = get('SELECT * FROM lanes WHERE id=?', lane_id);
      if (!lane) throw new ApiError(404, 'NO_LANE', '球道不存在');
      const open = get("SELECT id FROM faults WHERE lane_id=? AND status='open'", lane_id);
      if (open) throw new ApiError(409, 'FAULT_OPEN', '该球道已有未处理故障');
      const r = run('INSERT INTO faults(lane_id, type, note, started_at) VALUES(?,?,?,?)',
        lane_id, String(type || 'other'), String(note || ''), nowIso());
      // 故障球道暂停叫号分配；受影响订单（进行中场次）保留
      run("UPDATE lanes SET status='fault' WHERE id=?", lane_id);
      logEvent('fault', 'lane', lane_id, { lane: lane.name, fault_type: type, note }, deskId);
      return get('SELECT * FROM faults WHERE id=?', r.lastInsertRowid);
    });
  }

  function resolveFault(laneId, deskId = null) {
    return tx(() => {
      const f = get("SELECT * FROM faults WHERE lane_id=? AND status='open'", laneId);
      if (!f) throw new ApiError(404, 'NO_FAULT', '该球道没有未处理故障');
      run("UPDATE faults SET status='resolved', resolved_at=? WHERE id=?", nowIso(), f.id);
      const active = get("SELECT id FROM sessions WHERE lane_id=? AND status='active'", laneId);
      run('UPDATE lanes SET status=? WHERE id=?', active ? 'occupied' : 'idle', laneId);
      logEvent('fault_resolved', 'lane', laneId, { fault_id: f.id }, deskId);
      return get('SELECT * FROM faults WHERE id=?', f.id);
    });
  }

  function changeLane({ session_id, to_lane_id, reason = '', desk_id }) {
    return tx(() => {
      const s = get('SELECT * FROM sessions WHERE id=?', session_id);
      if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
      if (s.status !== 'active') throw new ApiError(409, 'BAD_STATE', '仅进行中的场次可换道');
      if (s.lane_id === Number(to_lane_id)) throw new ApiError(400, 'BAD_INPUT', '目标球道与当前相同');
      const from = get('SELECT * FROM lanes WHERE id=?', s.lane_id);
      const to = get('SELECT * FROM lanes WHERE id=?', to_lane_id);
      if (!to) throw new ApiError(404, 'NO_LANE', '目标球道不存在');
      const g = get('SELECT * FROM queue_groups WHERE id=?', s.group_id);
      if (g.need_bumper && !to.bumper_capable) throw new ApiError(409, 'NO_BUMPER', `${to.name} 无护栏`);
      // 换道不得占用已有时段：目标道存在未结束时段则拒绝
      const openSlot = get('SELECT id FROM lane_slots WHERE lane_id=? AND ended_at IS NULL', to_lane_id);
      if (openSlot) throw new ApiError(409, 'SLOT_BUSY', `${to.name} 已有占用时段，不能换入`);
      const lock = run("UPDATE lanes SET status='occupied' WHERE id=? AND status='idle'", to_lane_id);
      if (lock.changes !== 1) throw new ApiError(409, 'LANE_BUSY', `${to.name} 已被占用或故障`);
      run('UPDATE lane_slots SET ended_at=? WHERE session_id=? AND ended_at IS NULL', nowIso(), session_id);
      run('INSERT INTO lane_slots(lane_id, session_id, started_at) VALUES(?,?,?)', to_lane_id, session_id, nowIso());
      run('UPDATE sessions SET lane_id=? WHERE id=?', to_lane_id, session_id);
      const fromFault = get("SELECT id FROM faults WHERE lane_id=? AND status='open'", s.lane_id);
      if (!fromFault) run("UPDATE lanes SET status='idle' WHERE id=?", s.lane_id);
      const r = run(
        'INSERT INTO lane_changes(session_id, from_lane_id, to_lane_id, reason, desk_id, changed_at) VALUES(?,?,?,?,?,?)',
        session_id, s.lane_id, to_lane_id, String(reason || ''), desk_id, nowIso());
      logEvent('lane_change', 'session', session_id, { from: from.name, to: to.name, reason }, desk_id);
      return { change_id: Number(r.lastInsertRowid), from: from.name, to: to.name };
    });
  }

  // ---------- 结账、退款、复核 ----------

  function checkout({ session_id, desk_id, method = 'cash', idempotency_key, comp_cents = 0, comp_reason = '', free = false, free_reason = '' }) {
    if (!idempotency_key) throw new ApiError(400, 'BAD_INPUT', '缺少幂等键');
    comp_cents = Math.max(0, Math.round(Number(comp_cents) || 0));
    // 幂等重放：同一幂等键直接返回原支付单，不重复扣款
    const existing = get('SELECT * FROM payments WHERE idempotency_key=?', idempotency_key);
    if (existing) return { payment: existing, idempotent: true };
    return tx(() => {
      const s = get('SELECT * FROM sessions WHERE id=?', session_id);
      if (!s) throw new ApiError(404, 'NO_SESSION', '场次不存在');
      if (s.status !== 'finished') throw new ApiError(409, 'BAD_STATE', '场次未结束，不能结账');
      const dup = get("SELECT id FROM payments WHERE session_id=? AND status IN ('paid','pending_review')", session_id);
      if (dup) throw new ApiError(409, 'ALREADY_BILLED', '该场次已结账或待复核');
      const needReview = !!free || comp_cents > 0;
      const amount = free ? 0 : s.amount_cents + comp_cents;
      let status = needReview ? 'pending_review' : 'paid';
      let txn = '';
      let paidAt = null;
      if (!needReview) {
        const r = adapters.payment.charge(idempotency_key, amount);
        txn = r.txn_id;
        paidAt = nowIso();
      }
      const r = run(
        'INSERT INTO payments(session_id, amount_cents, method, status, idempotency_key, txn_id, paid_at) VALUES(?,?,?,?,?,?,?)',
        session_id, amount, String(method), status, idempotency_key, txn, paidAt);
      const paymentId = Number(r.lastInsertRowid);
      let reviewId = null;
      if (needReview) {
        const kind = free ? 'free' : 'comp';
        const rr = run(
          'INSERT INTO reviews(payment_id, kind, amount_cents, reason, requested_by, created_at) VALUES(?,?,?,?,?,?)',
          paymentId, kind, free ? s.amount_cents : comp_cents,
          String(free ? free_reason : comp_reason), desk_id, nowIso());
        reviewId = Number(rr.lastInsertRowid);
      }
      logEvent('checkout', 'session', session_id,
        { payment_id: paymentId, amount_cents: amount, status, comp_cents, free: !!free }, desk_id);
      return { payment: get('SELECT * FROM payments WHERE id=?', paymentId), review_id: reviewId };
    });
  }

  // 值班经理复核：赔付 / 免单
  function decideReview({ review_id, manager, approve }) {
    if (!manager || !String(manager).trim()) throw new ApiError(400, 'BAD_INPUT', '请填写值班经理姓名');
    return tx(() => {
      const rv = get('SELECT * FROM reviews WHERE id=?', review_id);
      if (!rv) throw new ApiError(404, 'NO_REVIEW', '复核单不存在');
      if (rv.status !== 'pending') throw new ApiError(409, 'BAD_STATE', '该复核已处理');
      run('UPDATE reviews SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?',
        approve ? 'approved' : 'rejected', String(manager).trim(), nowIso(), review_id);
      const p = get('SELECT * FROM payments WHERE id=?', rv.payment_id);
      if (approve) {
        let txn;
        if (rv.kind === 'comp') txn = adapters.payment.charge(p.idempotency_key, p.amount_cents).txn_id;
        else txn = 'FREE-' + p.idempotency_key.slice(0, 8);
        run("UPDATE payments SET status='paid', txn_id=?, paid_at=? WHERE id=?", txn, nowIso(), p.id);
      } else {
        run("UPDATE payments SET status='rejected' WHERE id=?", p.id);
      }
      logEvent('review', 'payment', p.id, { review_id, kind: rv.kind, approve: !!approve, manager });
      return get('SELECT * FROM reviews WHERE id=?', review_id);
    });
  }

  function refund({ payment_id, idempotency_key, amount_cents = null }) {
    if (!idempotency_key) throw new ApiError(400, 'BAD_INPUT', '缺少退款幂等键');
    return tx(() => {
      const p = get('SELECT * FROM payments WHERE id=?', payment_id);
      if (!p) throw new ApiError(404, 'NO_PAYMENT', '支付单不存在');
      if (p.status === 'refunded') {
        if (p.refund_key === idempotency_key) return { payment: p, idempotent: true };
        throw new ApiError(409, 'ALREADY_REFUNDED', '该支付单已退款');
      }
      if (p.status !== 'paid') throw new ApiError(409, 'BAD_STATE', '仅已支付订单可退款');
      const amount = amount_cents == null ? p.amount_cents : Math.round(Number(amount_cents));
      if (!(amount > 0 && amount <= p.amount_cents)) throw new ApiError(400, 'BAD_INPUT', '退款金额不合法');
      const rf = adapters.payment.refund(idempotency_key, p.txn_id, amount);
      const u = run(`UPDATE payments SET status='refunded', refund_key=?, refund_id=?, refunded_at=?, refund_amount_cents=?
                     WHERE id=? AND status='paid'`, idempotency_key, rf.refund_id, nowIso(), amount, payment_id);
      if (u.changes !== 1) throw new ApiError(409, 'REFUND_RACE', '退款状态冲突，请重试');
      logEvent('refund', 'payment', payment_id, { amount_cents: amount, refund_id: rf.refund_id });
      return { payment: get('SELECT * FROM payments WHERE id=?', payment_id) };
    });
  }

  // ---------- 进程内任务：场次时长 ----------

  const durations = new Map(); // session_id -> {elapsed_sec, est_sec, over}
  function refreshDurations(now = new Date()) {
    const rows = all("SELECT id, planned_games, started_at FROM sessions WHERE status='active'");
    for (const s of rows) {
      const elapsed = Math.max(0, Math.floor((now.getTime() - Date.parse(s.started_at)) / 1000));
      const est = s.planned_games * GAME_MIN * 60;
      durations.set(s.id, { elapsed_sec: elapsed, est_sec: est, over: elapsed > est });
    }
    return durations;
  }

  // ---------- 状态聚合 ----------

  function getState() {
    const lanes = all('SELECT * FROM lanes ORDER BY position');
    const activeSessions = all("SELECT * FROM sessions WHERE status='active' ORDER BY id");
    const waiting = all("SELECT * FROM queue_groups WHERE status='waiting' ORDER BY priority DESC, id ASC");

    const remainingByLane = new Map();
    for (const l of lanes) {
      const act = activeSessions.find(s => s.lane_id === l.id);
      if (!act) { remainingByLane.set(l.id, 0); continue; }
      const d = durations.get(act.id);
      remainingByLane.set(l.id, d ? Math.max(0, d.est_sec - d.elapsed_sec) : act.planned_games * GAME_MIN * 60);
    }
    const estWaitMin = (g) => {
      const pos = waiting.findIndex(w => w.id === g.id);
      const suitable = lanes.filter(l => !g.need_bumper || l.bumper_capable);
      const soonest = Math.min(...suitable.map(l => remainingByLane.get(l.id) ?? 0));
      return Math.max(0, Math.round((soonest + pos * 8 * 60) / 60));
    };

    const sessionView = (s) => {
      const g = get('SELECT * FROM queue_groups WHERE id=?', s.group_id);
      const pkg = get('SELECT * FROM packages WHERE id=?', s.package_id);
      const lane = get('SELECT * FROM lanes WHERE id=?', s.lane_id);
      const shoes = all(`SELECT ss.*, sh.shoe_no, sh.size FROM session_shoes ss
                         JOIN shoes sh ON sh.id = ss.shoe_id WHERE ss.session_id=? ORDER BY ss.id`, s.id);
      const balls = all(`SELECT sb.*, b.ball_no, b.weight FROM session_balls sb
                         JOIN balls b ON b.id = sb.ball_id WHERE sb.session_id=? ORDER BY sb.id`, s.id);
      const d = durations.get(s.id);
      return {
        ...s,
        group_no: g ? g.group_no : '?',
        customer_name: g ? g.customer_name : '?',
        package_name: pkg ? pkg.name : '?',
        lane_name: lane ? lane.name : '?',
        shoes, balls,
        elapsed_sec: d ? d.elapsed_sec : null,
        est_sec: d ? d.est_sec : null,
        over_estimate: d ? d.over : false,
      };
    };

    const shoeRows = all('SELECT * FROM shoes ORDER BY size, shoe_no');
    const matrix = {};
    for (const sh of shoeRows) {
      (matrix[sh.size] = matrix[sh.size] || []).push({ id: sh.id, shoe_no: sh.shoe_no, status: sh.status });
    }
    const counts = {};
    for (const sh of shoeRows) counts[sh.status] = (counts[sh.status] || 0) + 1;
    const shortageSizes = Object.entries(matrix)
      .filter(([, list]) => list.every(x => x.status !== 'available'))
      .map(([size]) => Number(size));

    const batches = all('SELECT * FROM disinfection_batches ORDER BY id DESC LIMIT 10').map(b => ({
      ...b,
      items: all(`SELECT sh.shoe_no, sh.size, sh.status FROM disinfection_items di
                  JOIN shoes sh ON sh.id = di.shoe_id WHERE di.batch_id=? ORDER BY sh.shoe_no`, b.id),
    }));

    const payments = all(`SELECT p.*, s.id AS session_id, qg.group_no FROM payments p
                          JOIN sessions s ON s.id = p.session_id
                          JOIN queue_groups qg ON qg.id = s.group_id
                          ORDER BY p.id DESC LIMIT 30`);
    const reviews = all(`SELECT r.*, p.amount_cents AS payment_amount, p.session_id FROM reviews r
                         JOIN payments p ON p.id = r.payment_id
                         ORDER BY (r.status='pending') DESC, r.id DESC LIMIT 20`);

    const faults = all('SELECT * FROM faults ORDER BY id DESC LIMIT 20').map(f => ({
      ...f,
      lane_name: (get('SELECT name FROM lanes WHERE id=?', f.lane_id) || {}).name || '?',
      affected_session: f.status === 'open'
        ? (get("SELECT id FROM sessions WHERE lane_id=? AND status='active'", f.lane_id) || {}).id || null
        : null,
    }));

    const events = all('SELECT * FROM events ORDER BY id DESC LIMIT 60').map(e => ({
      ...e, payload: JSON.parse(e.payload || '{}'),
    }));

    const scorer = {};
    for (const l of lanes) scorer[l.id] = adapters.scorer.status(l.id).status;

    return {
      now: nowIso(),
      config: { game_min: GAME_MIN, call_timeout_sec: callTimeoutSec, per_game_cents: PER_GAME_CENTS, extra_game_cents: EXTRA_GAME_CENTS },
      packages: all('SELECT * FROM packages ORDER BY games'),
      desks: all('SELECT * FROM desks ORDER BY id'),
      lanes: lanes.map(l => ({
        ...l,
        active_session: (activeSessions.find(s => s.lane_id === l.id) || {}).id || null,
        open_fault: (get("SELECT id FROM faults WHERE lane_id=? AND status='open'", l.id) || {}).id || null,
        scorer: scorer[l.id],
      })),
      queue: {
        waiting: waiting.map(g => ({ ...g, est_wait_min: estWaitMin(g) })),
        called: all("SELECT * FROM queue_groups WHERE status='called' ORDER BY called_at"),
        missed: all("SELECT * FROM queue_groups WHERE status='missed' ORDER BY id DESC LIMIT 10"),
      },
      sessions: {
        active: activeSessions.map(sessionView),
        finished: all("SELECT * FROM sessions WHERE status='finished' ORDER BY ended_at DESC LIMIT 20").map(sessionView),
      },
      shoes: { matrix, counts, shortage_sizes: shortageSizes },
      disinfection: {
        pending: all("SELECT * FROM shoes WHERE status='pending_disinfection' ORDER BY shoe_no"),
        batches,
      },
      faults,
      lane_changes: all(`SELECT lc.*, f.name AS from_name, t.name AS to_name FROM lane_changes lc
                         JOIN lanes f ON f.id = lc.from_lane_id JOIN lanes t ON t.id = lc.to_lane_id
                         ORDER BY lc.id DESC LIMIT 10`),
      payments,
      reviews,
      events,
    };
  }

  return {
    takeNumber, callGroup, callNext, missGroup, requeueGroup, cancelGroup, sweepMissed,
    openSession, addPlayer, recordEvent, finishSession,
    returnShoes, startDisinfection, completeDisinfection,
    reportFault, resolveFault, changeLane,
    checkout, decideReview, refund,
    refreshDurations, getState,
    _billing: { billAmount, PER_GAME_CENTS, EXTRA_GAME_CENTS, GAME_MIN },
  };
}

module.exports = { createServices, ApiError };
