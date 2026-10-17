'use strict';
const v=require('../validation'),r=require('../orders/rules');
const {ApiError,invalid}=require('../errors');
class AnnouncementService {
  constructor(context){Object.assign(this,context);}
  read(admin=false){const row=this.db.get('SELECT * FROM announcement_settings WHERE id=1');return {enabled:!!row.enabled,content:admin||row.enabled?row.content:'',version:row.version,updatedAt:row.updatedAt};}
  save(req){
    const old=this.db.get('SELECT * FROM announcement_settings WHERE id=1'),input=req.body;
    r.integer(input.expectedVersion,'expectedVersion',1,Number.MAX_SAFE_INTEGER);
    if(old.version!==input.expectedVersion)throw new ApiError(409,'VERSION_CONFLICT','公告已更新，请重新读取后保存',{expectedVersion:String(old.version)});
    if(input.enabled===undefined&&input.content===undefined)invalid('body','至少提供公告内容或发布状态');
    const enabled=input.enabled===undefined?!!old.enabled:r.bool(input.enabled,'enabled');
    const content=input.content===undefined?old.content:v.string(input.content,'content',{max:1000}).replace(/\r\n?/g,'\n');
    if(enabled&&!content.trim())invalid('content','发布公告须填写非空正文');
    this.db.run('UPDATE announcement_settings SET enabled=?,content=?,version=version+1,updatedAt=?,updatedBy=? WHERE id=1',enabled?1:0,content,this.now(),req.user.id);
    return this.read(true);
  }
}
module.exports={AnnouncementService};
