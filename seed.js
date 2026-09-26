'use strict'
// 种子数据：基础档案 + 演示场景（高峰排队 / 故障换道 / 球鞋缺码）。
// 用法：node seed.js --demo   重置 data/bowling.db 并写入演示数据。
const path = require('path');
const fs = require('fs');
const { openDb } = require('./src/db');

function isSeeded(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM lanes').get().c > 0;
}

// 基础档案：前台、套餐、球道、球鞋、保龄球
function seedBase(db) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  db.exec('BEGIN');
  try {
    run('INSERT INTO desks(id, name) VALUES(1, ?)', '前台A');
    run('INSERT INTO desks(id, name) VALUES(2, ?)', '前台B');

    run('INSERT INTO packages(id, name, games, price_cents) VALUES(1, ?, 1, 2500)', '单局体验');
    run('INSERT INTO packages(id, name, games, price_cents) VALUES(2, ?, 2, 4500)', '双局畅打');
    run('INSERT INTO packages(id, name, games, price_cents) VALUES(3, ?, 3, 6000)', '三局尽兴');

    // 8 条并列球道，1-4 号道带护栏（家庭/儿童区）
    for (let i = 1; i <= 8; i++) {
      run('INSERT INTO lanes(id, name, position, bumper_capable) VALUES(?, ?, ?, ?)',
        i, `${i}号道`, i, i <= 4 ? 1 : 0);
    }

    // 球鞋：34-46 码；40 码仅 2 双（演示缺码），其余 3 双
    for (let size = 34; size <= 46; size++) {
      const n = size === 40 ? 2 : 3;
      for (let i = 1; i <= n; i++) {
        run("INSERT INTO shoes(shoe_no, size) VALUES(?, ?)", `B${size}-${i}`, size);
      }
    }

    // 保龄球：6-16 磅
    for (let w = 6; w <= 16; w++) {
      const n = w >= 9 && w <= 12 ? 3 : 2;
      for (let i = 1; i <= n; i++) {
        run('INSERT INTO balls(ball_no, weight) VALUES(?, ?)', `P${w}-${i}`, w);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 演示场景：高峰排队 + 故障换道 + 球鞋缺码 + 消毒周转 + 待复核
function seedDemo(db, services, adapters) {
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

  // --- 高峰排队：12 组等待 ---
  const waiting = [
    ['张伟', 4, 0, 2], ['李娜', 2, 0, 1], ['王强', 5, 1, 3], ['刘洋', 3, 0, 2],
    ['陈静', 2, 1, 2], ['杨帆', 6, 0, 3], ['赵敏', 3, 0, 1], ['周杰', 4, 0, 2],
    ['吴倩', 2, 0, 1], ['郑浩', 5, 1, 2], ['孙八', 2, 0, 1], ['钱多多', 4, 0, 3],
  ];
  for (const [name, size, bumper, pkg] of waiting) {
    services.takeNumber({ customer_name: name, phone: '138****' + String(1000 + size * 111), party_size: size, need_bumper: bumper, package_id: pkg }, 1);
  }

  // --- 进行中场次（含换道样例、缺码样例）---
  const open = (name, size, bumper, pkg, lane, shoeSizes, balls, minutesAgo, desk) => {
    const g = services.takeNumber({ customer_name: name, party_size: size, need_bumper: bumper, package_id: pkg }, desk);
    services.callGroup(g.id, desk);
    const s = services.openSession({
      group_id: g.id, lane_id: lane, desk_id: desk,
      shoe_sizes: shoeSizes, ball_weights: balls, bumper_used: bumper,
    });
    // 让开局时间有先有后，时长估算更真实
    run('UPDATE sessions SET started_at=? WHERE id=?', minAgo(minutesAgo), s.id);
    run('UPDATE lane_slots SET started_at=? WHERE session_id=?', minAgo(minutesAgo), s.id);
    return s;
  };

  open('马丽', 2, 1, 2, 1, [36, 37], [8, 9], 32, 1);          // 1号道（护栏）
  open('黄志强', 2, 0, 2, 2, [40, 40], [10, 11], 25, 2);      // 2号道：租走全部 40 码 → 缺码样例
  open('徐小明', 2, 1, 1, 3, [34, 35], [7, 8], 18, 1);        // 3号道：随后故障 → 换道样例
  open('高翔', 3, 0, 3, 5, [41, 42, 43], [10, 11, 12], 40, 2);
  open('林芳', 4, 0, 2, 6, [42, 43, 44, 45], [9, 10, 11, 12], 12, 1);

  // 故障换道样例：3号道摆瓶机卡瓶，受影响订单保留
  services.reportFault({ lane_id: 3, type: 'pin_jam', note: '摆瓶机卡瓶，等待换道' }, 1);

  // 球鞋缺码样例：孙八需要 2 双 40 码，全部租出 → 记录缺码事件
  const sun = db.prepare("SELECT * FROM queue_groups WHERE customer_name='孙八'").get();
  services.callGroup(sun.id, 2);
  try {
    services.openSession({ group_id: sun.id, lane_id: 4, desk_id: 2, shoe_sizes: [40, 40], ball_weights: [10, 10] });
  } catch (e) { /* 预期缺码，事件已记录 */ }

  // --- 过号样例 ---
  const zhao = db.prepare("SELECT * FROM queue_groups WHERE customer_name='赵敏'").get();
  services.callGroup(zhao.id, 1);
  services.missGroup(zhao.id, 1);

  // --- 已结束待结账 + 待消毒球鞋 ---
  const done1 = open('王五', 2, 0, 2, 7, [38, 39], [10, 10], 95, 1);
  services.finishSession({ session_id: done1.id, actual_games: 2, desk_id: 1 });
  services.returnShoes({ session_id: done1.id, desk_id: 1, items: [
    { shoe_id: db.prepare("SELECT id FROM shoes WHERE shoe_no='B38-1'").get().id },
    { shoe_id: db.prepare("SELECT id FROM shoes WHERE shoe_no='B39-1'").get().id },
  ] });

  // --- 已支付样例 ---
  const done2 = open('赵六', 3, 0, 1, 8, [41, 42, 44], [9, 10, 11], 130, 2);
  services.finishSession({ session_id: done2.id, actual_games: 1, desk_id: 2 });
  services.checkout({ session_id: done2.id, desk_id: 2, method: 'wechat', idempotency_key: 'SEED-PAY-1' });

  // --- 赔付待复核样例：还鞋时报损 ---
  const done3 = open('淘气包一家', 2, 1, 1, 4, [34, 35], [6, 7], 60, 1);
  services.finishSession({ session_id: done3.id, actual_games: 1, desk_id: 1 });
  const dmgShoe = db.prepare("SELECT id FROM shoes WHERE shoe_no='B34-2'").get();
  services.returnShoes({ session_id: done3.id, desk_id: 1, items: [
    { shoe_id: dmgShoe.id, damaged: true, note: '鞋头开胶' },
  ] });
  services.checkout({ session_id: done3.id, desk_id: 1, method: 'cash', idempotency_key: 'SEED-PAY-2', comp_cents: 20000, comp_reason: '球鞋 B34-2 鞋头开胶赔付' });

  // --- 消毒周转样例：先开一批（收走刚归还的），再补几双待消毒 ---
  const batch = services.startDisinfection({ operator: '老周' });
  run('UPDATE disinfection_batches SET started_at=? WHERE id=?', minAgo(8), batch.id);
  run("UPDATE shoes SET status='pending_disinfection' WHERE shoe_no IN ('B44-2','B45-2','B41-2')");

  // --- 计分器中断样例：5号道 ---
  adapters.scorer.interrupt(5);
  const s5 = db.prepare("SELECT id FROM sessions WHERE lane_id=5 AND status='active'").get();
  if (s5) services.recordEvent({ session_id: s5.id, type: 'scorer_interrupt', payload: { lane_id: 5 }, desk_id: 2 });
}

if (require.main === module) {
  const demo = process.argv.includes('--demo');
  const dbPath = path.join(__dirname, 'data', 'bowling.db');
  if (demo) for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + s); } catch { /* ignore */ } }
  const db = openDb(dbPath);
  if (!isSeeded(db)) seedBase(db);
  if (demo) {
    const { createAdapters } = require('./src/adapters');
    const { createServices } = require('./src/services');
    const adapters = createAdapters();
    const services = createServices(db, adapters, {});
    seedDemo(db, services, adapters);
    console.log('演示数据已写入 data/bowling.db（高峰排队 / 故障换道 / 球鞋缺码）');
  } else {
    console.log('基础档案已写入 data/bowling.db');
  }
}

module.exports = { seedBase, seedDemo, isSeeded };
