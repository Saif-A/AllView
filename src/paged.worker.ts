import {rasterScale,PAGE_PIXEL_LIMIT} from './paged-limits';
import {unpackZip} from './archive';
import type {Document as MuDocument} from 'mupdf';
import type DjDocument from 'djvujs-dist/library/src/DjVuDocument';

interface Job {id:number;operation:'open'|'render'|'contents';bytes?:Uint8Array;extension?:string;page?:number;viewport?:number;zoom?:number;dpr?:number}
declare const self:{onmessage:((event:MessageEvent<Job>)=>void)|null;postMessage:(value:unknown,transfer?:Transferable[])=>void};
let mu:typeof import('mupdf')|undefined,document:MuDocument|undefined,djvu:DjDocument|undefined,pageCount=0;
let ppt:import('@file-viewer/ppt').ParsedPptDocument|undefined,pptEngine:typeof import('@file-viewer/ppt')|undefined;
async function perform(job:Job):Promise<unknown>{
  if(job.operation==='open'){
    const bytes=job.bytes,ext=job.extension;
    if(!bytes||!ext||bytes.length>64*1024*1024)throw new Error('This paged document exceeds the 64 MiB preview limit.');
    if(!['ppt','pps','mobi','fb2','djvu','djv'].includes(ext))throw new Error('Unknown paged document decoder.');
    if(bytes[0]===0x50&&bytes[1]===0x4b)unpackZip(bytes);
    if(ext==='mobi'){
      if(bytes.length<94)throw new Error('This Mobipocket header is truncated.');
      const header=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),first=header.getUint32(78);
      if(header.getUint16(76)<2||first<94||first+16>bytes.length)throw new Error('This Mobipocket record table is invalid.');
      if(header.getUint16(first+12)!==0)throw new Error('Encrypted or DRM-protected Mobipocket books cannot be previewed.');
    }
    if(ext==='ppt'||ext==='pps'){
      pptEngine=await import('@file-viewer/ppt');
      ppt=pptEngine.parsePpt(bytes,{limits:{maxFileBytes:64*1024*1024,maxStreamBytes:64*1024*1024,maxRecords:150000,maxDepth:64,maxSlides:1000,maxShapes:20000,maxAssetBytes:32*1024*1024,maxTextLength:4*1024*1024}});
      if(!Number.isFinite(ppt.size.width)||!Number.isFinite(ppt.size.height)||ppt.size.width<=0||ppt.size.height<=0||ppt.size.width*ppt.size.height>PAGE_PIXEL_LIMIT)throw new Error('This presentation has invalid or excessive page dimensions.');
      pageCount=ppt.slides.length;
    }else if(ext==='djvu'||ext==='djv'){
      const {default:Document}=await import('djvujs-dist/library/src/DjVuDocument');
      djvu=new Document(bytes.slice().buffer,{baseUrl:null,memoryLimit:64*1024*1024});
      // An indirect document requires filesystem sidecars, never arbitrary URL requests.
      if(!djvu.isBundled())throw new Error('Indirect DjVu documents need additional page files; open a bundled DjVu document.');
      pageCount=djvu.getPagesQuantity();
    }else{
      if(ext==='fb2'&&/<!DOCTYPE|<!ENTITY/i.test(new TextDecoder().decode(bytes)))throw new Error('External document type/entity declarations are disabled.');
      mu=await import('mupdf');document=mu.Document.openDocument(bytes,ext);
      if(document.needsPassword())throw new Error('Protected documents cannot be previewed.');
      if(ext==='fb2'||ext==='mobi')document.layout(612,792,12);
      pageCount=document.countPages();
    }
    if(!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>10000)throw new Error('This document exceeds the 10,000-page preview limit or contains no pages.');
    return {pageCount};
  }
  if(job.operation==='contents'){
    const result:{title:string;level:number;page:number}[]=[];
    if(document){
      const outline=document.loadOutline();const walk=(items:NonNullable<typeof outline>,depth:number)=>{if(depth>20)return;for(const item of items){if(result.length===2000)return;let page=item.page??-1;if(page<0&&item.uri?.startsWith('#'))page=document!.resolveLink(item.uri);result.push({title:(item.title??'Untitled section').slice(0,512),level:depth+1,page});if(item.down)walk(item.down,depth+1)}};if(outline)walk(outline,0);
    }else if(djvu){
      const walk=(items:NonNullable<ReturnType<DjDocument['getContents']>>,depth:number)=>{if(depth>20)return;for(const item of items){if(result.length===2000)return;const destination=item.url?.startsWith('#')?djvu!.getPageNumberByUrl(item.url):null;result.push({title:(item.description??'Untitled section').slice(0,512),level:depth+1,page:destination?destination-1:-1});if(item.children)walk(item.children,depth+1)}};const outline=djvu.getContents();if(outline)walk(outline,0);
    }
    return result;
  }
  const index=job.page??0;
  if(!Number.isSafeInteger(index)||index<0||index>=pageCount)throw new Error('This page is not available.');
  if(ppt&&pptEngine){
    const svg=pptEngine.renderSlideSvg(ppt,index,{textLayout:'measured',textOutput:'svg',mediaControls:false,textMeasurer:pptEngine.createCanvasTextMeasurer()});
    if(svg.length>16*1024*1024)throw new Error('This slide exceeds the 16 MiB vector output limit.');
    return {width:ppt.size.width,height:ppt.size.height,svg,page:index};
  }
  if(djvu){
    const page=await djvu.getPage(index+1);
    try{
      const width=page.getWidth(),height=page.getHeight();
      if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>PAGE_PIXEL_LIMIT)throw new Error('This scanned page exceeds the 24-megapixel preview budget.');
      const data=page.getImageData();
      if(data.width*data.height>PAGE_PIXEL_LIMIT)throw new Error('This rotated page exceeds the pixel budget.');
      return {width:data.width,height:data.height,pixels:data.data.slice(),page:index};
    }finally{page.reset();}
  }
  if(!mu||!document)throw new Error('The page decoder is not open.');
  const page=document.loadPage(index);
  try{
    const scale=rasterScale(page.getBounds(),job.viewport??800,job.zoom??1,job.dpr??1);
    const pixmap=page.toPixmap(mu.Matrix.scale(scale,scale),mu.ColorSpace.DeviceRGB,true,false);
    try{
      const width=pixmap.getWidth(),height=pixmap.getHeight();
      if(width*height>PAGE_PIXEL_LIMIT||pixmap.getNumberOfComponents()!==4)throw new Error('This raster exceeds the page pixel budget.');
      const pixels=pixmap.getPixels().slice();
      // MuPDF stores premultiplied RGBA; Canvas ImageData expects straight RGBA.
      for(let i=0;i<pixels.length;i+=4){const alpha=pixels[i+3];if(alpha>0&&alpha<255)for(let c=0;c<3;c++)pixels[i+c]=Math.min(255,Math.round(pixels[i+c]*255/alpha));}
      return {width,height,pixels,page:index};
    }finally{pixmap.destroy();}
  }finally{page.destroy();}
}
self.onmessage=async event=>{
  try{
    const result=await perform(event.data);
    const pixels=(result as {pixels?:Uint8ClampedArray}).pixels;
    self.postMessage({id:event.data.id,ok:true,result},pixels?[pixels.buffer as ArrayBuffer]:[]);
  }catch(error){const message=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);self.postMessage({id:event.data.id,ok:false,error:message.slice(0,1000)});}
};
