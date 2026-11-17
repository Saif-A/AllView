import 'pdfjs-dist';
import {PDFViewer,PDFLinkService,EventBus,ScrollMode,SpreadMode,DownloadManager} from 'pdfjs-dist/web/pdf_viewer.mjs';
import type {PDFDocumentProxy,RenderTask} from 'pdfjs-dist';
import type {FindTarget} from './find-text';
import type {ContentsItem,ContentsProvider} from './document-outline';
import {createPageWheel} from './pdf-interaction';
import {formatBytes} from './ux';
import './pdf-reader.css';
import {pdfSearch} from './pdf-search';
import type {ZoomAnchor} from './viewer-interaction';
import type {PdfOcrCache} from './pdf-ocr-cache';
import type {DocumentSidebar} from './document-sidebar';

export interface PdfControls {zoom(value:number,moving?:boolean,origin?:ZoomAnchor):void;fit(mode?:string):void;find:FindTarget;contents:ContentsProvider;printPage():Promise<HTMLElement>;cancelInteraction():void;destroy():void}
export async function pdfPreview(stage:HTMLElement,pdf:PDFDocumentProxy,name:string,bytes:number,signal:AbortSignal,icon:(name:string)=>string,onScale:(value:number)=>void,notify:(text:string)=>void,navigation:DocumentSidebar,toolbarHost?:HTMLElement,ocrCache?:PdfOcrCache,afterFirstPaint?:()=>void):Promise<PdfControls>{
 if(pdf.numPages>5000)throw Error('This PDF exceeds the 5,000-page reader limit.');
 stage.className='pdf-reader-stage';stage.replaceChildren();
 const root=document.createElement('section');root.className='pdf-reader';root.setAttribute('aria-label','PDF reader');
 const toolbar=document.createElement('div');toolbar.className=toolbarHost?'format-tools pdf-tools':'pdf-toolbar';toolbar.setAttribute('role',toolbarHost?'group':'toolbar');toolbar.setAttribute('aria-label','PDF viewing controls');
 const group=()=>{const node=document.createElement('div');node.className=toolbarHost?'toolbar-group':'pdf-control-group';toolbar.append(node);return node};let controls=group();
 const body=document.createElement('div');body.className='pdf-reader-body';
 const pagePanel=document.createElement('section');pagePanel.className='pdf-pages-panel';
 const pageModes=document.createElement('div');pageModes.className='pdf-page-modes';pageModes.setAttribute('role','group');pageModes.setAttribute('aria-label','Page view');
 const thumbs=document.createElement('div');thumbs.className='pdf-thumbnails';thumbs.setAttribute('aria-label','Page thumbnails');pagePanel.append(pageModes,thumbs);
 let pagesVisible=false,listMode=false;
 const container=document.createElement('div');container.className='pdf-scroll-container';container.tabIndex=0;container.setAttribute('aria-label','PDF pages');
 const pages=document.createElement('div');pages.className='pdfViewer';container.append(pages);body.append(container);if(toolbarHost)toolbarHost.append(toolbar);else root.append(toolbar);root.append(body);stage.append(root);
 const bus=new EventBus(),links=new PDFLinkService({eventBus:bus,ignoreDestinationZoom:true});links.externalLinkEnabled=false;
 class ReadOnlyDownloads extends DownloadManager{override downloadData(){notify('Embedded file downloads are disabled in this read-only preview.')}override download(){this.downloadData()}override openOrDownloadData(){this.downloadData();return false}}
 const viewer=new PDFViewer({container,viewer:pages,eventBus:bus,linkService:links,downloadManager:new ReadOnlyDownloads(),textLayerMode:1,annotationMode:1,annotationEditorMode:-1,maxCanvasPixels:24_000_000,maxCanvasDim:16384,enableDetailCanvas:false,enableAutoLinking:false,enablePermissions:true,supportsPinchToZoom:false,removePageBorders:true});
 links.setViewer(viewer);links.setDocument(pdf);
 let destroyed=false,hand=false,pan:{id:number;x:number;y:number;left:number;top:number}|null=null;
 const stopZoom=()=>stage.dispatchEvent(new Event('preview-zoom-stop'));
 const cmd=(symbol:string,label:string,action:()=>void)=>{const b=document.createElement('button');b.type='button';b.innerHTML=icon(symbol);b.setAttribute('aria-label',label);b.title=label;b.onclick=action;controls.append(b);return b};
 const pageInput=document.createElement('input');pageInput.type='number';pageInput.min='1';pageInput.max=String(pdf.numPages);pageInput.value='1';pageInput.setAttribute('aria-label','PDF page number');
 const total=document.createElement('span');total.textContent=`/ ${pdf.numPages}`;
 const go=(n:number)=>{if(!destroyed&&Number.isFinite(n))viewer.currentPageNumber=Math.max(1,Math.min(pdf.numPages,Math.round(n)))};
 const first=cmd('first','First page · Home',()=>go(1)),prev=cmd('previous','Previous page · Page Up',()=>viewer.previousPage());controls.append(pageInput,total);
 const next=cmd('next','Next page · Page Down',()=>viewer.nextPage()),last=cmd('last','Last page · End',()=>go(pdf.numPages));
 pageInput.onchange=()=>{go(Number(pageInput.value));pageInput.value=String(viewer.currentPageNumber)};pageInput.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();pageInput.blur();container.focus()}};
 const separator=()=>{controls=group()};
 separator();
 const fit=(mode='page-fit')=>{stopZoom();viewer.currentScaleValue=mode};
 cmd('fit-page','Fit page',()=>fit());cmd('fit-width','Fit width',()=>fit('page-width'));if(!toolbarHost)cmd('actual','Actual size',()=>fit('1'));
 cmd('rotate-left','Rotate left',()=>viewer.pagesRotation=(viewer.pagesRotation+270)%360);cmd('rotate','Rotate right',()=>viewer.pagesRotation=(viewer.pagesRotation+90)%360);
 const layout=document.createElement('select');layout.setAttribute('aria-label','PDF page layout');
 for(const [value,label]of [['single','Single page'],['continuous','Continuous scroll'],['facing','Two pages'],['facing-scroll','Two-page scrolling'],['cover','Two-page scrolling with cover']]){const option=document.createElement('option');option.value=value;option.textContent=label;layout.append(option)}controls.append(layout);
 layout.onchange=()=>{const p=viewer.currentPageNumber;viewer.scrollMode=layout.value==='single'||layout.value==='facing'?ScrollMode.PAGE:ScrollMode.VERTICAL;viewer.spreadMode=layout.value==='cover'?SpreadMode.EVEN:layout.value.startsWith('facing')?SpreadMode.ODD:SpreadMode.NONE;go(p);fit()};
 separator();
 const cancelPan=()=>{if(pan&&container.hasPointerCapture(pan.id))container.releasePointerCapture(pan.id);pan=null;container.classList.remove('pdf-grabbing')};
 const handButton=cmd('hand','Hand tool',()=>{cancelPan();hand=!hand;handButton.setAttribute('aria-pressed',String(hand));container.classList.toggle('pdf-hand',hand)});handButton.setAttribute('aria-pressed','false');
 let thumbnailsStarted=false,thumbTask:RenderTask|null=null;const thumbCache=new Map<number,HTMLCanvasElement>(),thumbQueue=new Set<number>(),thumbButtons=new Map<number,HTMLButtonElement>();let thumbRunning=false;
 const observer=new IntersectionObserver(entries=>{for(const entry of entries){const p=Number((entry.target as HTMLElement).dataset.page);if(entry.isIntersecting&&!thumbCache.has(p))thumbQueue.add(p);else if(!entry.isIntersecting)thumbQueue.delete(p)}void drawThumbnails()},{root:thumbs,rootMargin:'200px'});
 async function drawThumbnails(){if(thumbRunning||destroyed||!pagesVisible||listMode)return;thumbRunning=true;try{while(thumbQueue.size&&!destroyed&&pagesVisible&&!listMode){const p=thumbQueue.values().next().value!;thumbQueue.delete(p);if(thumbCache.has(p))continue;const page=await pdf.getPage(p);if(destroyed)return;const original=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(140/original.width,180/original.height)}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);canvas.setAttribute('aria-hidden','true');thumbTask=page.render({canvas,viewport});await thumbTask.promise;if(destroyed)return;thumbButtons.get(p)?.prepend(canvas);thumbCache.set(p,canvas);if(thumbCache.size>24){const old=thumbCache.keys().next().value!;thumbCache.get(old)?.remove();thumbCache.delete(old)}}}catch(error){if(!destroyed&&(error as Error).name!=='RenderingCancelledException')notify('Some page thumbnails could not be rendered.')}finally{thumbTask=null;thumbRunning=false}}
 const startThumbnails=()=>{if(!thumbnailsStarted){thumbnailsStarted=true;for(let p=1;p<=pdf.numPages;p++){const b=document.createElement('button');b.type='button';b.dataset.page=String(p);b.setAttribute('aria-label',`Go to PDF page ${p}`);if(p===viewer.currentPageNumber)b.setAttribute('aria-current','true');const label=document.createElement('span');label.textContent=`Page ${p}`;b.append(label);b.onclick=()=>go(p);thumbButtons.set(p,b);thumbs.append(b);observer.observe(b)}}void drawThumbnails()};
 for(const [label,compact]of [['Thumbnails',false],['Page list',true]] as const){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-pressed',String(compact===listMode));button.onclick=()=>{listMode=compact;thumbs.classList.toggle('pdf-page-list',listMode);thumbs.setAttribute('aria-label',listMode?'Document page map':'Page thumbnails');for(const peer of pageModes.querySelectorAll('button'))peer.setAttribute('aria-pressed',String(peer===button));if(!listMode)void drawThumbnails()};pageModes.append(button)}
 const removePages=navigation.addView('pages','Pages',pagePanel,visible=>{pagesVisible=visible;if(visible)startThumbnails()});
 let outlinePromise:Promise<ContentsItem[]>|undefined;
 const contents:ContentsProvider=()=>outlinePromise??=(async()=>{const outline=await pdf.getOutline();if(destroyed)return [];const result:ContentsItem[]=[];const walk=(nodes:NonNullable<typeof outline>,depth:number)=>{if(depth>20)return;for(const item of nodes){if(result.length>=2000)return;const destination=item.dest;result.push({id:`pdf-${result.length}`,title:item.title.slice(0,512)||'Untitled bookmark',level:depth+1,disabled:!destination,go:()=>{if(!destroyed&&destination)return links.goToDestination(destination)}});if(item.items?.length)walk(item.items,depth+1)}};if(outline)walk(outline,0);return result})().catch(error=>{outlinePromise=undefined;throw error});
 cmd('pages','Page thumbnails',()=>navigation.open('pages'));if(!toolbarHost)cmd('bookmark','Bookmarks',()=>navigation.open('contents'));
 if(!toolbarHost)cmd('search','Find in PDF · Ctrl+F',()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true})));
 const infoPanel=document.createElement('section');infoPanel.className='pdf-info-panel';infoPanel.tabIndex=0;let infoStarted=false;
 const fillInfo=async()=>{if(infoStarted)return;infoStarted=true;infoPanel.textContent='Loading file information…';try{const metadata=await pdf.getMetadata();if(destroyed)return;const values:Record<string,string>={File:name,Size:formatBytes(bytes),Pages:String(pdf.numPages)};const labels:Record<string,string>={Title:'Title',Author:'Author',Subject:'Subject',Keywords:'Keywords',Creator:'Created with',Producer:'PDF producer',PDFFormatVersion:'PDF version',IsTagged:'Tagged PDF',IsLinearized:'Fast web view',CreationDate:'Created',ModDate:'Modified'};for(const [key,value]of Object.entries(metadata.info??{}))if(labels[key]&&value!==undefined&&value!=='')values[labels[key]]=typeof value==='boolean'?(value?'Yes':'No'):String(value).slice(0,1000);const list=document.createElement('dl');for(const [key,value]of Object.entries(values)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;list.append(dt,dd)}infoPanel.replaceChildren(list)}catch{if(!destroyed){infoStarted=false;infoPanel.textContent='File information could not be loaded. Reopen this tab to retry.'}}};
 const removeInfo=navigation.addView('info','File Info',infoPanel,visible=>{if(visible)void fillInfo()});
 cmd('info','Document properties',()=>navigation.open('info'));
 let firstViewResolve!:()=>void;const firstView=new Promise<void>(resolve=>firstViewResolve=resolve);signal.addEventListener('abort',firstViewResolve,{once:true});
 const find=pdfSearch(pdf,viewer,bus,root,signal,ocrCache,firstView);
 let selectedThumbnail=1;
 const update=()=>{const p=viewer.currentPageNumber;pageInput.value=String(p);first.disabled=prev.disabled=p<=1;next.disabled=last.disabled=p>=pdf.numPages;thumbButtons.get(selectedThumbnail)?.removeAttribute('aria-current');thumbButtons.get(p)?.setAttribute('aria-current','true');selectedThumbnail=p;};
 bus.on('pagechanging',update);bus.on('scalechanging',(e:{scale:number})=>onScale(e.scale));
 let firstPaint=false;bus.on('pagerendered',(event:{error?:unknown})=>{if(!destroyed){notify(`${pdf.numPages} pages · Read only`);if(!firstPaint&&!event.error){firstPaint=true;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!destroyed&&!signal.aborted){afterFirstPaint?.();firstViewResolve()}}))}}});
 const wheel=createPageWheel();container.addEventListener('wheel',e=>{if(e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||viewer.scrollMode!==ScrollMode.PAGE||document.querySelector('dialog[open]'))return;
  const top=container.scrollTop<=1,bottom=container.scrollTop+container.clientHeight>=container.scrollHeight-2;
  if(viewer.currentScaleValue!=='page-fit'&&((e.deltaY<0&&!top)||(e.deltaY>0&&!bottom)))return;e.preventDefault();const step=wheel.step(e.deltaY,e.deltaMode,container.clientHeight,performance.now());if(step<0)viewer.previousPage();else if(step>0)viewer.nextPage();
 },{passive:false,signal});
 document.addEventListener('keydown',e=>{if(destroyed||e.defaultPrevented||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||document.querySelector('dialog[open]')||(e.target instanceof Element&&e.target.closest('input,textarea,select,button,[contenteditable=true],.document-sidebar')))return;let handled=true;if(e.key==='PageDown'||e.key==='ArrowDown')viewer.nextPage();else if(e.key==='PageUp'||e.key==='ArrowUp')viewer.previousPage();else if(e.key==='Home')go(1);else if(e.key==='End')go(pdf.numPages);else handled=false;if(handled)e.preventDefault()},{signal,capture:true});
 container.addEventListener('pointerdown',e=>{if(!hand||e.button!==0||(e.target as Element).closest('a,button,input'))return;e.preventDefault();stopZoom();pan={id:e.pointerId,x:e.clientX,y:e.clientY,left:container.scrollLeft,top:container.scrollTop};container.setPointerCapture(e.pointerId);container.classList.add('pdf-grabbing')},{signal});
 container.addEventListener('pointermove',e=>{if(!pan||e.pointerId!==pan.id)return;container.scrollLeft=pan.left+pan.x-e.clientX;container.scrollTop=pan.top+pan.y-e.clientY},{signal});
 const cancelInteraction=()=>{cancelPan();wheel.reset()};
 for(const event of ['pointerup','pointercancel','lostpointercapture'])container.addEventListener(event,cancelPan,{signal});window.addEventListener('blur',cancelInteraction,{signal});
 // Keep document-origin actions within native read-only authority.
 root.addEventListener('click',e=>{const a=(e.target as Element).closest('a');if(a&&(!a.hash||!a.href.startsWith(location.href.split('#')[0]))){e.preventDefault();e.stopPropagation()}}, {capture:true,signal});
 const resize=new ResizeObserver(()=>{if(!destroyed&&['page-fit','page-width'].includes(viewer.currentScaleValue))viewer.currentScaleValue=viewer.currentScaleValue});resize.observe(container);
 const destroy=()=>{if(destroyed)return;destroyed=true;cancelPan();wheel.reset();observer.disconnect();removePages();removeInfo();resize.disconnect();thumbTask?.cancel();viewer.setDocument(null);links.setDocument(null);find.close?.();toolbar.remove();root.remove()};signal.addEventListener('abort',destroy,{once:true});
 let readyResolve!:()=>void;const ready=new Promise<void>(resolve=>readyResolve=resolve);bus.on('pagesinit',()=>{viewer.scrollMode=ScrollMode.PAGE;fit();update();readyResolve()});viewer.setDocument(pdf);await Promise.race([ready,new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))]);
 return {find,contents,fit,destroy,cancelInteraction,zoom(value,moving=false,origin){if(destroyed)return;if(moving&&value>=.1)viewer.updateScale({scaleFactor:value/viewer.currentScale,drawingDelay:160,origin:origin?[origin.x,origin.y]:undefined});else viewer.currentScaleValue=String(value)},async printPage(){const page=await pdf.getPage(viewer.currentPageNumber),viewport=page.getViewport({scale:1.5,rotation:viewer.pagesRotation});if(viewport.width*viewport.height>24_000_000)throw Error('This page is too large to print.');const section=document.createElement('section'),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvas,viewport}).promise;section.append(canvas);return section}};
}
