'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { ApiError } = require('../errors');
class ProcessorPool {
  constructor(limits, { onStart = () => {} } = {}) {
    this.limits = limits; this.onStart = onStart; this.pending = []; this.running = new Map(); this.closed = false;
  }
  assertCapacity() {
    if (this.closed) throw new ApiError(503, 'FILE_ENGINE_STOPPING', '文件服务正在停止');
    if (this.pending.length + this.running.size >= this.limits.maxQueuedJobs + this.limits.maxJobsInFlight) throw new ApiError(429, 'FILE_QUEUE_FULL', '文件处理队列已满，请稍后重试');
  }
  run(job, payload) {
    this.assertCapacity();
    return new Promise((resolve, reject) => { this.pending.push({ job, payload, resolve, reject, cancelled: false }); this.pump(); });
  }
  pump() {
    while (!this.closed && this.running.size < this.limits.maxJobsInFlight && this.pending.length) {
      const item = this.pending.shift(); this.running.set(item.job.id, item);
      this.execute(item).then(item.resolve, item.reject).finally(() => { this.running.delete(item.job.id); this.pump(); });
    }
  }
  async execute(item) {
    this.onStart(item.job);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--max-old-space-size=512', path.join(__dirname, 'worker.js')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      item.child = child; let output = '', tooMuch = false, timedOut = false;
      const timeout = item.payload.operation === 'inspect' ? this.limits.inspectionTimeoutMs : item.payload.operation === 'prepare' ? this.limits.processingTimeoutMs : this.limits.previewTimeoutMs;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => { output += data; if (output.length > 65536) { tooMuch = true; child.kill('SIGKILL'); } });
      child.stderr.resume(); // PDF warnings may include document internals. Never persist them.
      item.done = new Promise(done => child.once('close', done));
      child.once('error', () => { clearTimeout(timer); reject(new ApiError(503, 'FILE_PROCESS_CRASH', '文件处理进程无法启动')); });
      child.once('close', code => {
        clearTimeout(timer);
        if (item.cancelled) return reject(new ApiError(410, 'FILE_EXPIRED', '文件已失效，无法继续处理'));
        if (timedOut) return reject(new ApiError(422, 'FILE_PROCESS_TIMEOUT', '文件处理超时，请简化文件后重试'));
        if (tooMuch || code !== 0) return reject(new ApiError(503, 'FILE_PROCESS_CRASH', '文件处理进程异常，请稍后重试'));
        try {
          const response = JSON.parse(output);
          if (!response.ok) return reject(new ApiError(response.status || 422, response.code, response.message));
          resolve(response.data);
        } catch { reject(new ApiError(503, 'FILE_PROCESS_CRASH', '文件处理进程未返回有效结果')); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(item.payload));
    });
  }
  async cancel(fileId) {
    this.pending = this.pending.filter(item => {
      if (fileId === null || item.job.fileId === fileId) { item.cancelled = true; item.reject(new ApiError(410, 'FILE_EXPIRED', '文件已失效')); return false; }
      return true;
    });
    const waits = [];
    for (const item of this.running.values()) if (fileId === null || item.job.fileId === fileId) {
      item.cancelled = true; item.child?.kill('SIGKILL'); if (item.done) waits.push(item.done);
    }
    await Promise.all(waits);
  }
  async close() { this.closed = true; await this.cancel(null); }
  status() { return { running: this.running.size, queued: this.pending.length, maxConcurrent: this.limits.maxJobsInFlight }; }
}
module.exports = { ProcessorPool };
