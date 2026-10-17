'use strict';
const { randomUUID } = require('node:crypto');
const { hashPassword, verifyPassword } = require('../auth');
const { ApiError, conflict } = require('../errors');
const v = require('../validation');
const e = require('../entities');
module.exports = ({ db,config,auth,activity,add,now }) => {
  function limited(req,res,username) {
    auth.rate(`auth:ip:${req.ip}`,config.rateLimits.authIp,15*60000,res);
    auth.rate(`auth:account:${username}`,config.rateLimits.authAccount,15*60000,res);
  }
  const response = req => ({ ...e.user(db.get('SELECT * FROM users WHERE id=?',req.user.id),activity), sessionExpiresAt: req.session.expiresAt });
  function finish(req,res,user) {
    req.user = user; auth.newSession(req,res,user.id);
    db.run('UPDATE users SET lastLoginAt=? WHERE id=?',now(),user.id);
    activity.record(req);
    res.set('X-CSRF-Token',req.session.csrfToken);
    return response(req);
  }
  add('get','/auth/csrf',{ transaction:false },(req,res) => {
    auth.rate(`csrf:ip:${req.ip}`,config.rateLimits.csrfIp,60000,res);
    if (!req.session) db.tx(() => auth.newSession(req,res));
    return { csrfToken:req.session.csrfToken,expiresAt:req.session.expiresAt };
  });
  add('post','/auth/guest',{ transaction:false,bodyKeys:[] },(req,res) => {
    auth.rate(`guest:ip:${req.ip}`,config.rateLimits.guestIp,15*60000,res);
    if (req.user) return response(req);
    return db.tx(() => {
      const id = randomUUID(), username = 'guest_' + id.replaceAll('-','').slice(0,26);
      db.run("INSERT INTO users(id,username,nickname,passwordHash,role,createdAt,identityKind) VALUES(?,?,?,'!','user',?,'guest')",id,username,'访客',now());
      req.user = db.get('SELECT * FROM users WHERE id=?',id); auth.newSession(req,res,id);
      activity.record(req); res.set('X-CSRF-Token',req.session.csrfToken); return response(req);
    });
  });
  add('post','/auth/register',{ transaction:false,studentAccount:true,status:201,bodyKeys:['username','password'] },async (req,res) => {
    const username = v.username(req.body.username), password = v.password(req.body.password);
    const nickname = username;
    limited(req,res,username);
    if (db.get('SELECT id FROM users WHERE username=?',username)) conflict('用户名已存在');
    const passwordHash = await hashPassword(password);
    return db.tx(() => {
      const id = randomUUID();
      db.run('INSERT INTO users(id,username,nickname,passwordHash,role,createdAt) VALUES(?,?,?,?,?,?)',id,username,nickname,passwordHash,'user',now());
      return finish(req,res,db.get('SELECT * FROM users WHERE id=?',id));
    });
  });
  for (const [path,role] of [['/auth/login','user'],['/auth/admin-login','admin']]) {
    add('post',path,{ transaction:false,studentAccount:role==='user',bodyKeys:['username','password'] },async (req,res) => {
      const username = v.username(req.body.username),password = v.loginPassword(req.body.password); limited(req,res,username);
      const user = db.get('SELECT * FROM users WHERE username=?',username);
      const valid = await verifyPassword(password,user?.identityKind === 'account' ? user.passwordHash : undefined);
      if (!valid || !user || user.identityKind !== 'account') throw new ApiError(401,'AUTH_REQUIRED','用户名或密码错误');
      if (user.role !== role) throw new ApiError(403,'FORBIDDEN',role === 'admin' ? '请使用管理员账号登录后台' : '管理员请使用独立后台入口');
      return db.tx(() => {
        if (db.get('SELECT passwordHash FROM users WHERE id=?',user.id)?.passwordHash !== user.passwordHash) throw new ApiError(401,'AUTH_REQUIRED','密码已更改，请重新登录');
        return finish(req,res,user);
      });
    });
  }
  add('get','/auth/me',{ role:'session' },response);
  add('post','/auth/logout',{ role:'session',business:false,bodyKeys:[] },(req,res) => {
    db.run('DELETE FROM sessions WHERE tokenHash=?',req.session.tokenHash); auth.clearCookie(req,res); return { loggedOut:true };
  });
  add('patch','/me/profile',{ role:'session',account:true,bodyKeys:['nickname'] },req => {
    db.run('UPDATE users SET nickname=? WHERE id=?',v.string(req.body.nickname,'nickname',{min:1,max:80}),req.user.id);
    return response(req);
  });
};
