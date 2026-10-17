import {request} from './api.js';
import {M,escape} from './merchant.js';
let configuration={version:0,intervalSeconds:5,items:[]},pending=null,dispose=null,pausedByUser=false;
export function advertisementSlot(){return '<div data-advertisement-slot></div>';}
export async function readAdvertisements(){
  if(!pending)pending=request('/public/advertisements').then(value=>{configuration=value;}).catch(()=>{configuration={version:0,intervalSeconds:5,items:[]};}).finally(()=>{pending=null;});
  await pending;
}
export function clearAdvertisements(){dispose?.();dispose=null;}
export function mountAdvertisements(root){
  clearAdvertisements();const slot=root.querySelector('[data-advertisement-slot]');if(!slot||!configuration.items.length)return;
  let items=[...configuration.items],index=0,timer=null,hover=false,focused=false,stopped=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),controller=new AbortController(),options={signal:controller.signal};
  const carousel=document.createElement('section');carousel.className='advertisement panel';carousel.setAttribute('aria-label',M('校园广告','Campus advertisements'));carousel.setAttribute('aria-roledescription',M('轮播','carousel'));slot.replaceWith(carousel);
  function schedule(){clearTimeout(timer);if(!stopped&&items.length>1&&!pausedByUser&&!hover&&!focused&&!document.hidden&&!reduced.matches)timer=setTimeout(()=>show(index+1),configuration.intervalSeconds*1000);}
  function show(next){
    if(stopped)return;index=(next+items.length)%items.length;const item=items[index];
    carousel.innerHTML=`<p class="advertisement-label">${M('校园广告','Campus advertisements')}</p><div class="advertisement-image"><img src="${escape(item.imageUrl)}" alt="${escape(item.altText||M('校园广告图片','Campus advertisement image'))}"></div>${items.length>1?`<div class="advertisement-controls"><button class="button small" type="button" data-ad-prev aria-label="${M('上一张广告','Previous advertisement')}">‹</button><span data-ad-position aria-live="${pausedByUser?'polite':'off'}">${index+1} / ${items.length}</span><button class="button small" type="button" data-ad-next aria-label="${M('下一张广告','Next advertisement')}">›</button><button class="button small" type="button" data-ad-pause aria-pressed="${pausedByUser||reduced.matches}" ${reduced.matches?'disabled':''}>${reduced.matches?M('手动切换','Manual switching'):pausedByUser?M('播放','Play'):M('暂停','Pause')}</button></div>`:''}`;
    carousel.dataset.adId=item.id;carousel.dataset.interval=configuration.intervalSeconds;
    carousel.querySelector('img').onerror=()=>{items=items.filter(value=>value.id!==item.id);if(!items.length){clearTimeout(timer);carousel.remove();return;}show(index);};
    for(const [selector,delta]of [['[data-ad-prev]',-1],['[data-ad-next]',1]])carousel.querySelector(selector)?.addEventListener('click',()=>{pausedByUser=true;const focus=selector;show(index+delta);carousel.querySelector(focus)?.focus();},options);
    carousel.querySelector('[data-ad-pause]')?.addEventListener('click',()=>{pausedByUser=!pausedByUser;if(reduced.matches)pausedByUser=true;show(index);carousel.querySelector('[data-ad-pause]')?.focus();},options);
    schedule();
  }
  carousel.addEventListener('mouseenter',()=>{hover=true;schedule();},options);carousel.addEventListener('mouseleave',()=>{hover=false;schedule();},options);
  carousel.addEventListener('focusin',()=>{focused=true;schedule();},options);carousel.addEventListener('focusout',()=>{focused=false;schedule();},options);
  document.addEventListener('visibilitychange',schedule,options);reduced.addEventListener('change',()=>show(index),options);
  dispose=()=>{stopped=true;clearTimeout(timer);controller.abort();};show(0);
}
window.addEventListener('pagehide',clearAdvertisements);
