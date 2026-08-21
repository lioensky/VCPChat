/**
 * 内存键值锁 (Key-based Async Mutex)
 * 用于序列化并发读写同一物理文件的操作，防止并发 Lost Update 及文件损坏
 */

const activeLocks = new Map();

/**
 * 获取指定键的锁
 * @param {string} key - 锁的标识键 (通常是文件绝对路径或唯一 ID)
 * @returns {Promise<function>} 释放锁的回调函数
 */
async function acquireLock(key) {
  while (activeLocks.has(key)) {
    await activeLocks.get(key);
  }

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  activeLocks.set(key, promise);

  return () => {
    activeLocks.delete(key);
    resolveFn();
  };
}

module.exports = {
  acquireLock,
};
