'use strict';
// 模拟适配器：计分器与付款网关。真实部署时替换为硬件/支付渠道实现。
// 付款适配器按幂等键去重，模拟网关侧的幂等语义。

class PaymentAdapter {
  constructor() {
    this.charges = new Map();  // idempotency_key -> receipt
    this.refunds = new Map();  // refund_key -> receipt
    this.failNextCharge = false;
  }
  charge(key, amountCents) {
    if (this.charges.has(key)) return this.charges.get(key);
    if (this.failNextCharge) {
      this.failNextCharge = false;
      throw new Error('PAY_GATEWAY_DOWN');
    }
    const receipt = {
      txn_id: 'TXN-' + String(this.charges.size + 1).padStart(4, '0'),
      amount_cents: amountCents,
      status: 'succeeded',
    };
    this.charges.set(key, receipt);
    return receipt;
  }
  refund(key, txnId, amountCents) {
    if (this.refunds.has(key)) return this.refunds.get(key);
    const receipt = {
      refund_id: 'RFD-' + String(this.refunds.size + 1).padStart(4, '0'),
      txn_id: txnId,
      amount_cents: amountCents,
      status: 'succeeded',
    };
    this.refunds.set(key, receipt);
    return receipt;
  }
}

class ScorerAdapter {
  constructor() {
    this.down = new Set();   // 计分器中断的球道
    this.seed = 7;
  }
  _rand() { // 确定性伪随机，便于演示与测试
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648;
    return this.seed / 2147483648;
  }
  status(laneId) {
    if (this.down.has(laneId)) {
      return { lane_id: laneId, status: 'interrupted', frames: [] };
    }
    const frames = [];
    for (let i = 0; i < 10; i++) {
      const a = Math.floor(this._rand() * 11);
      const b = Math.floor(this._rand() * (11 - a));
      frames.push([a, b]);
    }
    return { lane_id: laneId, status: 'ok', frames };
  }
  interrupt(laneId) { this.down.add(laneId); }
  restore(laneId) { this.down.delete(laneId); }
}

function createAdapters() {
  return { payment: new PaymentAdapter(), scorer: new ScorerAdapter() };
}

module.exports = { createAdapters, PaymentAdapter, ScorerAdapter };
