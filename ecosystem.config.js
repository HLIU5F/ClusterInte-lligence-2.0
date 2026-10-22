/**
 * PM2 配置 —— 云服务器低内存部署
 *
 * 用法（在项目根目录）：
 *   bash scripts/server_migrate.sh prepare   # 回填真实数据 + 生成 .env.local
 *   bash scripts/build.sh                   # pnpm install + next build + tsup 打包 server
 *   pm2 start ecosystem.config.js
 *   pm2 logs nextjs-app
 *
 * 内存受限时可以调小堆上限（默认 512MB，与历史配置保持一致）：
 *   NODE_MAX_OLD_SPACE=384 pm2 restart ecosystem.config.js --update-env
 *
 * 注意：
 *   - cwd 用 __dirname，不再硬编码 /root/deploy-package（旧路径会导致 pm2 找不到 dist/server.js）
 *   - instances: 1：小内存机器上多实例会各自占一份堆，极易 OOM
 *   - .env.local 由 Next 在 app.prepare() 阶段自动加载，无需在此重复声明敏感变量
 */

const maxOldSpace = process.env.NODE_MAX_OLD_SPACE || '512';

module.exports = {
  apps: [{
    name: 'nextjs-app',
    script: './dist/server.js',
    cwd: __dirname,
    node_args: `--max-old-space-size=${maxOldSpace}`,
    instances: 1,
    exec_mode: 'fork',
    env: {
      COZE_PROJECT_ENV: 'PROD',
      NODE_ENV: 'production',
      PORT: process.env.PORT || 5000,
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
  }],
};
