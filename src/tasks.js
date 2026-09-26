'use strict';
// 进程内后台任务：定时扫描过号、刷新场次时长快照。
// 不依赖外部调度器，随服务进程启动/停止。
function startTasks(services, { intervalMs = 5000 } = {}) {
  const timer = setInterval(() => {
    try {
      services.sweepMissed(new Date());
      services.refreshDurations(new Date());
    } catch (e) {
      console.error('[tasks] tick error:', e.message);
    }
  }, intervalMs);
  timer.unref();
  // 启动即跑一次，保证状态立即可用
  services.refreshDurations(new Date());
  return {
    stop() { clearInterval(timer); },
  };
}

module.exports = { startTasks };
