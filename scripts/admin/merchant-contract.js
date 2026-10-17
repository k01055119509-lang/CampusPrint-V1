'use strict';
module.exports=function({schemas,add,obj,str,en,integer,bool,id,time,nullable,ref,list,param}) {
  const version=integer(1), upload=obj({file:{type:'string',format:'binary'}}), expected=obj({expectedVersion:version});
  for (const [method,title] of [['post','上传或替换指定渠道收款码'],['delete','清除指定渠道收款码'],['get','读取指定渠道收款码']]) {
    const write=method!=='get';
    add(method,(write?'/admin':'/public')+'/payment-qr/{channel}',title,write?{role:'admin',request:method==='post'?upload:expected,response:'Settings',multipart:method==='post',parameters:method==='post'?[param('X-Settings-Version',str(20,1),'header',true)]:[],description:'复用经营设置全局版本；上传前后均校验。PNG/JPG，5MiB，真实解码与安全重编码。失败保留原图；版本冲突重读后再操作。不需要 Idempotency-Key。'}:{binary:'image/png',description:'空渠道 404 PAYMENT_NOT_CONFIGURED，不可读 503 PAYMENT_ASSET_UNAVAILABLE。只读，禁止缓存。'});
  }
  const item=obj({id,imageUrl:str(200,1),altText:str(200)});
  schemas.AdvertisementConfig=obj({version,intervalSeconds:integer(2,30),items:{...list(item),maxItems:5}});
  schemas.AdvertisementAdmin=obj({version,intervalSeconds:integer(2,30),items:{...list(obj({...item.properties,enabled:bool,position:integer(),available:bool,createdAt:time,updatedAt:time})),maxItems:5},cleanup:list(obj({assetId:id,attempts:integer(),lastError:nullable(str(100))}))});
  const result='AdvertisementAdmin', uploadParams=[param('X-Advertisements-Version',str(20,1),'header',true)];
  add('get','/public/advertisements','按顺序读取启用的广告图片',{response:'AdvertisementConfig',description:'共用版本、间隔和顺序。0张 items=[]，1张静态；无外链和物理路径。停用图片不在公开列表且二进制拒绝读取。'});
  add('get','/public/advertisements/{id}/image','读取启用的广告图片',{binary:'image/png'});
  add('get','/admin/advertisements','读取全部广告及清理状态',{role:'admin',response:result});
  add('patch','/admin/advertisements','设置切换间隔及完整顺序',{role:'admin',request:obj({expectedVersion:version,intervalSeconds:integer(2,30),order:{...list(id),maxItems:5,uniqueItems:true}},['expectedVersion']),response:result,description:'广告独立全局版本。order 如提供须包含全部当前 ID（含停用）各一次。间隔整数2–30，默认5秒。事务失败不部分保存。'});
  add('post','/admin/advertisements','上传新广告图片',{role:'admin',multipart:true,code:201,request:upload,response:result,parameters:uploadParams,description:'最多保存5张，停用也计数；默认启用、altText为空。单个file，PNG/JPG <=5MiB。先解码，再事务检查版本/上限；失败清理新文件，不改原配置。'});
  add('patch','/admin/advertisements/{id}','启停或设置替代文字',{role:'admin',request:obj({expectedVersion:version,enabled:bool,altText:str(200)},['expectedVersion']),response:result});
  add('delete','/admin/advertisements/{id}','删除广告并清理图片',{role:'admin',request:expected,response:result,description:'先事务移除引用，再持久清理；失败定期重试。版本旧返回409后重读；当前版本删除已不存在项安全返回当前配置。'});
  add('post','/admin/advertisements/{id}/image','替换指定广告图片',{role:'admin',multipart:true,request:upload,response:result,parameters:uploadParams,description:'保留ID、顺序、启停和altText，复用全局广告版本；失败不破坏旧图。'});
  add('get','/admin/advertisements/{id}/image','管理员预览含停用广告',{role:'admin',binary:'image/png'});
};
