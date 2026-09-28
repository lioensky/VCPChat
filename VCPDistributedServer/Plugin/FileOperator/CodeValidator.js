// VCPDistributedServer/Plugin/FileOperator/CodeValidator.js
// 兼容层：校验逻辑已迁移至共享模块 shared/fileKit/validator.js。
// 迁移后的改进：Python 校验改用 execFileSync 参数数组（消除命令注入）、
// 解析真实错误行号；JS 自动区分 module/commonjs；新增 JSON 校验；校验器懒加载。
'use strict';

const { validateCode } = require('../../shared/fileKit/validator');

module.exports = {
  validateCode,
};