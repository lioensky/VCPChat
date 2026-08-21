/**
 * 幂等性控制
 */

const recentOperations = new Map();
const IDEMPOTENCY_TTL = 300000; // 5 minutes

// 自动清理过期的幂等性记录
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [opId, data] of recentOperations.entries()) {
    if (now - data.timestamp > IDEMPOTENCY_TTL) {
      recentOperations.delete(opId);
    }
  }
}, 60000);
cleanupTimer.unref?.();

/**
 * 检查操作是否重复（幂等性检查）
 * @param {string} opId - 操作 ID
 * @returns {{ duplicate: boolean, result?: any, statusCode?: number }}
 */
function checkIdempotency(opId) {
  if (!opId) return { duplicate: false };

  const existing = recentOperations.get(opId);
  if (existing && Date.now() - existing.timestamp < IDEMPOTENCY_TTL) {
    return {
      duplicate: true,
      result: existing.result,
      statusCode: existing.statusCode,
    };
  }
  return { duplicate: false };
}

/**
 * 记录操作结果
 * @param {string} opId - 操作 ID
 * @param {any} result - 操作结果
 * @param {number} statusCode - 原始 HTTP 状态，重放时不得把失败改成 200
 */
function recordOperation(opId, result, statusCode = 200) {
  if (!opId) return;
  recentOperations.set(opId, { timestamp: Date.now(), result, statusCode });
}

module.exports = {
  checkIdempotency,
  recordOperation,
};
