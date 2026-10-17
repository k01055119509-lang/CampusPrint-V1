'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { isolated, Client, TEST_PASSWORD, PROJECT } = require('../helpers/runtime');

test('真实浏览器：两项注册、三个密保、验证后改密、学生与管理员入口', async t => {
  const runtime = await isolated({studentAccountsEnabled:true});
  const admin = new Client(runtime); await admin.admin();
  const browser = await chromium.launch(process.env.CP_TEST_BROWSER_PATH ? {executablePath:process.env.CP_TEST_BROWSER_PATH,headless:true} : {channel:'msedge',headless:true});
  const context = await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'}), page = await context.newPage();
  const errors = [], shots = [], output = path.join(process.env.CP_VERIFICATION_DIR || path.join(PROJECT,'docs/verification/cancellation-notice-v1.4.0/C/local-ui'),'account-security'); await fs.mkdir(output,{recursive:true});
  page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{await browser.close();await runtime.destroy();});
  const dialog = page.locator('dialog[open]');
  const security = page.locator('.security-dialog[open]');
  const ready = () => page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
  async function submitSecurity(url, status=200) {
    const pending = page.waitForResponse(response=>new URL(response.url()).pathname===url&&response.request().method()==='POST');
    await security.locator('[data-security-submit]').click();const response=await pending;assert.equal(response.status(),status,await response.text());
    await security.locator('[data-security-close]').waitFor();
    await page.waitForFunction(()=>!document.querySelector('.security-dialog [data-security-close]')?.disabled);
  }
  async function fillAnswers(values) { for (let i=0;i<3;i++) await security.locator(`[name=answer${i}]`).fill(values[i]); }
  async function fillQuestions(ids, values) { for (let i=0;i<3;i++) {await security.locator(`[name=question${i}]`).selectOption(ids[i]);await security.locator(`[name=newAnswer${i}]`).fill(values[i]);} }
  async function capture(name) {
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});shots.push(name+'.png');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await security.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
  }
  await t.test('注册仅用户名和密码，浏览器拒绝非字母数字组合', async()=>{
    await page.goto(runtime.url+'/'); await ready(); await page.locator('#student-account').click(); await dialog.locator('[data-mode]').click();
    assert.deepEqual(await dialog.locator('input').evaluateAll(nodes=>nodes.map(node=>node.name)),['username','password']);
    await dialog.locator('[name=username]').fill('security_ui_student');
    const password = dialog.locator('[name=password]');assert.equal(await password.getAttribute('minlength'),'6');assert.equal(await password.getAttribute('maxlength'),'12');
    for (const bad of ['abcdef','123456','Ab12!?','Ab 123']) {await password.fill(bad);assert.equal(await password.evaluate(el=>el.checkValidity()),false);}
    await password.fill('UiTest1');
    const pending = page.waitForResponse(response=>response.url().endsWith('/api/auth/register'));
    await dialog.locator('[data-submit]').click(); const response=await pending;assert.equal(response.status(),201);assert.deepEqual(Object.keys(response.request().postDataJSON()).sort(),['password','username']);
    await dialog.waitFor({state:'hidden'}); await page.locator('[data-view=me]').click();await ready();await page.locator('[data-action=account-security]').click();
    await security.getByText('尚未设置密保。请一次选择三个不同的问题并填写答案。',{exact:true}).waitFor();
  });
  await t.test('设置三个问题：重复问题与错误当前密码被拒绝，成功后清空答案', async()=>{
    await security.locator('[data-security-mode=questions]').click();await security.locator('[name=currentPassword]').fill('Wrong1');
    await fillQuestions(['first_school','first_school','childhood_place'],['青禾学校','Alice Smith','南湖路']);
    await security.locator('[data-security-submit]').click();await security.getByText('请选择三个不同的问题。',{exact:true}).waitFor();
    await security.locator('[name=question1]').selectOption('childhood_friend');await submitSecurity('/api/me/security-questions',403);
    await security.getByText('当前密码不正确',{exact:true}).waitFor();await security.locator('[name=currentPassword]').fill('UiTest1');await capture('student-setup-390');
    await submitSecurity('/api/me/security-questions');await security.getByText('三个密保问题已保存。修改密码时须全部答对。',{exact:true}).waitFor();
    assert.equal(await security.locator('input').count(),0);
  });
  await t.test('三个答案全部正确才改密，确认密码一致且旧会话失效', async()=>{
    const second = new Client(runtime);await second.csrfToken();assert.equal((await second.request('POST','/api/auth/login',{username:'security_ui_student',password:'UiTest1'})).status,200);
    await security.locator('[data-security-mode=password]').click();await fillAnswers(['青禾学校','wrong','南湖路']);
    await security.locator('[name=newPassword]').fill('New123');await security.locator('[name=confirmPassword]').fill('New124');await security.locator('[data-security-submit]').click();
    await security.getByText('两次输入的新密码不一致。',{exact:true}).waitFor();await security.locator('[name=confirmPassword]').fill('New123');await submitSecurity('/api/me/password',403);
    await security.getByText('密保答案不正确，请检查全部三个答案',{exact:true}).waitFor();await fillAnswers(['青禾学校','alice smith','南湖路']);await submitSecurity('/api/me/password');
    await security.getByText('密码已修改，其他设备已退出。当前页面可继续使用。',{exact:true}).waitFor();assert.equal((await second.request('GET','/api/auth/me')).status,401);
    const rejected = new Client(runtime);await rejected.csrfToken();assert.equal((await rejected.request('POST','/api/auth/login',{username:'security_ui_student',password:'UiTest1'})).status,401);
    await security.locator('[data-security-close]').click();assert.equal(await page.evaluate(()=>document.activeElement.dataset.action),'account-security');await page.locator('[data-action=logout]').click();
    await page.locator('[data-action=login]').click();await dialog.locator('[name=username]').fill('security_ui_student');await dialog.locator('[name=password]').fill('New123');await dialog.locator('[data-submit]').click();await dialog.waitFor({state:'hidden'});await page.locator('#nickname-form').waitFor();
  });
  await t.test('360px 英文深色密保和真实网络失败重试', async()=>{
    await page.setViewportSize({width:360,height:800});await page.locator('#theme-control').selectOption('dark');await page.locator('#language-control').selectOption('en');
    await page.route('**/api/me/security-questions',route=>route.abort());await page.locator('[data-action=account-security]').click();await security.locator('[role=alert]').filter({hasText:'network'}).waitFor();await page.unroute('**/api/me/security-questions');
    await security.locator('[data-security-retry]').click();await security.locator('[data-security-mode=password]').click();await capture('student-password-360-dark-en');
    assert.equal(await security.locator('[name=newPassword]').getAttribute('maxlength'),'12');await page.keyboard.press('Escape');assert.equal(await security.count(),0);
  });
  await t.test('管理员在后台设置密保并改为 6 位密码，再次真实登录', async()=>{
    const operatorContext = await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}), operator = await operatorContext.newPage();operator.on('pageerror',error=>errors.push(error.message));
    await operator.goto(runtime.url+'/admin/');await operator.locator('#admin-account').click();let modal=operator.locator('dialog[open]');await modal.locator('[name=username]').fill(admin.user.username);await modal.locator('[name=password]').fill(TEST_PASSWORD);await modal.locator('[data-submit]').click();await modal.waitFor({state:'hidden'});
    await operator.locator('#admin-security').click();modal=operator.locator('.security-dialog[open]');await modal.locator('[data-security-mode=questions]').click();await modal.locator('[name=currentPassword]').fill(TEST_PASSWORD);
    for (let i=0;i<3;i++){await modal.locator(`[name=question${i}]`).selectOption(['first_school','childhood_friend','childhood_place'][i]);await modal.locator(`[name=newAnswer${i}]`).fill(['青禾学校','Alice Smith','南湖路'][i]);}
    await modal.locator('[data-security-submit]').click();await modal.getByText('三个密保问题已保存。修改密码时须全部答对。',{exact:true}).waitFor();await modal.locator('[data-security-mode=password]').click();
    for(let i=0;i<3;i++)await modal.locator(`[name=answer${i}]`).fill(['青禾学校','Alice Smith','南湖路'][i]);await modal.locator('[name=newPassword]').fill('Admin9');await modal.locator('[name=confirmPassword]').fill('Admin9');
    await operator.screenshot({path:path.join(output,'admin-password-1440.png'),fullPage:true});shots.push('admin-password-1440.png');await modal.locator('[data-security-submit]').click();await modal.getByText('密码已修改，其他设备已退出。当前页面可继续使用。',{exact:true}).waitFor();await modal.locator('[data-security-close]').click();
    await operator.locator('#admin-logout').click();await operator.locator('#admin-account').click();modal=operator.locator('dialog[open]');await modal.locator('[name=username]').fill(admin.user.username);await modal.locator('[name=password]').fill('Admin9');await modal.locator('[data-submit]').click();await modal.waitFor({state:'hidden'});await operator.locator('#admin-security').waitFor();assert.equal((await operator.request.get(runtime.url+'/api/admin/dashboard',{headers:{'X-CP-Surface':'admin'}})).status(),200);
    await operatorContext.close();
  });
  assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(output,'browser.json'),JSON.stringify({kind:'account-security-real-browser',at:new Date().toISOString(),browser:browser.version(),viewports:[360,390,1440],screenshots:shots,pageErrors:errors,realMobileDevice:false,passed:true},null,2));
});
