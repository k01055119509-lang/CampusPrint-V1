'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { ApiError, missing, conflict, invalid } = require('../errors');
const { ensureRoot, safePath, removeTree, publishDirectory, id, UUID } = require('./safety');
const { receiveUpload } = require('./upload');
const { validatePageNumbers } = require('./pages');
const { ProcessorPool } = require('./pool');
const { RetentionLedger, validTime } = require('./ledger');
const { pruneBackups } = require('./backups');
const sanitizedError = error => error instanceof ApiError ? error : new ApiError(503, 'FILE_STORAGE_UNAVAILABLE', '文件存储暂不可用，请稍后重试');
class FileService {
  constructor(db, config, options = {}) {
    this.db = db; this.config = config; this.limits = config.limits;
    this.jobs = new Map(); this.activeUploads = new Set(); this.pendingTemporaryCleanup = new Map(); this.stopping = false; this.scan = null;
    // Dependency injection for isolated tests only. No HTTP clock/path/delete injection.
    this.deleteTree = options.deleteTree || removeTree;
    this.backupCleanup = { examined: 0, purged: 0, failures: [] };
    this.activeSnapshots = new Set();
    this.pool = new ProcessorPool(this.limits, { onStart: job => {
      this.db.run("UPDATE file_jobs SET status='running',attempts=attempts+1,updatedAt=? WHERE id=?", this.now(), job.id);
    } });
    this.ledger = new RetentionLedger(config.ledgerRoot, db);
  }
  now() { return this.config.clock().toISOString(); }
  async initialize({ recoverJobs = true } = {}) {
    for (const root of [this.config.fileRoot, this.config.tempRoot, this.config.paymentRoot, this.config.advertisementRoot, this.config.ledgerRoot, this.config.backupRoot]) await ensureRoot(root);
    this.ledger.load(); this.ledger.replay(this.now());
    // A single service instance owns processing. Previous leases no longer denote live work.
    this.db.run('DELETE FROM file_leases');
    for (const name of await fs.readdir(this.config.tempRoot)) await removeTree(this.config.tempRoot, name);
    for (const row of this.db.all("SELECT id FROM files WHERE status='expired' AND purgedAt IS NOT NULL")) {
      try { await safePath(this.config.fileRoot, row.id); this.db.run('UPDATE files SET purgedAt=NULL WHERE id=?', row.id); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await this.purgeExpiredFiles();
    for (const row of recoverJobs ? this.db.all("SELECT * FROM file_jobs WHERE status IN ('queued','running') ORDER BY createdAt,id") : []) {
      const file = this.db.get('SELECT * FROM files WHERE id=?', row.fileId);
      if (!file || this.isExpired(file)) { this.db.run("UPDATE file_jobs SET status='cancelled',updatedAt=? WHERE id=?", this.now(), row.id); continue; }
      if (row.attempts >= this.limits.maxJobAttempts) { this.failJob(row, new ApiError(503, 'FILE_PROCESS_RETRY_LIMIT', '文件处理重试次数已达上限，请重新上传')); continue; }
      this.db.run("UPDATE file_jobs SET status='queued',updatedAt=? WHERE id=?", this.now(), row.id);
      this.startJob(row).catch(() => {});
    }
    // Metadata without its original object is never advertised as a usable upload.
    for (const file of this.db.all("SELECT * FROM files WHERE status IN ('ready','processing')")) {
      try { await safePath(this.config.fileRoot, `${file.id}/original.bin`); }
      catch { this.db.run("UPDATE files SET status='failed',errorCode='FILE_STORAGE_MISSING',errorMessage='原文件缺失，请重新上传' WHERE id=?", file.id); }
    }
    // Remove orphan trees left by a crash between publishing and metadata insertion.
    for (const name of await fs.readdir(this.config.fileRoot)) {
      if (!UUID.test(name) || !this.db.get('SELECT id FROM files WHERE id=?', name)) await removeTree(this.config.fileRoot, name);
    }
    this.timer = setInterval(() => this.purgeExpiredFiles().catch(() => {}), this.limits.cleanupIntervalMs);
    this.timer.unref();
  }
  flushLedger() {
    try { this.ledger.flush(); } catch { /* Access remains blocked until the outbox can be durably written. */ }
  }
  event(kind, fileId, expiresAt = null, orderId = null) {
    this.db.run('INSERT INTO file_retention_outbox(eventId,kind,fileId,expiresAt,recordedAt,orderId) VALUES(?,?,?,?,?,?)', randomUUID(), kind, fileId, expiresAt, this.now(), orderId);
    this.db.afterCommit(() => this.flushLedger());
  }
  isExpired(row) {
    const fact = this.ledger.facts.get(row.id);
    const temporaryUse = !row.claimedOrderId && this.hasActiveLease(row.id);
    return row.status === 'expired' || !!fact?.revoked || !!(row.expiresAt && row.expiresAt <= this.now() && !temporaryUse) || !!(fact?.expiresAt && fact.expiresAt <= this.now());
  }
  assertLive(row) {
    if (this.ledger.failure) throw new ApiError(503, 'FILE_LEDGER_UNAVAILABLE', '文件期限台账暂不可用，文件访问已暂停');
    if (this.isExpired(row)) throw new ApiError(410, 'FILE_EXPIRED', '文件已过期或已清理，请重新上传后下新单');
  }
  owned(actor, fileId) {
    id(fileId);
    if (!actor?.id || !['user', 'admin'].includes(actor.role)) throw new ApiError(401, 'AUTH_REQUIRED', '请先登录');
    const row = this.db.get('SELECT * FROM files WHERE id=?', fileId);
    if (!row || (actor.role !== 'admin' && row.ownerId !== actor.id)) missing();
    return row;
  }
  fileDto(row) {
    const expired = this.isExpired(row);
    return { id: row.id, originalName: row.originalName, mimeType: row.mimeType, byteSize: row.byteSize,
      sourcePageCount: row.sourcePageCount, sourceSha256: row.sourceSha256,
      status: expired ? 'expired' : row.status,
      error: expired ? null : row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null,
      claimedOrderId: row.claimedOrderId, expiresAt: row.expiresAt, uploadedAt: row.uploadedAt,
      fileAvailability: expired ? row.purgedAt ? 'deleted' : 'expired' : 'available',
      allowedActions: expired ? [] : row.claimedOrderId ? ['preview'] : row.status === 'ready' ? ['preview', 'delete'] : ['delete'] };
  }
  getFile({ actor, fileId }) { return this.fileDto(this.owned(actor, fileId)); }
  getOwnedReadyFile({ userId, fileId, allowClaimedOrderId = null }) {
    const row = this.owned({ id: userId, role: 'user' }, fileId); this.assertLive(row);
    if (row.claimedOrderId && row.claimedOrderId !== allowClaimedOrderId) throw new ApiError(409, 'FILE_ALREADY_CLAIMED', '同一上传只能绑定一笔订单；新订单请重新上传');
    if (row.status === 'processing') throw new ApiError(409, 'FILE_PROCESSING', '文件正在处理，请稍后查询');
    if (row.status !== 'ready') throw new ApiError(422, row.errorCode || 'FILE_PROCESS_FAILED', row.errorMessage || '文件不可打印，请重新上传');
    return this.fileDto(row);
  }
  artifactDto(row) {
    return { artifactId: row.artifactId, fileId: row.fileId, preparationId: row.preparationId,
      pageCount: row.pageCount, sha256: row.sha256, byteSize: row.byteSize,
      mimeType: row.mimeType, paperSize: row.paperSize, colorMode: row.colorMode, copiesInPdf: row.copiesInPdf,
      sourceSha256: this.db.get('SELECT sourceSha256 FROM files WHERE id=?', row.fileId)?.sourceSha256,
      pageNumbers: row.preparationId ? JSON.parse(this.db.get('SELECT pageNumbersJson FROM preparations WHERE preparationId=?', row.preparationId).pageNumbersJson) : null,
      expiresAt: row.expiresAt };
  }
  getPreparation({ userId, preparationId }) {
    const row = this.db.get('SELECT * FROM preparations WHERE preparationId=? AND ownerId=?', preparationId, userId);
    if (!row) missing(); const file = this.db.get('SELECT * FROM files WHERE id=?', row.fileId); this.assertLive(file);
    return { preparationId, status: row.status,
      artifact: row.status === 'ready' ? this.artifactDto(this.db.get('SELECT * FROM artifacts WHERE artifactId=?', row.artifactId)) : null,
      error: row.errorCode ? { code: row.errorCode, message: row.errorMessage } : null };
  }
  quota(userId, newBytes = 0) {
    const personal = this.db.get("SELECT COUNT(*) AS count,COALESCE(SUM(byteSize),0) AS bytes FROM files WHERE ownerId=? AND status!='expired' AND claimedOrderId IS NULL", userId);
    const total = this.db.get("SELECT COALESCE(SUM(byteSize),0) AS bytes FROM files WHERE purgedAt IS NULL");
    const active = this.db.get('SELECT COUNT(*) AS allCount,SUM(CASE WHEN ownerId=? THEN 1 ELSE 0 END) AS ownCount FROM files WHERE purgedAt IS NULL', userId);
    if (personal.count >= this.limits.maxTemporaryFilesPerUser || active.ownCount >= this.limits.maxActiveFilesPerUser || active.allCount >= this.limits.maxTotalActiveFiles || personal.bytes + newBytes > this.limits.maxSourceBytesPerUser || total.bytes + newBytes > this.limits.maxTotalSourceBytes) throw new ApiError(413, 'FILE_STORAGE_QUOTA', '文件数量或存储已达上限，请清理未下单的文件后重试');
  }
  async checkFreeDisk(root, requiredBytes = 0) {
    const volume = await fs.statfs(root);
    if (volume.bavail * volume.bsize < this.limits.minFreeDiskBytes + requiredBytes) throw new ApiError(413, 'FILE_STORAGE_QUOTA', '服务器可用存储不足，请稍后重试');
  }
  assertUploadCapacity() {
    if (this.activeUploads.size >= this.limits.maxUploadsInFlight) throw new ApiError(429, 'UPLOAD_BUSY', '同时上传数量已达上限，请稍后重试');
    this.pool.assertCapacity();
  }
  async upload(req) {
    if (req.user?.role !== 'user') throw new ApiError(403, 'FORBIDDEN', '学生文件仅由普通用户上传');
    this.assertUploadCapacity(); this.quota(req.user.id); await this.checkFreeDisk(this.config.tempRoot, this.limits.maxFileBytes); await this.checkFreeDisk(this.config.fileRoot, this.limits.maxFileBytes);
    const upload = await receiveUpload(req, this.config, { activeUploads: this.activeUploads });
    const fileId = randomUUID(), now = this.now(), expiry = new Date(this.config.clock().getTime() + this.limits.temporaryUploadHours * 3600000).toISOString();
    let inserted = false;
    try {
      const temporary = await safePath(this.config.tempRoot, `${upload.tempName}/original.bin`);
      const directory = await safePath(this.config.fileRoot, fileId, { missing: true }); await fs.mkdir(directory);
      await fs.copyFile(temporary, path.join(directory, 'original.bin'), fs.constants.COPYFILE_EXCL);
      const job = this.db.tx(() => {
        this.pool.assertCapacity(); this.quota(req.user.id, upload.byteSize);
        this.db.run('INSERT INTO files(id,ownerId,originalName,mimeType,byteSize,sourceSha256,status,uploadedAt,temporaryExpiresAt,expiresAt) VALUES(?,?,?,?,?,?,\'processing\',?,?,?)',
          fileId, req.user.id, upload.originalName, upload.mimeType, upload.byteSize, upload.sha256, now, expiry, expiry);
        this.insertArtifact({ fileId, artifactId: randomUUID(), kind: 'original', relativePath: `${fileId}/original.bin`, mimeType: upload.mimeType,
          pageCount: 0, sha256: upload.sha256, byteSize: upload.byteSize });
        return this.newJob(fileId, 'inspect', { }, `inspect:${fileId}`);
      });
      inserted = true; this.startJob(job).catch(() => {});
      return this.fileDto(this.db.get('SELECT * FROM files WHERE id=?', fileId));
    } finally {
      await upload.cleanup(); if (!inserted) await removeTree(this.config.fileRoot, fileId);
    }
  }
  insertArtifact(input) {
    const file = this.db.get('SELECT * FROM files WHERE id=?', input.fileId);
    this.db.run('INSERT INTO artifacts(artifactId,fileId,preparationId,kind,relativePath,mimeType,pageCount,sha256,byteSize,paperSize,colorMode,copiesInPdf,sourcePage,productionPage,createdAt,claimedOrderId,expiresAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      input.artifactId, input.fileId, input.preparationId || null, input.kind, input.relativePath, input.mimeType,
      input.pageCount, input.sha256, input.byteSize, input.paperSize || null, input.colorMode || null, input.copiesInPdf || null,
      input.sourcePage || null, input.productionPage || null, this.now(), file.claimedOrderId, file.expiresAt);
  }
  newJob(fileId, type, args, requestKey) {
    const total = this.db.get("SELECT COUNT(*) AS n FROM file_jobs WHERE status IN ('queued','running')").n;
    if (total >= this.limits.maxQueuedJobs + this.limits.maxJobsInFlight) throw new ApiError(429, 'FILE_QUEUE_FULL', '文件处理队列已满，请稍后重试');
    const count = this.db.get("SELECT COUNT(*) AS n FROM file_jobs WHERE fileId=? AND status IN ('queued','running')", fileId).n;
    if (count >= this.limits.maxJobsPerFile) throw new ApiError(429, 'FILE_BUSY', '此文件的处理任务过多，请稍后重试');
    this.pool.assertCapacity();
    const row = { id: randomUUID(), fileId, type, argsJson: JSON.stringify(args), requestKey, attempts: 0 };
    this.db.run("INSERT INTO file_jobs(id,fileId,type,argsJson,requestKey,status,createdAt,updatedAt) VALUES(?,?,?,?,?,'queued',?,?)", row.id, fileId, type, row.argsJson, requestKey, this.now(), this.now());
    return row;
  }
  startJob(row) {
    if (this.jobs.has(row.id)) return this.jobs.get(row.id).promise;
    const leaseId = randomUUID(), leaseExpires = new Date(this.config.clock().getTime() + 2 * 3600000).toISOString();
    this.db.run('INSERT INTO file_leases VALUES(?,?,?,?)', leaseId, row.fileId, row.type, leaseExpires);
    const promise = this.executeJob(row).catch(error => {
      const publicError = sanitizedError(error);
      if (this.stopping) this.db.run("UPDATE file_jobs SET status='queued',updatedAt=? WHERE id=?", this.now(), row.id);
      else this.failJob(row, publicError);
      throw publicError;
    }).finally(async () => {
      await this.cleanJobTemporary(row.id);
      if (this.db.get('SELECT status FROM file_jobs WHERE id=?', row.id)?.status !== 'ready') {
        for (const relative of [`${row.fileId}/d-${row.id}`, `${row.fileId}/d-${row.id}.partial`]) {
          try { await removeTree(this.config.fileRoot, relative); } catch { /* expiration cleanup owns the complete source tree */ }
        }
      }
      this.db.run('DELETE FROM file_leases WHERE leaseId=?', leaseId); this.jobs.delete(row.id);
    });
    this.jobs.set(row.id, { fileId: row.fileId, promise }); return promise;
  }
  async cleanJobTemporary(jobId) {
    const relative = `job-${jobId}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await removeTree(this.config.tempRoot, relative); this.pendingTemporaryCleanup.delete(jobId); return; }
      catch (error) {
        this.pendingTemporaryCleanup.set(jobId, error.code || 'FILE_DELETE_FAILED');
        if (!['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY'].includes(error.code)) return;
        await delay(25 * (attempt + 1));
      }
    }
  }
  failJob(row, error) {
    const file = this.db.get('SELECT * FROM files WHERE id=?', row.fileId), expired = file && this.isExpired(file);
    this.db.run('UPDATE file_jobs SET status=?,errorCode=?,errorMessage=?,updatedAt=? WHERE id=?', expired ? 'cancelled' : 'failed', error.code, error.message, this.now(), row.id);
    if (row.type === 'inspect' && !expired) this.db.run("UPDATE files SET status='failed',errorCode=?,errorMessage=? WHERE id=?", error.code, error.message, row.fileId);
    if (row.type === 'prepare') this.db.run('UPDATE preparations SET status=?,errorCode=?,errorMessage=? WHERE preparationId=?', expired ? 'expired' : 'failed', error.code, error.message, JSON.parse(row.argsJson).preparationId);
  }
  async inputFor(file, type, args) {
    let artifact;
    if (type === 'production_preview') {
      artifact = this.db.get("SELECT * FROM artifacts WHERE artifactId=? AND fileId=? AND kind='production'", args.printArtifactId, file.id);
      if (!artifact) missing();
    } else if (file.mimeType !== 'application/pdf' && type !== 'inspect') {
      artifact = this.db.get("SELECT * FROM artifacts WHERE fileId=? AND kind='normalized'", file.id);
      if (!artifact) throw new ApiError(409, 'FILE_PROCESSING', '图片尚未完成方向处理');
    } else artifact = this.db.get("SELECT * FROM artifacts WHERE fileId=? AND kind='original'", file.id);
    const objectPath = await safePath(this.config.fileRoot, artifact.relativePath), handle = await fs.open(objectPath, 'r');
    try {
      const digest = createHash('sha256'); for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
      if (digest.digest('hex') !== artifact.sha256) throw new ApiError(503, 'FILE_INTEGRITY_FAILED', '源文件校验失败，请重新上传');
    } finally { await handle.close(); }
    return objectPath;
  }
  async executeJob(row) {
    const args = JSON.parse(row.argsJson), directoryName = `job-${row.id}`, relativeDirectory = `${row.fileId}/d-${row.id}`;
    let result;
    for (;;) {
      const file = this.db.get('SELECT * FROM files WHERE id=?', row.fileId); this.assertLive(file);
      await removeTree(this.config.tempRoot, directoryName);
      const outputDir = await safePath(this.config.tempRoot, directoryName, { missing: true }); await fs.mkdir(outputDir);
      const input = await this.inputFor(file, row.type, args);
      this.assertLive(this.db.get('SELECT * FROM files WHERE id=?', row.fileId));
      try {
        result = await this.pool.run(row, { operation: row.type, input, outputDir, limits: this.limits,
          mimeType: file.mimeType, pageNumbers: args.pageNumbers, page: args.page });
        break;
      } catch (error) {
        const current = this.db.get('SELECT attempts FROM file_jobs WHERE id=?', row.id);
        if (error.code !== 'FILE_PROCESS_CRASH' || current.attempts >= this.limits.maxJobAttempts || this.stopping || this.isExpired(file)) throw error;
        this.db.run("UPDATE file_jobs SET status='queued',updatedAt=? WHERE id=?", this.now(), row.id);
      }
    }
    const current = this.db.get('SELECT * FROM files WHERE id=?', row.fileId); this.assertLive(current);
    const outputDir = await safePath(this.config.tempRoot, directoryName);
    let size = 0;
    for (const name of await fs.readdir(outputDir)) {
      const objectPath = await safePath(this.config.tempRoot, `${directoryName}/${name}`), info = await fs.stat(objectPath);
      if (!info.isFile()) throw new ApiError(500, 'FILE_PROCESS_INVALID_RESULT', '文件处理结果无效'); size += info.size;
    }
    const existingBytes = this.db.get("SELECT COALESCE(SUM(byteSize),0) AS n FROM artifacts WHERE fileId=? AND kind!='original'", row.fileId).n;
    if (existingBytes + size > this.limits.maxDerivedBytes) throw new ApiError(413, 'FILE_OUTPUT_LIMIT', '该文件的派生文件资源已达上限，请减少预览或重新上传');
    const globalBytes = this.db.get("SELECT COALESCE(SUM(a.byteSize),0) AS n FROM artifacts a JOIN files f ON f.id=a.fileId WHERE a.kind!='original' AND f.purgedAt IS NULL").n;
    if (globalBytes + size > this.limits.maxTotalDerivedBytes) throw new ApiError(413, 'FILE_STORAGE_QUOTA', '服务器派生文件存储已达上限，请稍后重试');
    await this.checkFreeDisk(this.config.fileRoot, size);
    if (size) {
      await removeTree(this.config.fileRoot, relativeDirectory);
      await removeTree(this.config.fileRoot, relativeDirectory + '.partial');
      await publishDirectory(this.config.tempRoot, directoryName, this.config.fileRoot, relativeDirectory);
    }
    this.db.tx(() => {
      const file = this.db.get('SELECT * FROM files WHERE id=?', row.fileId); this.assertLive(file);
      const used = this.db.get("SELECT COALESCE(SUM(a.byteSize),0) AS n FROM artifacts a JOIN files f ON f.id=a.fileId WHERE a.kind!='original' AND f.purgedAt IS NULL").n;
      if (used + size > this.limits.maxTotalDerivedBytes) throw new ApiError(413, 'FILE_STORAGE_QUOTA', '服务器派生文件存储已达上限，请稍后重试');
      if (row.type === 'inspect') {
        if (!Number.isSafeInteger(result.sourcePageCount) || result.sourcePageCount < 1 || result.sourcePageCount > this.limits.maxSourcePages) throw new ApiError(422, 'FILE_CORRUPT', '文件真实页数无效');
        this.db.run("UPDATE files SET status='ready',sourcePageCount=?,errorCode=NULL,errorMessage=NULL WHERE id=?", result.sourcePageCount, row.fileId);
        this.db.run("UPDATE artifacts SET pageCount=? WHERE fileId=? AND kind='original'", result.sourcePageCount, row.fileId);
        if (result.normalized) this.insertArtifact({ fileId: row.fileId, artifactId: randomUUID(), kind: 'normalized',
          relativePath: `${relativeDirectory}/${result.normalized.name}`, ...result.normalized, mimeType: 'image/png', pageCount: 1 });
      } else if (row.type === 'prepare') {
        this.insertArtifact({ fileId: row.fileId, artifactId: args.artifactId, kind: 'production', preparationId: args.preparationId,
          relativePath: `${relativeDirectory}/${result.name}`, mimeType: 'application/pdf', pageCount: result.pageCount,
          sha256: result.sha256, byteSize: result.byteSize, paperSize: 'A4', colorMode: 'black_white', copiesInPdf: 1 });
        this.insertArtifact({ fileId: row.fileId, artifactId: randomUUID(), kind: 'production_preview', preparationId: args.preparationId,
          relativePath: `${relativeDirectory}/${result.preview.name}`, mimeType: 'image/png', pageCount: 1,
          sha256: result.preview.sha256, byteSize: result.preview.byteSize, paperSize: 'A4', colorMode: 'black_white', productionPage: 1 });
        this.db.run("UPDATE preparations SET status='ready',artifactId=?,errorCode=NULL,errorMessage=NULL WHERE preparationId=?", args.artifactId, args.preparationId);
      } else {
        this.insertArtifact({ fileId: row.fileId, artifactId: args.artifactId, kind: row.type, preparationId: args.preparationId,
          relativePath: `${relativeDirectory}/${result.name}`, mimeType: 'image/png', pageCount: 1,
          sha256: result.sha256, byteSize: result.byteSize, paperSize: 'A4', colorMode: 'black_white',
          sourcePage: row.type === 'source_preview' ? args.page : null, productionPage: row.type === 'production_preview' ? args.page : null });
      }
      this.db.run("UPDATE file_jobs SET status='ready',errorCode=NULL,errorMessage=NULL,updatedAt=? WHERE id=?", this.now(), row.id);
    });
    return row.type === 'prepare' ? this.artifactDto(this.db.get('SELECT * FROM artifacts WHERE artifactId=?', args.artifactId)) : result;
  }
  async preparePrintItem({ userId, fileId, pageNumbers, preparationId }) {
    const file = this.getOwnedReadyFile({ userId, fileId });
    pageNumbers = validatePageNumbers(pageNumbers, file.sourcePageCount, this.limits.maxPreparedPages);
    if (typeof preparationId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(preparationId)) invalid('preparationId', '使用 1–100 位稳定准备任务标识');
    const serialized = JSON.stringify(pageNumbers);
    let preparation = this.db.get('SELECT * FROM preparations WHERE preparationId=?', preparationId), job;
    if (preparation) {
      if (preparation.fileId !== fileId || preparation.ownerId !== userId || preparation.pageNumbersJson !== serialized) throw new ApiError(409, 'PREPARATION_CONFLICT', '同一准备任务标识不能对应不同文件或页码');
      if (preparation.status === 'ready') return this.artifactDto(this.db.get('SELECT * FROM artifacts WHERE artifactId=?', preparation.artifactId));
      if (preparation.status !== 'processing') throw new ApiError(422, preparation.errorCode || 'FILE_PROCESS_FAILED', preparation.errorMessage || '生产文件准备失败，请重新上传');
      job = this.db.get('SELECT * FROM file_jobs WHERE requestKey=?', `prepare:${preparationId}`);
    } else {
      job = this.db.tx(() => {
        this.getOwnedReadyFile({ userId, fileId });
        this.db.run("INSERT INTO preparations(preparationId,fileId,ownerId,pageNumbersJson,status,createdAt) VALUES(?,?,?,?,'processing',?)", preparationId, fileId, userId, serialized, this.now());
        return this.newJob(fileId, 'prepare', { preparationId, pageNumbers, artifactId: randomUUID() }, `prepare:${preparationId}`);
      });
    }
    return this.startJob(job);
  }
  async sourcePreview({ actor, fileId, page = 1 }) {
    const file = this.owned(actor, fileId); this.assertLive(file);
    if (file.status !== 'ready') throw new ApiError(file.status === 'processing' ? 409 : 422, file.errorCode || 'FILE_PROCESSING', file.errorMessage || '文件尚不可预览，请查看处理状态');
    validatePageNumbers([page], file.sourcePageCount);
    let artifact = this.db.get("SELECT * FROM artifacts WHERE fileId=? AND kind='source_preview' AND sourcePage=?", fileId, page);
    if (!artifact) {
      await this.previewJob(file, 'source_preview', { page, artifactId: randomUUID() }, `source:${fileId}:${page}`);
      artifact = this.db.get("SELECT * FROM artifacts WHERE fileId=? AND kind='source_preview' AND sourcePage=?", fileId, page);
    }
    return this.openArtifactForRead({ actor, artifactId: artifact.artifactId, purpose: 'preview' });
  }
  async previewJob(file, type, args, key) {
    let job = this.db.get('SELECT * FROM file_jobs WHERE requestKey=?', key);
    if (job && ['failed', 'cancelled'].includes(job.status)) throw new ApiError(422, job.errorCode || 'FILE_PROCESS_FAILED', job.errorMessage || '预览生成失败，请重新上传');
    if (!job) job = this.db.tx(() => this.newJob(file.id, type, args, key));
    await this.startJob(job);
  }
  async openArtifactForRead({ actor, artifactId, purpose = 'production', page = 1 }) {
    id(artifactId);
    let artifact = this.db.get('SELECT * FROM artifacts WHERE artifactId=?', artifactId);
    if (!artifact) missing(); const file = this.owned(actor, artifact.fileId); this.assertLive(file);
    if (!['production', 'preview', 'original'].includes(purpose)) invalid('purpose', '文件读取用途无效');
    if (purpose === 'original' && artifact.kind !== 'original') missing();
    if (purpose === 'production' && artifact.kind !== 'production') missing();
    let productionHash = null;
    if (purpose === 'preview') {
      if (artifact.kind === 'production') {
        validatePageNumbers([page], artifact.pageCount);
        productionHash = artifact.sha256;
        let preview = this.db.get("SELECT * FROM artifacts WHERE preparationId=? AND kind='production_preview' AND productionPage=?", artifact.preparationId, page);
        if (!preview) {
          await this.previewJob(file, 'production_preview', { page, printArtifactId: artifact.artifactId,
            preparationId: artifact.preparationId, artifactId: randomUUID() }, `preview:${artifact.artifactId}:${page}`);
          preview = this.db.get("SELECT * FROM artifacts WHERE preparationId=? AND kind='production_preview' AND productionPage=?", artifact.preparationId, page);
        }
        artifact = preview;
      } else if (!['source_preview', 'production_preview'].includes(artifact.kind)) missing();
      if (artifact.preparationId) productionHash ||= this.db.get("SELECT sha256 FROM artifacts WHERE preparationId=? AND kind='production'", artifact.preparationId)?.sha256;
    }
    this.assertLive(this.db.get('SELECT * FROM files WHERE id=?', file.id));
    const objectPath = await safePath(this.config.fileRoot, artifact.relativePath);
    let handle;
    try {
      handle = await fs.open(objectPath, 'r');
      const stat = await handle.stat(); if (!stat.isFile() || stat.nlink > 1 || stat.size !== artifact.byteSize) throw new ApiError(503, 'FILE_INTEGRITY_FAILED', '文件校验失败，请联系管理员');
      const digest = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) digest.update(chunk);
      if (digest.digest('hex') !== artifact.sha256) throw new ApiError(503, 'FILE_INTEGRITY_FAILED', '文件校验失败，请联系管理员');
      this.assertLive(this.db.get('SELECT * FROM files WHERE id=?', file.id));
      return { handle, mimeType: artifact.mimeType, byteSize: artifact.byteSize, sha256: artifact.sha256,
        expiresAt: this.db.get('SELECT expiresAt FROM files WHERE id=?', file.id).expiresAt,
        productionSha256: productionHash || (artifact.kind === 'production' ? artifact.sha256 : null),
        filename: artifact.kind === 'production' ? `campus-print-${file.id}.pdf` : artifact.kind === 'original' ? file.originalName : `preview-${file.id}.png`,
        checkAccess: () => this.assertLive(this.db.get('SELECT * FROM files WHERE id=?', file.id)) };
    } catch (error) { await handle?.close(); throw sanitizedError(error); }
  }
  claimForOrder({ orderId, userId, items }) {
    if (!this.db.inTransaction) throw new Error('claimForOrder must run in the order creation db.tx');
    if (typeof orderId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(orderId) || !Array.isArray(items) || !items.length || items.length > 100) invalid('items', '订单文件认领参数无效');
    const checked = [], artifactIds = new Set();
    for (const item of items) {
      const file = this.getOwnedReadyFile({ userId, fileId: item.fileId });
      const artifact = this.db.get("SELECT * FROM artifacts WHERE artifactId=? AND fileId=? AND kind='production'", item.printArtifactId, item.fileId);
      if (!artifact || artifactIds.has(item.printArtifactId)) throw new ApiError(409, 'FILE_ARTIFACT_MISMATCH', '必须认领属于该文件的、已准备好的唯一生产文件');
      artifactIds.add(item.printArtifactId); checked.push({ fileId: file.id, artifactId: item.printArtifactId });
    }
    const fileIds = [...new Set(checked.map(item => item.fileId))];
    for (const fileId of fileIds) {
      const changed = this.db.run('UPDATE files SET claimedOrderId=?,expiresAt=NULL WHERE id=? AND claimedOrderId IS NULL', orderId, fileId);
      if (changed.changes !== 1) throw new ApiError(409, 'FILE_ALREADY_CLAIMED', '文件已被另一笔订单认领');
      this.db.run('UPDATE artifacts SET claimedOrderId=?,expiresAt=NULL WHERE fileId=?', orderId, fileId);
      this.event('claim', fileId, null, orderId);
    }
    return { orderId, fileIds, items: checked };
  }
  setOrderFileExpiry({ orderId, expiresAt }) {
    if (!this.db.inTransaction) throw new Error('setOrderFileExpiry must run in the delivery confirmation db.tx');
    if (!validTime(expiresAt)) invalid('expiresAt', '使用规范 ISO 8601 UTC 时间');
    const files = this.db.all('SELECT * FROM files WHERE claimedOrderId=?', orderId); if (!files.length) missing();
    for (const file of files) {
      if (file.expiresAt && file.expiresAt !== expiresAt) throw new ApiError(409, 'FILE_EXPIRY_IMMUTABLE', '已记录的文件期限不能重算或延长');
      const fact = this.ledger.facts.get(file.id);
      if (fact?.revoked || (fact?.expiresAt && fact.expiresAt !== expiresAt)) throw new ApiError(410, 'FILE_EXPIRED', '文件已有失效或清理事实，不能重新开放');
      this.db.run('UPDATE files SET expiresAt=? WHERE id=?', expiresAt, file.id);
      this.db.run('UPDATE artifacts SET expiresAt=? WHERE fileId=?', expiresAt, file.id);
      this.event('expiry', file.id, expiresAt);
    }
    return { orderId, expiresAt, fileCount: files.length };
  }
  async cancelAndWait(fileId) {
    await this.pool.cancel(fileId);
    await Promise.allSettled([...this.jobs.values()].filter(job => job.fileId === fileId).map(job => job.promise));
  }
  async deleteUpload({ userId, fileId }) {
    const file = this.owned({ id: userId, role: 'user' }, fileId);
    if (file.claimedOrderId) throw new ApiError(409, 'FILE_ALREADY_CLAIMED', '已绑定订单的文件不能从上传接口删除');
    this.db.tx(() => {
      this.db.run("UPDATE files SET status='expired',expiresAt=? WHERE id=?", this.now(), fileId);
      this.db.run("UPDATE preparations SET status='expired' WHERE fileId=?", fileId); this.event('revoked', fileId);
    });
    await this.purgeExpiredFiles();
    return { deleted: !!this.db.get('SELECT purgedAt FROM files WHERE id=?', fileId).purgedAt,
      status: 'expired', fileId };
  }
  hasActiveLease(fileId) {
    if ([...this.jobs.values()].some(job => job.fileId === fileId)) return true;
    return !!this.db.get('SELECT 1 FROM file_leases WHERE fileId=? AND expiresAt>?', fileId, this.now());
  }
  purgeExpiredFiles() {
    if (this.scan) return this.scan;
    this.scan = this.performPurge().finally(() => { this.scan = null; }); return this.scan;
  }
  async performPurge() {
    this.flushLedger();
    if (this.ledger.failure) throw new ApiError(503, 'FILE_LEDGER_UNAVAILABLE', '清理台账写入失败，文件访问保持禁止');
    const runId = randomUUID(), startedAt = this.now(), result = { runId, startedAt, examined: 0, purged: 0, failed: 0, deferred: 0 };
    this.db.run('INSERT INTO file_cleanup_runs(id,startedAt) VALUES(?,?)', runId, startedAt);
    for (const jobId of this.pendingTemporaryCleanup.keys()) if (!this.jobs.has(jobId)) await this.cleanJobTemporary(jobId);
    const due = this.db.all("SELECT * FROM files WHERE purgedAt IS NULL AND (status='expired' OR (expiresAt IS NOT NULL AND expiresAt<=?)) ORDER BY uploadedAt,id", startedAt);
    for (const row of due) {
      result.examined++;
      if (!row.claimedOrderId && row.status !== 'expired' && this.hasActiveLease(row.id)) { result.deferred++; continue; }
      this.db.tx(() => {
        this.db.run("UPDATE files SET status='expired',purgeAttempts=purgeAttempts+1 WHERE id=?", row.id);
        this.db.run("UPDATE preparations SET status='expired' WHERE fileId=?", row.id); this.event('revoked', row.id);
      });
      try {
        if (this.ledger.failure) throw new ApiError(503, 'FILE_LEDGER_UNAVAILABLE', '期限台账不可用');
        await this.cancelAndWait(row.id);
        await this.deleteTree(this.config.fileRoot, row.id);
        for (const job of this.db.all('SELECT id FROM file_jobs WHERE fileId=?', row.id)) await this.deleteTree(this.config.tempRoot, `job-${job.id}`);
        this.db.tx(() => {
          this.db.run('UPDATE files SET purgedAt=?,purgeErrorCode=NULL WHERE id=?', this.now(), row.id);
          this.db.run("UPDATE file_jobs SET status='cancelled',updatedAt=? WHERE fileId=? AND status IN ('queued','running')", this.now(), row.id);
          this.event('purged', row.id);
        }); result.purged++;
      } catch (error) {
        this.db.run('UPDATE files SET purgeErrorCode=? WHERE id=?', error.code === 'UNSAFE_STORAGE_PATH' ? 'UNSAFE_STORAGE_PATH' : 'FILE_DELETE_FAILED', row.id); result.failed++;
      }
    }
    try { this.backupCleanup = await pruneBackups({ root: this.config.backupRoot, manifest: this.exportRetentionManifest(), now: this.now(), deleteTree: this.deleteTree, activeSnapshots: this.activeSnapshots }); }
    catch { this.backupCleanup = { examined: 0, purged: 0, failures: [{ snapshotId: '', fileId: '', code: 'BACKUP_STORAGE_UNAVAILABLE' }] }; }
    result.finishedAt = this.now();
    this.db.run('UPDATE file_cleanup_runs SET finishedAt=?,examined=?,purged=?,failed=?,deferred=? WHERE id=?', result.finishedAt, result.examined, result.purged, result.failed, result.deferred, runId);
    this.db.run('DELETE FROM file_cleanup_runs WHERE id NOT IN (SELECT id FROM file_cleanup_runs ORDER BY startedAt DESC,id DESC LIMIT 100)');
    return result;
  }
  cleanupStatus() {
    return { intervalMs: this.limits.cleanupIntervalMs, temporaryUploadHours: this.limits.temporaryUploadHours,
      latestRun: this.db.get('SELECT * FROM file_cleanup_runs ORDER BY startedAt DESC,id DESC LIMIT 1') || null,
      pendingExpired: this.db.get("SELECT COUNT(*) AS n FROM files WHERE purgedAt IS NULL AND (status='expired' OR expiresAt<=?)", this.now()).n,
      failures: this.db.all('SELECT id AS fileId,purgeAttempts,purgeErrorCode AS code FROM files WHERE purgeErrorCode IS NOT NULL ORDER BY uploadedAt,id LIMIT 100'),
      temporaryCleanupFailures: [...this.pendingTemporaryCleanup].map(([jobId, code]) => ({ jobId, code })),
      ledgerError: this.ledger.failure, processing: this.pool.status(), backupCleanup: this.backupCleanup };
  }
  exportRetentionManifest() {
    this.flushLedger(); if (this.ledger.failure) throw new ApiError(503, 'FILE_LEDGER_UNAVAILABLE', '无法生成可靠期限清单');
    return { schemaVersion: 1, product: 'campus-print-v1', generatedAt: this.now(),
      files: this.db.all('SELECT id AS fileId,ownerId,sourceSha256,claimedOrderId,uploadedAt,temporaryExpiresAt,expiresAt,status,purgedAt FROM files ORDER BY id').map(row => ({
        ...row, revoked: !!this.ledger.facts.get(row.fileId)?.revoked,
        authoritativeExpiresAt: this.ledger.facts.get(row.fileId)?.expiresAt || row.expiresAt })) };
  }
  async reconcileRestoredFiles({ latestManifest }) {
    if (!latestManifest || latestManifest.schemaVersion !== 1 || latestManifest.product !== 'campus-print-v1' || !validTime(latestManifest.generatedAt) || !Array.isArray(latestManifest.files)) invalid('latestManifest', '需要来自最新权威环境的期限清单，不能使用待恢复的旧快照替代');
    const entries = new Map();
    for (const entry of latestManifest.files) {
      id(entry.fileId); if (entries.has(entry.fileId) || (entry.authoritativeExpiresAt !== null && !validTime(entry.authoritativeExpiresAt))) invalid('latestManifest', '期限清单重复或包含无效时间');
      entries.set(entry.fileId, entry);
    }
    this.db.tx(() => {
      for (const file of this.db.all('SELECT * FROM files')) {
        const current = entries.get(file.id), fact = this.ledger.facts.get(file.id);
        const invalidRestoration = !current || current.sourceSha256 !== file.sourceSha256 || current.revoked || current.purgedAt || current.status === 'expired' || fact?.revoked;
        const deadline = fact?.expiresAt && (!current?.authoritativeExpiresAt || fact.expiresAt < current.authoritativeExpiresAt) ? fact.expiresAt : current?.authoritativeExpiresAt;
        if (invalidRestoration || (deadline && deadline <= this.now())) {
          this.db.run("UPDATE files SET status='expired',purgedAt=NULL,expiresAt=? WHERE id=?", deadline || this.now(), file.id); this.event('revoked', file.id);
        } else {
          this.db.run('UPDATE files SET claimedOrderId=?,expiresAt=? WHERE id=?', current.claimedOrderId, deadline, file.id);
          this.db.run('UPDATE artifacts SET claimedOrderId=?,expiresAt=? WHERE fileId=?', current.claimedOrderId, deadline, file.id);
        }
      }
    });
    this.ledger.replay(this.now()); return this.purgeExpiredFiles();
  }
  async receivePaymentImage(req) {
    return this.receiveBusinessImage(req, this.config.paymentRoot);
  }
  async receiveBusinessImage(req, root) {
    if (req.user?.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '仅管理员可以配置经营图片');
    if (![this.config.paymentRoot, this.config.advertisementRoot].includes(root)) throw new Error('Unknown business image root');
    this.assertUploadCapacity();
    const upload = await receiveUpload(req, this.config, { payment: true, activeUploads: this.activeUploads });
    const assetId = randomUUID(), jobId = randomUUID(), directoryName = `job-${jobId}`;
    let published = false, destination;
    try {
      const input = await safePath(this.config.tempRoot, `${upload.tempName}/original.bin`), outputDir = await safePath(this.config.tempRoot, directoryName, { missing: true });
      await fs.mkdir(outputDir);
      const data = await this.pool.run({ id: jobId, fileId: null }, { operation: 'payment_image', input, outputDir, limits: this.limits });
      const output = await safePath(this.config.tempRoot, `${directoryName}/payment.png`); destination = await safePath(root, `${assetId}.png`, { missing: true });
      await fs.copyFile(output, destination, fs.constants.COPYFILE_EXCL);
      published = true;
      return { assetId, mimeType: 'image/png', byteSize: data.byteSize, sha256: data.sha256 };
    } finally {
      if (!published && destination) await removeTree(root, `${assetId}.png`);
      await upload.cleanup(); await removeTree(this.config.tempRoot, directoryName);
    }
  }
  async openPaymentAsset(assetId) { id(assetId); return fs.open(await safePath(this.config.paymentRoot, `${assetId}.png`), 'r'); }
  async deletePaymentAsset(assetId) { id(assetId); await removeTree(this.config.paymentRoot, `${assetId}.png`); }
  async waitForIdle() { while (this.jobs.size) await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
  async close() { this.stopping = true; clearInterval(this.timer); await this.pool.close(); await this.waitForIdle(); if (this.scan) await this.scan; }
}
module.exports = { FileService };
