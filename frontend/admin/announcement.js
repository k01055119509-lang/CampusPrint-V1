import { request } from '/shared/api.js';
import { L, esc, date, errorMessage } from './text.js';

export async function mountAnnouncement(host, isCurrent) {
  if(!host)return;
  host.innerHTML=`<h2>${L('首页公告','Homepage announcement')}</h2><p class="hint">${L('仅在学生服务首页底部展示一条文字公告，最多 1000 字。','One plain-text announcement at the bottom of the student homepage, up to 1000 characters.')}</p><p role="status">${L('正在读取公告…','Loading announcement…')}</p>`;
  let current;
  try{current=await request('/admin/announcement');}
  catch(error){if(!isCurrent()||!host.isConnected)return;host.querySelector('[role=status]').textContent=errorMessage(error);const retry=document.createElement('button');retry.className='button';retry.textContent=L('重试读取公告','Retry announcement');retry.onclick=()=>mountAnnouncement(host,isCurrent);host.append(retry);return;}
  if(!isCurrent()||!host.isConnected)return;
  host.innerHTML=`<form class="stack" data-announcement-form><div class="section-heading"><h2>${L('首页公告','Homepage announcement')}</h2><span data-announcement-state class="badge"></span></div><p class="hint">${L('只展示于学生服务首页底部；按纯文字保存，最多 1000 字，保留换行。','Shown only at the bottom of the student homepage. Plain text, up to 1000 characters, with line breaks.')}</p><label class="field"><span>${L('公告内容','Announcement text')}</span><textarea name="content" maxlength="1000">${esc(current.content)}</textarea></label><label class="check-field"><input name="enabled" type="checkbox" ${current.enabled?'checked':''}><span>${L('发布公告（取消勾选后停用，保留内容）','Publish announcement (uncheck to hide and keep the draft)')}</span></label><p class="hint" data-announcement-updated></p><p role="status" aria-live="polite"></p><div data-announcement-conflict hidden><p class="notice">${L('公告已被另一窗口更新。此处编辑内容已保留，请先载入最新版本再编辑保存。','Another window updated the announcement. Your draft is retained. Load the current version before saving.')}</p><pre data-announcement-current></pre><button type="button" class="button" data-announcement-reload>${L('载入最新版本','Load current version')}</button><details data-announcement-draft hidden><summary>${L('本次未保存的草稿','Unsaved draft')}</summary><pre></pre></details></div><button class="button primary" type="submit">${L('保存公告','Save announcement')}</button></form>`;
  const form=host.querySelector('form'),text=form.elements.content,enabled=form.elements.enabled,save=form.querySelector('[type=submit]'),status=form.querySelector('[role=status]'),conflict=form.querySelector('[data-announcement-conflict]');
  const describe=()=>{form.querySelector('[data-announcement-state]').textContent=current.enabled?L('已发布','Published'):L('未发布','Unpublished');form.querySelector('[data-announcement-updated]').textContent=L('最近保存：','Last saved: ')+date(current.updatedAt);};
  let latest=null,busy=false,blocked=false;describe();
  const recheck=document.createElement('button');recheck.type='button';recheck.className='button';recheck.hidden=true;recheck.textContent=L('重新核对保存结果','Check the save result again');status.after(recheck);
  recheck.onclick=async()=>{
    recheck.disabled=true;
    try{latest=await request('/admin/announcement');if(!isCurrent())return;conflict.hidden=false;form.querySelector('[data-announcement-current]').textContent=latest.content;form.querySelector('[data-announcement-reload]').hidden=false;recheck.hidden=true;status.textContent=L('已重读当前公告，请核对并载入最新版本。编辑内容已保留。','Current announcement reloaded. Review and load its version. Your draft is retained.');}
    catch(error){status.textContent=errorMessage(error)+L(' 草稿已保留，可再次核对。',' The draft is retained. You can check again.');}
    finally{recheck.disabled=false;}
  };
  form.querySelector('[data-announcement-reload]').onclick=()=>{
    if(!latest)return;
    const draft=form.querySelector('[data-announcement-draft]');draft.hidden=false;draft.querySelector('pre').textContent=text.value;
    current=latest;text.value=current.content;enabled.checked=current.enabled;blocked=false;save.disabled=false;describe();status.textContent=L('已载入当前版本，可继续编辑。原草稿保留在下方。','Current version loaded. The previous draft is retained below.');
    form.querySelector('[data-announcement-reload]').hidden=true;
  };
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||blocked)return;
    if(enabled.checked&&!text.value.trim()){status.textContent=L('发布前请填写公告内容。','Enter announcement text before publishing.');return;}
    busy=true;save.disabled=true;status.textContent=L('正在保存…','Saving…');
    const body={expectedVersion:current.version,enabled:enabled.checked,content:text.value};text.disabled=enabled.disabled=true;
    try{current=await request('/admin/announcement',{method:'PATCH',body});if(!isCurrent())return;describe();conflict.hidden=true;status.textContent=L('公告已保存','Announcement saved');}
    catch(error){
      if(!isCurrent())return;
      status.textContent=errorMessage(error)+L(' 编辑内容已保留。',' Your draft is retained.');
      if(error.status===409||error.code==='NETWORK_ERROR'||error.status>=500){
        try{
          latest=await request('/admin/announcement');
          if(!isCurrent())return;
          if(error.status!==409&&latest.enabled===body.enabled&&latest.content===body.content){current=latest;describe();status.textContent=L('已重读并确认公告保存成功','Reloaded and confirmed the saved announcement');}
          else{blocked=true;conflict.hidden=false;form.querySelector('[data-announcement-reload]').hidden=false;form.querySelector('[data-announcement-current]').textContent=latest.content;}
        }catch{blocked=true;recheck.hidden=false;status.textContent+=L(' 当前结果尚无法确认，请保留草稿并重新读取公告。',' The current result is unknown. Keep the draft and reload the announcement.');}
      }
    }finally{busy=false;if(isCurrent()){text.disabled=enabled.disabled=false;save.disabled=blocked;}}
  };
}
