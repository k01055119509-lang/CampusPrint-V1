'use strict';
const { createApp } = require('./app');
async function startServer(options = {}) {
  const runtime = await createApp(options);
  try {
    const server = await new Promise((resolve, reject) => { const listener = runtime.app.listen(runtime.config.port, runtime.config.host, () => resolve(listener)); listener.once('error', reject); });
    server.requestTimeout = runtime.config.limits.uploadTimeoutMs + 10000;
    server.headersTimeout = 30000;
    const host = runtime.config.host.includes(':') ? `[${runtime.config.host}]` : runtime.config.host;
    const url = runtime.config.publicOrigin || `http://${host}:${server.address().port}`;
    let closing;
    return { ...runtime, server, url, close() {
      if (!closing) closing = new Promise((resolve, reject) => {
        server.close(async error => { try { await runtime.close(); error ? reject(error) : resolve(); } catch (failure) { reject(failure); } });
        server.closeIdleConnections();
      }); return closing;
    } };
  } catch (error) { await runtime.close(); throw error; }
}
if (require.main === module) {
  startServer().then(runtime => {
    console.log(`CampusPrint V1: ${runtime.url}`);
    const stop = () => runtime.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    // Explicit local pipe control supports a graceful managed stop on Windows,
    // where killing a child process does not deliver Unix signal handlers.
    if (process.argv.includes('--stdin-control')) {
      let input = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; const lines = input.split(/\r?\n/); input = lines.pop(); if (lines.includes('stop')) { process.stdin.destroy(); stop(); } });
    }
  }).catch(error => { console.error('服务启动失败：', error.message); process.exitCode = 1; });
}
module.exports = { startServer };
