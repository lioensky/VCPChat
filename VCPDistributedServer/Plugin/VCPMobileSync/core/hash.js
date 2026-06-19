/**
 * 哈希计算工具
 */

const crypto = require("crypto");

/**
 * 稳定序列化 JSON 对象 (按 key 排序)
 * @param {any} obj - 要序列化的对象
 * @param {string} key - 当前处理的 key (用于特殊类型处理)
 * @returns {string} 稳定的 JSON 字符串
 */
function stableStringify(obj, key = "") {
  if (obj === null) return "null";

  if (typeof obj === "number") {
    // 模拟 Rust serde_json 的 Number.to_string()
    // 对于 AgentConfig 中的 temperature (f64)，如果是整数值，Rust 会输出 "1.0"
    if (key === "temperature" && Number.isInteger(obj)) {
      return obj.toFixed(1);
    }
    return obj.toString();
  }

  if (typeof obj === "boolean") {
    return obj.toString();
  }

  if (typeof obj === "string") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return "[" + obj.map((v) => stableStringify(v)).join(",") + "]";
  }

  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys
        .map((k) => `"${k}":${stableStringify(obj[k], k)}`)
        .join(",") +
      "}"
    );
  }

  return JSON.stringify(obj);
}

/**
 * 计算二进制数据的 SHA-256 哈希
 * @param {Buffer} buffer - 二进制数据
 * @returns {string} 十六进制哈希值
 */
function computeBinaryHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * 计算消息指纹 (仅 content + 附件哈希)
 * @param {object} msg - 消息对象
 * @returns {string} SHA-256 哈希
 */
function computeMessageFingerprint(msg) {
  const attachmentHashes = (msg.attachments || [])
    .map((att) => {
      if (att.hash) return att.hash;
      if (att._fileManagerData && att._fileManagerData.hash)
        return att._fileManagerData.hash;
      return "";
    })
    .filter((h) => !!h)
    .sort();

  const fingerprintObj = {
    content: msg.content || "",
  };
  if (attachmentHashes.length > 0) {
    fingerprintObj.attachmentHashes = attachmentHashes;
  }

  return crypto
    .createHash("sha256")
    .update(stableStringify(fingerprintObj))
    .digest("hex");
}

/**
 * 计算 DTO 哈希
 * @param {object} dto - DTO 对象
 * @param {string[]} fields - 字段白名单
 * @returns {string} SHA-256 哈希
 */
function computeDtoHash(dto, fields) {
  const filtered = {};
  fields.forEach((field) => {
    const val = dto[field];
    // 跳过 undefined 和 null，与手机端 serde(skip_serializing_if = "Option::is_none") 对齐
    if (val !== undefined && val !== null) {
      filtered[field] = val;
    }
  });
  // 对 temperature 统一格式化到2位小数，消除 f32/f64 精度差异
  if (typeof filtered.temperature === "number") {
    filtered.temperature = Math.round(filtered.temperature * 100) / 100;
  }
  return crypto
    .createHash("sha256")
    .update(stableStringify(filtered))
    .digest("hex");
}

/**
 * 计算聚合哈希 (Merkle Root)
 * @param {string[]} hashes - 哈希数组
 * @returns {string} 聚合哈希
 */
function computeAggregatedHash(hashes) {
  if (!hashes || hashes.length === 0) {
    return "";
  }
  const sorted = [...hashes].sort();
  return crypto.createHash("sha256").update(sorted.join("")).digest("hex");
}

module.exports = {
  stableStringify,
  computeBinaryHash,
  computeMessageFingerprint,
  computeDtoHash,
  computeAggregatedHash,
};
