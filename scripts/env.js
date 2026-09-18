/**
 * 统一凭据加载器（供 scripts/ 下的 Node CLI 使用）
 *
 * 密码只保存在项目根目录的 .env.local（已被 .gitignore 忽略），
 * 源码里不再出现任何硬编码密码。
 *
 * 用法：
 *   const { requirePassword, basicAuth, user } = require('./env');
 *   const PASSWORD = requirePassword();  // 未配置时打印提示并退出
 */
const path = require('path');

// 复用 Next.js 使用同一个 .env.local，保证凭据只有一个来源
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local'), quiet: true });

const user = process.env.NEO4J_USER || 'neo4j';
const password = process.env.NEO4J_PASSWORD || '';
const uri = process.env.NEO4J_URI || 'bolt://127.0.0.1:7687';
const httpUrl = process.env.NEO4J_HTTP_URL || 'http://localhost:7474';

/** 取密码；未配置时给出明确提示并退出，避免用空密码去连数据库 */
function requirePassword() {
  if (!password) {
    console.error('[env] 缺少 NEO4J_PASSWORD：请在项目根目录 .env.local 中配置，例如：');
    console.error('      NEO4J_PASSWORD=<你的密码>');
    process.exit(1);
  }
  return password;
}

/** HTTP 事务端点用的 Basic 认证头 */
function basicAuth() {
  return 'Basic ' + Buffer.from(`${user}:${requirePassword()}`).toString('base64');
}

module.exports = { user, password, uri, httpUrl, requirePassword, basicAuth };
