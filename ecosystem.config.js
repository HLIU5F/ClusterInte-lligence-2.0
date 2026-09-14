module.exports = {
  apps: [{
    name: 'nextjs-app',
    script: './dist/server.js',
    cwd: '/root/deploy-package',
    node_args: '--max-old-space-size=512',
    env: {
      COZE_PROJECT_ENV: 'PROD'
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000
  }]
}
