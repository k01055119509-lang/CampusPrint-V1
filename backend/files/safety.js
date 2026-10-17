'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { inside } = require('../config');
const { ApiError } = require('../errors');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const unsafe = () => { throw new ApiError(500, 'UNSAFE_STORAGE_PATH', '存储路径检查失败，请联系管理员'); };
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(404, 'NOT_FOUND', '资源不存在或不可见'); return value; }
async function assertNoLinks(target, { missing = false } = {}) {
  const absolute = path.resolve(target), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) { if (missing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && index < parts.length - 1) || (stat.isFile() && stat.nlink > 1)) unsafe();
  }
}
async function ensureRoot(root) {
  await assertNoLinks(root, { missing: true }); await fs.mkdir(root, { recursive: true });
  await assertNoLinks(root); return fs.realpath(root);
}
async function safePath(root, relative, { missing = false } = {}) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0') || relative.includes(':')) unsafe();
  const target = path.resolve(root, relative);
  if (!inside(root, target) || target === path.resolve(root)) unsafe();
  await assertNoLinks(root); await assertNoLinks(target, { missing });
  return target;
}
async function removeTree(root, relative) {
  const target = await safePath(root, relative, { missing: true });
  async function remove(current) {
    let stat; try { stat = await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!inside(root, current) || stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) unsafe();
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(current)) await remove(path.join(current, name));
      await assertNoLinks(current); await fs.rmdir(current);
    } else if (stat.isFile()) { await assertNoLinks(current); await fs.unlink(current); }
    else unsafe();
  }
  await remove(target);
}
async function publishDirectory(tempRoot, temporaryName, fileRoot, relative) {
  const source = await safePath(tempRoot, temporaryName), target = await safePath(fileRoot, relative, { missing: true });
  const staging = target + '.partial';
  await assertNoLinks(staging, { missing: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Copy supports different volumes; clients never see the staging tree as ready.
  await fs.cp(source, staging, { recursive: true, errorOnExist: true, force: false, dereference: false });
  await assertNoLinks(staging); await fs.rename(staging, target);
}
module.exports = { UUID, id, ensureRoot, safePath, assertNoLinks, removeTree, publishDirectory };
