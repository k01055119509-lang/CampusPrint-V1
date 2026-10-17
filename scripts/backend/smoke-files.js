'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { isolated, Client, PROJECT } = require('../../tests/helpers/runtime');
async function main() {
  const runtime = await isolated();
  try {
    const student = new Client(runtime); await student.register();
    const upload = await student.upload(await fs.readFile(path.join(PROJECT, 'tests/fixtures/source-100-pages.pdf')));
    console.log('Upload', upload.status, upload.body); await runtime.files.waitForIdle();
    const file = await student.request('GET', `/api/files/${upload.body.data.id}`); console.log('File', file.body);
    const artifact = await runtime.files.preparePrintItem({ userId: student.user.id, fileId: upload.body.data.id, pageNumbers: [1, 2, 100], preparationId: 'smoke-100-source' });
    console.log('Production', artifact);
    const admin = new Client(runtime); await admin.admin();
    const opened = await runtime.files.openArtifactForRead({ actor: admin.user, artifactId: artifact.artifactId });
    const output = path.join(PROJECT, 'docs/verification/A/samples'); await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'selected-1-2-100-a4-gray.pdf'), await opened.handle.readFile()); await opened.handle.close();
    const preview = await runtime.files.openArtifactForRead({ actor: student.user, artifactId: artifact.artifactId, purpose: 'preview', page: 1 });
    await fs.writeFile(path.join(output, 'production-preview-1.png'), await preview.handle.readFile()); await preview.handle.close();
  } finally { await runtime.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
