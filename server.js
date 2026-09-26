'use strict';
// 入口：node server.js [--demo] [--port 8080]
// 一条命令启动：HTTP API + 静态前端 + 损坏照片目录 + 进程内任务。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openDb } = require('./src/db');
const { createAdapters } = require('./src/adapters');
const { createServices, ApiError } = require('./src/services');
const { startTasks } = require('./src/tasks');
const { seedBase, seedDemo, isSeeded } = require('./seed');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function createApp({ dbPath, demo = false, photosDir, taskIntervalMs } = {}) {
  const dataDir = path.join(__dirname, 'data');
  dbPath = dbPath || path.join(dataDir, 'bowling.db');
  photosDir = photosDir || path.join(dataDir, 'photos');
  if (demo && dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.rmSync(dbPath + suffix); } catch { /* 不存在则忽略 */ }
    }
  }
  const db = openDb(dbPath);
  const adapters = createAdapters();
  const services = createServices(db, adapters, { photosDir });
  if (!isSeeded(db)) seedBase(db);
  if (demo) seedDemo(db, services, adapters);
  const tasks = startTasks(services, { intervalMs: taskIntervalMs || 5000 });

  // 路由表：[method, 正则, handler(params, body)]
  const routes = [
    ['GET', /^\/api\/state$/, () => services.getState()],
    ['POST', /^\/api\/queue$/, (p, b) => services.takeNumber(b, b.desk_id)],
    ['POST', /^\/api\/queue\/call-next$/, (p, b) => services.callNext(b.desk_id, b.need_bumper ?? null)],
    ['POST', /^\/api\/queue\/(\d+)\/call$/, (p, b) => services.callGroup(+p[1], b.desk_id)],
    ['POST', /^\/api\/queue\/(\d+)\/miss$/, (p, b) => services.missGroup(+p[1], b.desk_id)],
    ['POST', /^\/api\/queue\/(\d+)\/requeue$/, (p, b) => services.requeueGroup(+p[1], b.desk_id)],
    ['POST', /^\/api\/queue\/(\d+)\/cancel$/, (p, b) => services.cancelGroup(+p[1], b.desk_id)],
    ['POST', /^\/api\/sessions$/, (p, b) => services.openSession(b)],
    ['POST', /^\/api\/sessions\/(\d+)\/finish$/, (p, b) => services.finishSession({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/sessions\/(\d+)\/return-shoes$/, (p, b) => services.returnShoes({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/sessions\/(\d+)\/add-player$/, (p, b) => services.addPlayer({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/sessions\/(\d+)\/event$/, (p, b) => services.recordEvent({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/sessions\/(\d+)\/change-lane$/, (p, b) => services.changeLane({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/sessions\/(\d+)\/checkout$/, (p, b) => services.checkout({ session_id: +p[1], ...b })],
    ['POST', /^\/api\/lanes\/(\d+)\/fault$/, (p, b) => services.reportFault({ lane_id: +p[1], ...b }, b.desk_id)],
    ['POST', /^\/api\/lanes\/(\d+)\/resolve$/, (p, b) => services.resolveFault(+p[1], b.desk_id)],
    ['POST', /^\/api\/disinfection\/start$/, (p, b) => services.startDisinfection(b)],
    ['POST', /^\/api\/disinfection\/(\d+)\/complete$/, (p) => services.completeDisinfection(+p[1])],
    ['POST', /^\/api\/payments\/(\d+)\/refund$/, (p, b) => services.refund({ payment_id: +p[1], ...b })],
    ['POST', /^\/api\/reviews\/(\d+)\/decide$/, (p, b) => services.decideReview({ review_id: +p[1], ...b })],
    ['GET', /^\/api\/scorer\/(\d+)$/, (p) => adapters.scorer.status(+p[1])],
    ['POST', /^\/api\/scorer\/(\d+)\/interrupt$/, (p, b) => {
      adapters.scorer.interrupt(+p[1]);
      return services.recordEvent({ session_id: b.session_id || 0, type: 'scorer_interrupt', payload: { lane_id: +p[1] }, desk_id: b.desk_id });
    }],
    ['POST', /^\/api\/scorer\/(\d+)\/restore$/, (p) => { adapters.scorer.restore(+p[1]); return { ok: true }; }],
  ];

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  function serveStatic(res, filePath) {
    let data;
    try { data = fs.readFileSync(filePath); } catch { return false; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
    return true;
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'INTERNAL', message: e.message });
    }
  });

  function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        let body = {};
        if (chunks.length) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return sendJson(res, 400, { error: 'BAD_JSON', message: '请求体不是合法 JSON' }); }
        }
        for (const [method, re, handler] of routes) {
          if (method !== req.method) continue;
          const m = re.exec(pathname);
          if (!m) continue;
          try {
            return sendJson(res, 200, { ok: true, data: handler(m, body) });
          } catch (e) {
            if (e instanceof ApiError) {
              return sendJson(res, e.status, { ok: false, error: e.code, message: e.message, shortage: e.shortage });
            }
            console.error(e);
            return sendJson(res, 500, { ok: false, error: 'INTERNAL', message: e.message });
          }
        }
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: '接口不存在' });
      });
      return;
    }

    // 静态资源：前端 + 损坏照片
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html') {
        if (!serveStatic(res, path.join(PUBLIC_DIR, 'index.html'))) sendJson(res, 404, {});
        return;
      }
      if (pathname.startsWith('/photos/')) {
        const name = path.normalize(pathname.slice('/photos/'.length)).replace(/^(\.\.[/\\])+/, '');
        const fp = path.join(photosDir, name);
        if (!fp.startsWith(photosDir)) return sendJson(res, 403, {});
        if (!serveStatic(res, fp)) sendJson(res, 404, {});
        return;
      }
      const fp = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^([/\\])+/, ''));
      if (fp.startsWith(PUBLIC_DIR) && serveStatic(res, fp)) return;
    }
    sendJson(res, 404, { ok: false, error: 'NOT_FOUND', message: '资源不存在' });
  }

  return { server, db, services, adapters, tasks };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const demo = args.includes('--demo');
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT || 8080);
  const { server } = createApp({ demo });
  server.listen(port, () => {
    console.log(`保龄球馆排队与球鞋消毒周转系统已启动${demo ? '（演示数据）' : ''}`);
    console.log(`  前台界面:  http://localhost:${port}/`);
    console.log(`  状态接口:  http://localhost:${port}/api/state`);
  });
}

module.exports = { createApp };
