'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated, configAt, Client, TEST_PASSWORD } = require('../helpers/runtime');
const { startServer } = require('../../backend/server');
const { hashSecret } = require('../../backend/auth');
const { questions } = require('../../backend/routes/account-security');
const path = '/api/me/security-questions';
const ANSWERS = ['青禾学校', 'Alice Smith', '南湖路'];
const setup = (extra = {}) => ({ expectedVersion:0, currentPassword:TEST_PASSWORD, questions:questions.slice(0,3).map((question,i) => ({questionId:question.id,answer:ANSWERS[i]})), ...extra });
const change = (extra = {}) => ({ expectedVersion:1, answers:ANSWERS, newPassword:'Changed9', ...extra });
async function login(runtime, user, password = TEST_PASSWORD) {
  const client = new Client(runtime, { surface: user.role === 'admin' ? 'admin' : 'student' }); await client.csrfToken();
  const result = await client.request('POST', '/api/auth/'+(user.role === 'admin' ? 'admin-login' : 'login'), {username:user.username,password});
  assert.equal(result.status,200,JSON.stringify(result.body)); client.user = result.body.data; return client;
}
test('注册仅用户名与密码，设置规则和旧密码登录兼容', async t => {
  const runtime = await isolated({ studentAccountsEnabled: true }); t.after(() => runtime.destroy()); const client = new Client(runtime); await client.csrfToken();
  for (const password of ['a1234','Abc1234567890','123456','abcdef','Abc12!','Ab 123','密码Ab12','ＡＢ１２３４']) {
    const result = await client.request('POST','/api/auth/register',{username:'bad_password',password});
    assert.equal(result.status,400,password); assert.equal(result.body.error.code,'VALIDATION_ERROR');
  }
  assert.equal((await client.request('POST','/api/auth/register',{username:'nickname_extra',password:TEST_PASSWORD,nickname:'extra'})).status,400);
  for (const [username,password] of [['short_valid','Abc123'],['long_valid',TEST_PASSWORD]]) {
    const result = await client.request('POST','/api/auth/register',{username,password}); assert.equal(result.status,201); assert.equal(result.body.data.nickname,username);
  }
  const old = new Client(runtime); await old.register('legacy_account');
  const legacy = 'Legacy-long-password!9';
  runtime.db.run('UPDATE users SET passwordHash=? WHERE id=?',await hashSecret(legacy),old.user.id);
  const signed = await login(runtime,old.user,legacy);
  assert.equal((await signed.request('POST',path,setup({currentPassword:legacy}))).status,200);
  assert.equal((await signed.request('POST','/api/me/password',change())).status,200);
  await login(runtime,old.user,'Changed9');
});
test('密保与改密真实接口：完整性、权限、原子保存、会话撤销和账户隔离', async t => {
  const runtime = await isolated({ studentAccountsEnabled: true }); t.after(() => runtime.destroy());
  const user = new Client(runtime), other = new Client(runtime), admin = new Client(runtime), guest = new Client(runtime);
  await user.register(); await other.register(); await admin.admin(); await guest.csrfToken();
  await t.test('匿名与 CSRF 拒绝；未配置密保不可改密', async () => {
    assert.equal((await guest.request('GET',path)).status,401);
    assert.equal((await guest.request('POST',path,setup())).status,401);
    assert.equal((await guest.request('POST','/api/me/password',change())).status,401);
    assert.equal((await user.request('POST',path,setup(),{headers:{'X-CSRF-Token':'wrong'}})).status,403);
    const state = (await user.request('GET',path)).body.data; assert.equal(state.configured,false); assert.equal(state.version,0); assert.deepEqual(state.questions,[]);
    const result = await user.request('POST','/api/me/password',change({expectedVersion:0})); assert.equal(result.body.error.code,'SECURITY_QUESTIONS_REQUIRED');
  });
  await t.test('只接受三个不同问题及非空答案；当前密码错误时不写库', async () => {
    const valid = setup();
    for (const changed of [[],valid.questions.slice(0,2),[...valid.questions,valid.questions[0]],[valid.questions[0],valid.questions[0],valid.questions[2]],[{questionId:'unknown',answer:'x'},...valid.questions.slice(1)],[{...valid.questions[0],answer:'　 '},...valid.questions.slice(1)]]) {
      assert.equal((await user.request('POST',path,setup({questions:changed}))).status,400);
    }
    assert.equal((await user.request('POST',path,setup({currentPassword:'wrong1'}))).body.error.code,'CURRENT_PASSWORD_INCORRECT');
    assert.equal(runtime.db.get('SELECT COUNT(*) AS n FROM user_security').n,0);
    assert.equal((await user.request('POST',path,setup({userId:other.user.id}))).status,400);
    assert.equal((await user.request('POST',path,setup())).status,200);
    const state = (await user.request('GET',path)).body.data;
    assert.equal(state.questions.length,3); assert.equal(state.version,1); assert.equal(state.configured,true);
    assert(!JSON.stringify(state).includes('answer')); assert(!JSON.stringify(state).includes('Hash'));
    const stored = runtime.db.get('SELECT questionsJson FROM user_security WHERE userId=?',user.user.id).questionsJson;
    for (const answer of ANSWERS) assert(!stored.includes(answer));
    assert(JSON.parse(stored).every(item => item.answerHash.startsWith('scrypt$')));
    assert.equal((await other.request('GET',path)).body.data.configured,false);
  });
  await t.test('任一答案不正确或缺失均不能改密，也不能用当前密码绕过原密保', async () => {
    const before = runtime.db.get('SELECT passwordHash FROM users WHERE id=?',user.user.id).passwordHash;
    for (let i = 0; i < 3; i++) {
      const wrong = [...ANSWERS]; wrong[i] = '错误答案';
      const result = await user.request('POST','/api/me/password',change({answers:wrong})); assert.equal(result.status,403); assert.equal(result.body.error.code,'SECURITY_ANSWERS_INCORRECT');
    }
    assert.equal((await user.request('POST','/api/me/password',change({answers:ANSWERS.slice(0,2)}))).status,400);
    // One successful verified request clears the failed-account attempt bucket.
    assert.equal((await user.request('POST',path,setup({expectedVersion:1,answers:ANSWERS}))).status,200);
    assert.equal((await user.request('POST',path,setup({expectedVersion:2}))).status,400);
    assert.equal((await user.request('POST',path,setup({expectedVersion:0}))).status,409);
    assert.equal(runtime.db.get('SELECT passwordHash FROM users WHERE id=?',user.user.id).passwordHash,before);
  });
  await t.test('验证成功后密码才变更，旧密码和其他旧会话失效，当前 CSRF 旋转', async () => {
    const second = await login(runtime,user.user), stolen = new Client(runtime); stolen.cookie = user.cookie;
    const previousCookie = user.cookie, previousCsrf = user.csrf;
    assert.equal((await user.request('POST','/api/me/password',change({expectedVersion:2,newPassword:'abcdef'}))).status,400);
    assert.equal((await user.request('POST','/api/me/password',change({expectedVersion:2,answers:[' 青禾学校 ', 'ＡＬＩＣＥ   ＳＭＩＴＨ','南湖路']}))).status,200);
    assert.notEqual(user.cookie,previousCookie); assert.notEqual(user.csrf,previousCsrf);
    assert.equal((await second.request('GET','/api/auth/me')).status,401); assert.equal((await stolen.request('GET','/api/auth/me')).status,401);
    assert.equal((await user.request('PATCH','/api/me/profile',{nickname:'改密后仍能操作'})).status,200);
    const anonymous = new Client(runtime); await anonymous.csrfToken();
    assert.equal((await anonymous.request('POST','/api/auth/login',{username:user.user.username,password:TEST_PASSWORD})).status,401);
    await login(runtime,user.user,'Changed9');
    assert.equal((await other.request('GET','/api/auth/me')).status,200); await login(runtime,other.user);
  });
  await t.test('更换密保必须答对原问题；旧答案不能继续使用；管理员采用同一流程', async () => {
    const replacements = ['新的学校','New Friend','新的城市'];
    assert.equal((await user.request('POST',path,setup({expectedVersion:2,answers:ANSWERS,questions:questions.slice(3,6).map((q,i)=>({questionId:q.id,answer:replacements[i]}))}))).status,200);
    assert.equal((await user.request('POST','/api/me/password',change({expectedVersion:3}))).status,403);
    assert.equal((await user.request('POST','/api/me/password',change({expectedVersion:2,answers:replacements}))).status,409);
    assert.equal((await user.request('POST','/api/me/password',change({expectedVersion:3,answers:replacements,newPassword:'Newpass8'}))).status,200);
    assert.equal((await admin.request('POST',path,setup())).status,200);
    assert.equal((await admin.request('POST','/api/me/password',change())).status,200);
    const after = await login(runtime,admin.user,'Changed9'); assert.equal((await after.request('GET','/api/admin/dashboard')).status,200);
  });
});
test('密保错误限流与持久化跨服务重启；同 IP 其他账号不受账户锁定影响', async t => {
  let now = new Date();
  const initial = await isolated({studentAccountsEnabled:true,clock:()=>new Date(now)}); let runtime = initial;
  t.after(async () => { await runtime.close(); await initial.destroy(); });
  const user = new Client(runtime); await user.register(); await user.request('POST',path,setup());
  for (let i=0;i<5;i++) assert.equal((await user.request('POST','/api/me/password',change({answers:['wrong','wrong','wrong']}))).status,403);
  let locked = await user.request('POST','/api/me/password',change()); assert.equal(locked.status,429); assert(locked.headers.get('retry-after'));
  const hash = runtime.db.get('SELECT passwordHash FROM users WHERE id=?',user.user.id).passwordHash;
  await runtime.close(); runtime = await startServer(configAt(initial.root,{studentAccountsEnabled:true,clock:()=>new Date(now)})); user.runtime = runtime;
  assert.equal((await user.request('GET',path)).body.data.configured,true);
  locked = await user.request('POST','/api/me/password',change()); assert.equal(locked.status,429);
  assert.equal(runtime.db.get('SELECT passwordHash FROM users WHERE id=?',user.user.id).passwordHash,hash);
  const other = new Client(runtime); await other.register(); assert.equal((await other.request('POST',path,setup())).status,200);
  now = new Date(now.getTime()+15*60000+1);
  assert.equal((await user.request('POST','/api/me/password',change())).status,200);
});
test('并发改密与撤销中的请求不能通过旧会话覆盖新密码', async t => {
  const runtime = await isolated({ studentAccountsEnabled: true }); t.after(()=>runtime.destroy()); const user = new Client(runtime); await user.register(); await user.request('POST',path,setup());
  const second = await login(runtime,user.user);
  const result = await Promise.all([user.request('POST','/api/me/password',change({newPassword:'RaceOne1'})),second.request('POST','/api/me/password',change({newPassword:'RaceTwo2'}))]);
  assert.equal(result.filter(row=>row.status===200).length,1); assert(result.some(row=>[401,409].includes(row.status)));
  await login(runtime,user.user,result[0].status===200?'RaceOne1':'RaceTwo2');
  const active = await login(runtime,user.user,result[0].status===200?'RaceOne1':'RaceTwo2');
  const pending = active.request('POST','/api/me/password',change({newPassword:'AfterBye3'}));
  // Let verification start, then revoke the exact session while hashing awaits.
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await active.request('POST','/api/auth/logout',{})).status,200);
  assert.equal((await pending).status,401);
});
