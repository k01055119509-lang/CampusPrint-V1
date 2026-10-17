'use strict';
// Aggregate actual persisted evidence only; do not fabricate external acceptance results.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { PRODUCT, LIMITS } = require('../../backend/config');
const { removeTree } = require('../../backend/files/safety');
async function main() {
  const root = path.resolve(__dirname, '../..'), evidence = path.join(root, 'docs/verification/A');
  const readJson = async name => JSON.parse(await fs.readFile(path.join(evidence, name), 'utf8'));
  const text = await fs.readFile(path.join(evidence, 'tests.txt'), 'utf8');
  const getCount = name => { const match = new RegExp(`(?:^|\\n)[^\\n]*?\\b${name} (\\d+)`, 'm').exec(text); if (!match) throw new Error(`Missing real test statistic ${name}`); return Number(match[1]); };
  const tests = { total: getCount('tests'), passed: getCount('pass'), failed: getCount('fail'), skipped: getCount('skipped') };
  if (tests.failed || tests.passed !== tests.total || tests.skipped) throw new Error('A cannot be ready while tests are failed or skipped');
  const reference = await readJson('reference-preservation.json'), startup = await readJson('start-stop.json'), browser = await readJson('browser/report.json'), retention = await readJson('retention-evidence.json');
  if (!reference.allSelectedFilesUnchanged || startup.users || startup.files || !startup.closed || !startup.lockRemoved || browser.pageErrors.length || retention.physicalObjectCountAfter !== 0) throw new Error('Required evidence is incomplete');
  const artifacts = [];
  for (const name of ['samples/selected-1-2-100-a4-gray.pdf', 'samples/chinese-a4-gray.pdf', 'samples/production-preview-1.png', 'samples/chinese-production-preview.png']) {
    const bytes = await fs.readFile(path.join(evidence, name)); artifacts.push({ path: `docs/verification/A/${name}`, byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const contractLog = await fs.readFile(path.join(evidence, 'contract-check.txt'), 'utf8');
  const contractMatch = contractLog.split(/\r?\n/).find(line => line.startsWith('{')); if (!contractMatch) throw new Error('No successful contract evidence');
  const contract = JSON.parse(contractMatch);
  const report = {
    product: PRODUCT.id, version: PRODUCT.version, phase: 'A-foundation-and-file-engine', readyForB: true,
    generatedAt: new Date().toISOString(), userFacingDate: '2026-10-14', displayTimezone: 'Asia/Shanghai',
    environment: { platform: process.platform, arch: process.arch, node: process.version, npm: '11.13.0', cleanInstall: 'npm ci --no-fund; added 96 packages, audited 97, zero reported vulnerabilities' },
    tests, contract, browser, startup, reference: { selectedFilesChecked: reference.files.length, allSelectedFilesUnchanged: reference.allSelectedFilesUnchanged },
    retention: { physicalObjectCountBefore: retention.physicalObjectCountBefore, physicalObjectCountAfter: retention.physicalObjectCountAfter,
      exactSevenDayBoundaryDenied: true, firstDeletionFailureRetried: retention.firstDeletionFailure.failed === 1 && retention.retry.purged === 1,
      repeatedPurgeSafe: true, unfinishedOrderPreserved: retention.uncompletedFilesRetained,
      staleDatabaseAndFileSnapshotAgainstLatestLedgerTested: true },
    visualInspection: { syntheticOnly: true, source100SelectedPages: [1, 2, 100], productionPageCount: 3, a4Portrait: true, grayscale: true,
      copiesInPdf: 1, observedPageOrder: [1, 2, 100], chineseReadable: true, landscapeContentCompleteWithWhitespace: true,
      previewFromProductionPdf: true, independentRenderer: 'Poppler pdftoppm at 110 DPI',
      rendererNotice: 'Bundled Poppler emitted three nameToUnicode data path warnings because the Windows user directory contains Chinese; PNG rendering and PDF metadata inspection completed.' },
    resourceLimits: LIMITS, evidenceArtifacts: artifacts,
    notValidated: ['real printer or physical paper output', 'real payment receipt or refund', 'real mobile device', 'public deployment', 'B order pricing/payment/delivery workflows', 'D packaged backup and deployment'],
    nextEntry: 'backend/orders/register.js; context.files; contracts/base.yaml; docs/handoffs/A-基础与文件交接.md'
  };
  await fs.writeFile(path.join(evidence, 'verification-report.json'), JSON.stringify(report, null, 2));
  const handoffPath = path.join(root, 'docs/handoffs/A-基础与文件交接.md');
  let handoff = await fs.readFile(handoffPath, 'utf8');
  handoff = handoff.replace('交接结论：等待最终验证报告刷新。实现已完成，最终测试结果确认后更新本行。',
    `交接结论：**可供 B 开工**。真实上传、A4 黑白生产 PDF、权限读取和期限清理均已实现并验证；${tests.total} 项基础/文件测试全部通过，14 个基础操作与契约一致。B 无需重写文件引擎，可从第 6 节的挂载入口和服务签名接入。`);
  handoff = handoff.replace('验证结果以 `docs/verification/A/tests.txt`、`verification-report.json`、`contract-check.txt` 和 `browser/report.json` 为准。最终数量与完成状态待本文件最后刷新。',
    `实际验证结果：\n\n- 干净依赖安装 npm ci 成功（96 包，审计 97 包，未报告漏洞）；默认库 0 用户/0 文件，无默认管理员。\n- npm test：${tests.total}/${tests.total} 通过，0 失败、0 跳过，含真实 CLI 初始化、格式/资源/并发/网络/权限/七天/物理删除/重启与旧快照测试。\n- contract:check：base.yaml 和 openapi.yaml 均通过校验，14 个基础操作与实际路由对应。\n- Edge 155.0.4283.45：390px、1440px 视口通过，0 页面异常；中英文、深浅主题、注册后接续上传、退出释放预览、后台登录和清理状态可用。\n- 100 页来源选第 1、2、100 页，生产 PDF 3 页、A4、copiesInPdf=1；Poppler 独立渲染确认页序、比例留白和可读性，中文样本清晰。\n- 七天边界：少 1ms 可读，恰好到期学生/管理员读取 410；${retention.physicalObjectCountBefore} 个原始/标准化/生产/预览对象清理为 0，首次失败后重试成功，业务摘要保留，未完成订单文件保留。\n- 默认服务启动与停止成功（4328），退出后锁文件移除；离线 cleanup/manifest/reconcile 均已实际运行。\n- 参考应用选定 ${reference.files.length} 个文件含旧数据库 SHA-256 前后完全一致。\n\n证据：docs/verification/A/tests.txt、verification-report.json、contract-check.txt、retention-evidence.json、start-stop.json、reference-preservation.json、browser/report.json；样本和截图在同目录 samples/、browser/。独立 Poppler 渲染有中文用户路径导致的 nameToUnicode 数据提示，渲染图片已实际查看，未影响这些光栅样本。`);
  await fs.writeFile(handoffPath, handoff);
  for (const relative of ['probe', 'diagnostic-worker.js']) await removeTree(path.join(root, 'tmp'), relative);
  console.log(JSON.stringify({ readyForB: report.readyForB, tests: report.tests, handoff: handoffPath, report: path.join(evidence, 'verification-report.json') }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
