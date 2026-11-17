import type {ExtendedInfo,PreviewContext,PreviewControls} from './extended-preview';
import './paged-preview.css';
import {sanitizeSvg} from './safe-document';

interface Raster {width:number;height:number;pixels?:Uint8ClampedArray<ArrayBuffer>;svg?:string;page:number}
export async function renderPaged(info:ExtendedInfo,bytes:Uint8Array,ctx:PreviewContext):Promise<PreviewControls>{
  const worker=new Worker(new URL('./paged.worker.ts',import.meta.url),{type:'module'});
  let serial=0,dead=false,pageCount=0,current=0,zoom=1,dirty=false,rendering=false,fitted=false;
  const pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const stop=(error:Error)=>{if(dead)return;dead=true;worker.terminate();for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
  const cancel=()=>stop(new DOMException('Preview cancelled','AbortError'));
  if(ctx.signal.aborted){cancel();throw new DOMException('Preview cancelled','AbortError');}
  ctx.signal.addEventListener('abort',cancel,{once:true});
  const request=<T>(data:Record<string,unknown>,transfer:Transferable[]=[]):Promise<T>=>new Promise((resolve,reject)=>{
    if(dead){reject(new Error('The page decoder has stopped. Reopen the file to retry.'));return;}
    const id=++serial,timer=setTimeout(()=>stop(new Error('This page exceeded the 20-second processing limit.')),20000);
    pending.set(id,{resolve:value=>resolve(value as T),reject,timer});worker.postMessage({...data,id},transfer);
  });
  worker.onmessage=event=>{const item=pending.get(event.data.id);if(!item)return;clearTimeout(item.timer);pending.delete(event.data.id);if(event.data.ok)item.resolve(event.data.result);else item.reject(new Error(event.data.error));};
  worker.onerror=()=>stop(new Error('This page decoder failed. The document may be malformed or unsupported.'));
  const wrapper=document.createElement('div');wrapper.className='paged-viewer';
  const bar=document.createElement('div');bar.className=ctx.toolbar?'format-tools toolbar-group':'preview-toolbar';bar.setAttribute('role','group');bar.setAttribute('aria-label','Page navigation');
  const previous=document.createElement('button'),next=document.createElement('button'),input=document.createElement('input'),count=document.createElement('span');
  previous.textContent='Previous page';next.textContent='Next page';previous.setAttribute('aria-label','Previous page');next.setAttribute('aria-label','Next page');previous.title='Previous page';next.title='Next page';if(ctx.toolbar&&ctx.icon){previous.innerHTML=ctx.icon('previous');next.innerHTML=ctx.icon('next')}input.type='number';input.min='1';input.value='1';input.setAttribute('aria-label','Page number');
  const body=document.createElement('div');body.className='paged-scroll';const canvas=document.createElement('canvas');canvas.setAttribute('role','img');canvas.setAttribute('aria-label',info.name+' page');const image=document.createElement('img');let imageUrl='';body.append(canvas);bar.append(previous,input,count,next);if(ctx.toolbar)ctx.toolbar.append(bar);else wrapper.append(bar);wrapper.append(body);ctx.signal.addEventListener('abort',()=>bar.remove(),{once:true});
  const redraw=async()=>{
    dirty=true;if(rendering)return;rendering=true;
    try{
      while(dirty&&!dead&&!ctx.signal.aborted){
        dirty=false;const page=current,wantedZoom=zoom;
        const result=await request<Raster>({operation:'render',page,zoom:wantedZoom,viewport:Math.max(200,body.clientWidth-16),dpr:devicePixelRatio});
        if(dead||ctx.signal.aborted)return;
        if(page!==current||wantedZoom!==zoom){dirty=true;continue;}
        if(!fitted){fitted=true;await ctx.fitContent?.(result.width,result.height,ctx.toolbar?0:44);if(dead||ctx.signal.aborted)return;dirty=true;continue;}
        if(result.svg){
          if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(new Blob([sanitizeSvg(result.svg)],{type:'image/svg+xml'}));image.src=imageUrl;
          await image.decode();if(dead||ctx.signal.aborted)return;if(page!==current||wantedZoom!==zoom){dirty=true;continue;}
          image.alt=info.name+' · Slide '+(page+1)+' of '+pageCount;image.dataset.page=String(page+1);
          image.style.width=Math.min(result.width,Math.max(200,body.clientWidth-16))*zoom+'px';body.replaceChildren(image);
          ctx.notify('Slide '+(page+1)+' of '+pageCount+' · Local visual preview · Read only');continue;
        }
        if(!result.pixels)throw new Error('This page decoder returned no pixels.');
        canvas.width=result.width;canvas.height=result.height;body.replaceChildren(canvas);
        const context=canvas.getContext('2d');if(!context)throw new Error('A page canvas could not be created.');
        context.putImageData(new ImageData(result.pixels,result.width,result.height),0,0);
        const scanned=/\.(djvu|djv)$/i.test(info.name);
        const logicalWidth=scanned?Math.min(result.width,Math.max(200,body.clientWidth-16))*zoom:result.width/Math.min(devicePixelRatio,2);
        canvas.style.width=logicalWidth+'px';canvas.style.height=logicalWidth*result.height/result.width+'px';
        canvas.setAttribute('aria-label',info.name+' · Page '+(page+1)+' of '+pageCount);
        canvas.dataset.page=String(page+1);ctx.notify('Page '+(page+1)+' of '+pageCount+' · Local visual preview · Read only');
      }
    }catch(error){if(!ctx.signal.aborted)ctx.notify(error instanceof Error?error.message:String(error));throw error;}
    finally{rendering=false;}
  };
  const move=(page:number)=>{if(dead)return;current=Math.max(0,Math.min(pageCount-1,page));input.value=String(current+1);previous.disabled=current===0;next.disabled=current===pageCount-1;body.scrollTop=0;void redraw().catch(()=>{});};
  previous.onclick=()=>move(current-1);next.onclick=()=>move(current+1);input.onchange=()=>{const page=Number(input.value);if(Number.isInteger(page))move(page-1);else input.value=String(current+1);};
  let resizeTimer:ReturnType<typeof setTimeout>|undefined;
  const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(pageCount&&!dead)void redraw().catch(()=>{});},150);});
  ctx.signal.addEventListener('abort',()=>{observer.disconnect();clearTimeout(resizeTimer);canvas.width=canvas.height=0;if(imageUrl)URL.revokeObjectURL(imageUrl);image.removeAttribute('src');},{once:true});
  try{
    const copy=bytes.slice();const opened=await request<{pageCount:number}>({operation:'open',bytes:copy,extension:info.name.toLowerCase().split('.').pop()},[copy.buffer]);
    if(ctx.signal.aborted)throw new DOMException('Preview cancelled','AbortError');
    pageCount=opened.pageCount;count.textContent='of '+pageCount;input.max=String(pageCount);previous.disabled=true;next.disabled=pageCount===1;
    ctx.stage.className='paged-stage';ctx.stage.replaceChildren(wrapper);await redraw();observer.observe(body);
  }catch(error){stop(error instanceof Error?error:new Error(String(error)));throw error;}
  return {contents:async()=>{const entries=await request<{title:string;level:number;page:number}[]>({operation:'contents'});return entries.map((item,i)=>({id:`page-heading-${i}`,title:item.title,level:item.level,disabled:item.page<0||item.page>=pageCount,go:()=>move(item.page)}))},zoom:value=>{zoom=value;void redraw().catch(()=>{});}};
}
