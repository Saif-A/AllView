import type { ExtendedInfo, PreviewContext, PreviewControls } from './extended-preview';
import { runFormatWorker } from './worker-client';
import type { ViewerOptions } from '@file-viewer/web';
import {rendererZoom} from './renderer-zoom';
import {documentZoom} from './document-zoom';
import {domContents,locatedContents,type HeadingLocation} from './document-outline';
export async function renderEngine(info:ExtendedInfo,bytes:Uint8Array,ctx:PreviewContext):Promise<PreviewControls>{
  const kind=info.kind.replace('engine-','');
  // Module fetch/initialization and package validation are independent.
  const modules=Promise.all([import('@file-viewer/web'),loadRenderer(kind)]);
  let outline:{headings:HeadingLocation[];error?:string}|undefined;
  const validate=async()=>{
  if(/\.emlx$/i.test(info.name)){
    const newline=bytes.indexOf(10);const length=Number(new TextDecoder().decode(bytes.subarray(0,newline)).trim());
    if(newline<1||!Number.isSafeInteger(length)||length<0||newline+1+length>bytes.length)throw new Error('This EMLX message has an invalid MIME byte count.');
    bytes=bytes.subarray(newline+1,newline+1+length);
  }
  // Validate package expansion before any third-party ZIP-based visual engine sees it.
  if(bytes[0]===0x50&&bytes[1]===0x4b){
    if(/\.(xps|oxps)$/i.test(info.name)){
      const entries=await runFormatWorker<Record<string,Uint8Array>>('unpack',bytes,info.name,ctx.signal);
      const {normalizeXpsResources}=await import('./xps');const changes=normalizeXpsResources(entries);
      if(Object.keys(changes).length)bytes=await runFormatWorker<Uint8Array>('patch-xps',bytes,info.name,ctx.signal,JSON.stringify(changes));
    }else if(kind==='word')outline=await runFormatWorker('validate-word-package',bytes,info.name,ctx.signal);
    else await runFormatWorker<boolean>('validate-package',bytes,info.name,ctx.signal);
  }
  };
  const [[{mountViewer},renderer]]=await Promise.all([modules,validate()]);
  if(kind==='model'&&bytes.length>16*1024*1024)throw new Error('3D models are limited to 16 MiB.');
  if(ctx.signal.aborted)throw new DOMException('Preview cancelled','AbortError');
  const host=document.createElement('div');host.style.height='100%';host.style.width='100%';ctx.stage.className='engine-stage';ctx.stage.replaceChildren(host);
  // Prevent document links from navigating the Tauri window, including shadow DOM links.
  host.addEventListener('click',event=>{for(const target of event.composedPath())if(target instanceof HTMLAnchorElement&&target.getAttribute('href')&&!target.getAttribute('href')!.startsWith('#'))event.preventDefault();},true);
  let resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
  const ready=kind==='word'?new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject}):null;
  let wordZoom:ReturnType<typeof rendererZoom>|ReturnType<typeof documentZoom>|undefined,disposed=false;
  const controller=mountViewer(host,{
    buffer:bytes.slice().buffer,filename:info.name.replace(/\.ott$/i,'.odt').replace(/\.ots$/i,'.ods').replace(/\.emlx$/i,'.eml').replace(/\.oxps$/i,'.xps'),
    options:{
      rendererMode:'replace',renderers:[renderer] as unknown as ViewerOptions['renderers'],theme:'light',locale:'en-US',
      toolbar:{download:false,print:false,exportHtml:false,theme:false,zoom:false,search:false,position:'bottom-right',permissions:{download:false,print:false,'export-html':false}},
      docx:{worker:true,workerUrl:'/file-viewer/vendor/docx/docx.worker.js',workerJsZipUrl:'/file-viewer/vendor/docx/jszip.min.js',workerTimeout:20000,visualPagination:true,renderAltChunks:false,externalLinkPolicy:'block',externalResourcePolicy:'block'},
      spreadsheet:{worker:true,workerUrl:'/file-viewer/vendor/xlsx/sheet.worker.js'},
      presentation:{workerUrl:'/file-viewer/vendor/pptx/pptx.worker.js'},
      geo:{basemap:'none'},
      cad:{wasmPath:'/file-viewer/wasm/cad/0.8.3/',workerUrl:'/file-viewer/wasm/cad/0.8.3/dwg-worker.js',dwfWasmUrl:'/file-viewer/wasm/cad/0.8.3/dwfv-render.wasm',workerTimeoutMs:20000,preloadDwg:false,maxInsertDepth:32,dwfMaxDevicePixelRatio:2,dwfMaxCanvasPixels:24000000,dwfMaxGpuCacheBytes:128*1024*1024,dwfMaxCachedScenes:1,...(/\.(xps|oxps)$/i.test(info.name)?{dwfBackground:'#ffffff',canvasOptions:{background:'#ffffff',foreground:'#000000'}}:{})},
    },
    onStateChange:state=>{if(disposed||ctx.signal.aborted)return;if(state.error){ctx.notify(`Visual renderer: ${String(state.error)}`);rejectReady?.(new Error(String(state.error)))}else if(state.ready){resolveReady?.();wordZoom?.observe();ctx.notify('Local visual preview · Read only');}},
  },{fetchFile:async()=>{throw new Error('External document resources are disabled.');}});
  const decoration=document.createElement('style');decoration.dataset.avPageDecorations='';
  decoration.textContent=':is(.page,[class$="-page"],[class*="-page "],[class$="-paper"],[class*="-paper "],[class$="-slide"],[class*="-slide "]){box-shadow:none!important}.docx-page-frame>section.docx,.docx-flow-frame>section.docx,.docx-wrapper>section.docx,.word-page,.msdoc-page,.wordml-page,.odf-page,.rtf-page,.flyfish-rtf-paper,.pptx-slide,.slide-page{box-shadow:none!important;filter:none!important;outline:1px solid var(--border,#b7b7b7);outline-offset:0}::highlight(av-find){background:#ffe36a;color:#171717}::highlight(av-find-active){background:#ffab45;color:#171717}@media print{.docx-page-frame>section.docx,.docx-flow-frame>section.docx,.word-page,.msdoc-page,.wordml-page,.odf-page,.rtf-page,.flyfish-rtf-paper{outline:none!important}}';
  (host.shadowRoot??host).append(decoration);
  if(kind==='cad'){
    const style=document.createElement('style');
    // Keep warnings and file/page controls, while hiding backend/debug identifiers.
    style.textContent='.cad-meta span:last-child,.dwfv-status:not(.dwfv-warn):not(:has(.dwfv-warn)){display:none!important}';
    (host.shadowRoot??host).append(style);
  }
  const dispose=()=>{if(!disposed){disposed=true;clearTimeout(timer);controller.destroy()}};
  const timer=setTimeout(()=>{if(!ctx.signal.aborted&&!controller.getState().ready){dispose();const error=new Error('This visual preview exceeded the 30-second processing limit.');ctx.notify(error.message);rejectReady?.(error)}},30000);
  ctx.signal.addEventListener('abort',()=>{dispose();rejectReady?.(new DOMException('Preview cancelled','AbortError'))},{once:true});
  if(ready){
    try{await ready;if(ctx.signal.aborted)throw new DOMException('Preview cancelled','AbortError')}
    catch(error){dispose();throw error}
    clearTimeout(timer);
    const api=controller.getApi();const findRoot=api&&'container'in api&&api.container instanceof HTMLElement?api.container:host.shadowRoot??host;
    const nativeZoom=controller.getState().zoom;
    if(nativeZoom&&(nativeZoom.canZoomIn||nativeZoom.canZoomOut))wordZoom=rendererZoom(controller,ctx.signal,value=>ctx.zoomChanged?.(value),ctx.notify);
    else{
      const viewport=findRoot.querySelector<HTMLElement>('.file-render');
      const content=viewport&&Array.from(viewport.children).find((node):node is HTMLElement=>node instanceof HTMLElement&&node.tagName!=='STYLE');
      if(!viewport||!content){dispose();throw new Error('This Word preview has no zoomable document surface.');}
      const page=content.querySelector<HTMLElement>('.odf-page,.flyfish-rtf-paper,.word-page,.msdoc-page,.wordml-page')??content;
      wordZoom=documentZoom(viewport,content,page,ctx.signal,value=>ctx.zoomChanged?.(value));
    }
    wordZoom.observe();
    return {initialZoom:wordZoom.initialZoom,zoom:wordZoom.zoom,fit:wordZoom.fit,cancelPan:wordZoom.cancel,findRoot,contents:()=>{if(outline?.error)throw Error(outline.error);return outline?.headings.length?locatedContents(findRoot,outline.headings):domContents(findRoot)}};
  }
  return ['data','email'].includes(kind)?{}:{zoom:value=>{host.style.zoom=String(value);host.style.width=`${100/value}%`;host.style.height=`${100/value}%`;}};
}
async function loadRenderer(kind:string){
  return kind==='word'?(await import('@file-viewer/renderer-word')).wordRenderer
    :kind==='presentation'?(await import('@file-viewer/renderer-pptx')).pptxRenderer
    :kind==='spreadsheet'?(await import('@file-viewer/renderer-spreadsheet')).spreadsheetRenderer
    :kind==='geo'?(await import('@file-viewer/renderer-geo')).geoRenderer
    :kind==='drawing'?(await import('@file-viewer/renderer-drawing')).drawingRenderer
    :kind==='bpmn'?(await import('@file-viewer/renderer-drawing/bpmn')).bpmnRenderer
    :kind==='model'?(await import('@file-viewer/renderer-3d')).modelRenderer
    :kind==='dicom'?(await import('@file-viewer/renderer-dicom')).dicomRenderer
    :kind==='email'?(await import('@file-viewer/renderer-email')).emailRenderer
    :kind==='iwork'?(await import('@file-viewer/renderer-iwork')).iworkRenderer
    :kind==='wordperfect'?(await import('@file-viewer/renderer-wordperfect')).wordPerfectRenderer
    :kind==='hangul'?(await import('@file-viewer/renderer-hangul')).hangulRenderer
    :kind==='cad'?(await import('@file-viewer/renderer-cad')).cadRenderer
    :(await import('@file-viewer/renderer-data')).dataRenderer;
}
