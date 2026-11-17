import {OPS,type PDFDocumentProxy,type PDFPageProxy,type RenderTask} from 'pdfjs-dist';
import type {PDFViewer,EventBus} from 'pdfjs-dist/web/pdf_viewer.mjs';
import {OfflineOcrWorker} from './offline-ocr-worker';
import {findSnippet,type FindTarget,type FindResult,type FindOptions,type FindItem} from './find-text';
import {preparePdfText,preparedPdfMatches,scannedPageCandidate,type PreparedPdfText} from './pdf-search-text';
import {pdfImageCoverage} from './pdf-scan';
import type {PdfOcrCache,CachedOcrPage,CachedNativePage} from './pdf-ocr-cache';
import {ocrRasterScale,ocrWordsFromTsv,indexingValue,ocrWorkerLimit,type IndexingProgress} from './ocr-indexing';

type Quad=[number,number,number,number,number,number,number,number];
interface Box {from:number;to:number;quad:Quad;rtl?:boolean}
interface PageText {text:string;boxes:Box[];ocr:boolean;prepared?:PreparedPdfText;matchedKey?:string}
interface Hit {page:number;from:number;to:number}
interface OcrSlot {worker?:OfflineOcrWorker;render?:RenderTask;page:number;epoch:number;progress?:number;stage:string}
const TEXT_LIMIT=8*1024*1024,BOX_LIMIT=100000,MATCH_LIMIT=10000;
const turn=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
export function pdfSearch(pdf:PDFDocumentProxy,viewer:PDFViewer,bus:EventBus,root:HTMLElement,signal:AbortSignal,disk?:PdfOcrCache,previewReady:Promise<void>=Promise.resolve()):FindTarget{
 const cache=new Map<number,PageText>(),attempted=new Set<number>(),scanned=new Set<number>(),needed=new Set<number>(),failed=new Set<number>(),recognized=new Set<number>();
 let textSize=0,normalizedSize=0,boxSize=0,generation=0,closed=true,destroyed=false,indexing=false,running=false,paused=false,limited=false,textLimited=false;
 let query='',options:FindOptions={caseSensitive:false,wholeWord:false},key='',hits:Hit[]=[],index=-1;
 const matchesByPage=new Map<number,Hit[]>();
 let report:((result:FindResult)=>void)|undefined;
 const slots:OcrSlot[]=Array.from({length:ocrWorkerLimit(navigator.hardwareConcurrency,(navigator as Navigator&{deviceMemory?:number}).deviceMemory)},()=>({page:0,epoch:0,stage:''}));
 let reveal=false,paintFrame=0,ocrBudget=0,batchStarted=0,detail='';
 let progressTimer:ReturnType<typeof setTimeout>|undefined,lastProgressAt=0,items:FindItem[]=[];
 let diskStarted=false,diskReady=false,persisting=false,cacheGrace:Promise<unknown>=Promise.resolve();
 const stored=new Map<number,CachedOcrPage>(),pendingSaves=new Map<number,CachedOcrPage>();
 async function persist(){if(!diskReady||!disk||persisting||signal.aborted)return;persisting=true;try{while(pendingSaves.size&&!signal.aborted){const [number,page]=pendingSaves.entries().next().value!;pendingSaves.delete(number);await disk.save(page).catch(()=>{});await turn()}}finally{persisting=false}}
 function remember(page:CachedOcrPage){if(!disk||signal.aborted)return;const old=pendingSaves.get(page.page);pendingSaves.set(page.page,{...old,...page,native:page.native??old?.native,...page.ocr===false&&old?.ocr!==false&&old?{text:old.text,boxes:old.boxes,ocr:old.ocr}:{}});void persist()}
 function loadDisk(){if(diskStarted)return;diskStarted=true;const loaded=Promise.resolve(disk?.load()??[]).then(pages=>{if(signal.aborted)return;for(const page of pages){if(Number.isInteger(page.page)&&page.page>0&&page.page<=pdf.numPages&&typeof page.text==='string'&&page.text.length<=1024*1024&&Array.isArray(page.boxes)&&page.boxes.length<=20000)stored.set(page.page,page)}}).catch(()=>{}).finally(()=>{diskReady=true;void persist()});cacheGrace=Promise.race([loaded,new Promise(resolve=>setTimeout(resolve,150))])}
 const merge=(native:PageText|undefined,ocr:PageText):PageText=>{if(!native||native.ocr||!native.text.trim())return ocr;const offset=native.text.length+1;return {text:native.text+'\n'+ocr.text,boxes:[...native.boxes,...ocr.boxes.map(box=>({...box,from:box.from+offset,to:box.to+offset}))],ocr:true}};
 const alive=(token:number)=>!destroyed&&!closed&&!signal.aborted&&token===generation;
 const id=(hit:Hit|undefined)=>hit?`${hit.page}:${hit.from}:${hit.to}`:'';
 function save(page:number,data:PageText){
  const old=cache.get(page),size=textSize-(old?.text.length??0)+data.text.length,boxes=boxSize-(old?.boxes.length??0)+data.boxes.length;
  if(size>TEXT_LIMIT||boxes>BOX_LIMIT){limited=textLimited=true;detail='Search text limit reached; some pages are not indexed.';return false}
  data.prepared=old?.text===data.text?old.prepared:preparePdfText(data.text);const normalized=normalizedSize-(old?.prepared?.value.length??0)+(data.prepared?.value.length??0);
  if(normalized>TEXT_LIMIT){limited=textLimited=true;detail='Search text limit reached; some pages are not indexed.';return false}
  if(data.prepared?.limited){limited=textLimited=true;detail='A page exceeds its normalized search limit; results are partial.'}
  textSize=size;normalizedSize=normalized;boxSize=boxes;cache.set(page,data);return true;
 }
 function update(reset=false,changed?:number){
  if(closed||destroyed||!report)return;
  const selected=reset?'':id(hits[index]);let changedMatches=reset;if(reset){matchesByPage.clear();limited=textLimited}
  for(const page of changed!==undefined?[changed]:[...cache.keys()].filter(n=>cache.get(n)?.matchedKey!==key)){const data=cache.get(page);if(!data?.prepared)continue;const found=preparedPdfMatches(data.prepared,query,options,MATCH_LIMIT);data.matchedKey=key;const previous=matchesByPage.has(page);if(found.matches.length)matchesByPage.set(page,found.matches.map(match=>({page,...match})));else matchesByPage.delete(page);if(previous||found.matches.length)changedMatches=true;if(found.limited)limited=true}
  if(!changedMatches){progressChanged();return}hits=[];
  for(const [,pageHits]of [...matchesByPage].sort((a,b)=>a[0]-b[0])){hits.push(...pageHits.slice(0,MATCH_LIMIT-hits.length));if(hits.length>=MATCH_LIMIT){limited=true;break}}
  index=selected?hits.findIndex(hit=>id(hit)===selected):-1;
  if(index<0&&hits.length){index=hits.findIndex(hit=>hit.page>=viewer.currentPageNumber);if(index<0)index=0;reveal=true}
  const resultKey=key;
  items=hits.slice(0,200).map(hit=>({label:`Page ${hit.page}`,detail:cache.get(hit.page)?.ocr?'OCR':undefined,snippet:findSnippet(cache.get(hit.page)!.text,hit.from,hit.to),go:()=>{if(closed||resultKey!==key)return;index=hits.findIndex(current=>id(current)===id(hit));reveal=true;go(hits[index]);emit();paintSoon()}}));
  emit();paintSoon();if(reveal&&hits[index])go(hits[index]);
 }
 function emit(){
  if(closed||destroyed||!report)return;
  const pending=indexing||running||!paused&&!textLimited&&(attempted.size<pdf.numPages||needed.size>0);
  const active=slots.filter(slot=>slot.page),focus=active.find(slot=>slot.page===viewer.currentPageNumber)??active[0],activePage=focus?.page??0,pageProgress=focus?.progress,stage=focus?.stage??'Checking page text';
  let message=detail||'';if(!pending&&failed.size)message=`${failed.size} ${failed.size===1?'page could':'pages could'} not be searched`;
  const progress:IndexingProgress={...indexingValue(scanned.size,recognized.size,pending,active.reduce((sum,slot)=>sum+(recognized.has(slot.page)?0:slot.progress??0),0)),total:pdf.numPages,checked:attempted.size,scanned:scanned.size,recognized:recognized.size,failed:failed.size,state:pending?'working':paused?'paused':failed.size||textLimited?'partial':'ready',stage:pending?stage:paused?'Indexing paused':failed.size||textLimited?'Indexing incomplete':'Indexing complete',page:activePage||undefined,pageProgress,active:active.length};
  const hit=hits[index];
  report({current:index+1,total:hits.length,limited,pending,items,itemsLabel:'Matches (up to 200)',message,indexing:progress,snippet:hit?findSnippet(cache.get(hit.page)!.text,hit.from,hit.to):undefined,
   cancel:pending?pause:undefined,resume:!pending&&(paused||failed.size>0)?resume:undefined});
 }
 function progressChanged(){const elapsed=performance.now()-lastProgressAt;if(elapsed>=100){clearTimeout(progressTimer);progressTimer=undefined;lastProgressAt=performance.now();emit()}else if(!progressTimer)progressTimer=setTimeout(()=>{progressTimer=undefined;lastProgressAt=performance.now();emit()},100-elapsed)}
 function go(hit:Hit|undefined){if(!hit||destroyed||closed)return;viewer.currentPageNumber=hit.page;reveal=true;paintSoon()}
 function paintSoon(){cancelAnimationFrame(paintFrame);paintFrame=requestAnimationFrame(paint)}
 function paint(){
  root.querySelectorAll('.av-pdf-find-layer').forEach(node=>node.remove());if(closed||destroyed)return;
  const current=hits[index];
  for(const view of root.querySelectorAll<HTMLElement>('.pdfViewer .page:has(canvas)')){
   const page=Number(view.dataset.pageNumber),data=cache.get(page);if(!data||!hits.some(hit=>hit.page===page))continue;
   const pageView=viewer.getPageView(page-1);if(!pageView?.viewport)continue;
   const layer=document.createElement('div');layer.className='av-pdf-find-layer';layer.setAttribute('aria-hidden','true');
   const pageHits=hits.filter(hit=>hit.page===page);let cursor=0,marks=0;
   for(const box of data.boxes){while(cursor<pageHits.length&&pageHits[cursor].to<=box.from)cursor++;for(let j=cursor;j<pageHits.length&&pageHits[j].from<box.to;j++){const hit=pageHits[j];if(marks>=2000&&hit!==current)continue;marks++;
    const length=Math.max(1,box.to-box.from);let start=Math.max(0,hit.from-box.from)/length,end=Math.min(length,hit.to-box.from)/length;if(box.rtl)[start,end]=[1-end,1-start];
    const q=box.quad,points=[[q[0]+(q[2]-q[0])*start,q[1]+(q[3]-q[1])*start],[q[0]+(q[2]-q[0])*end,q[1]+(q[3]-q[1])*end],[q[6]+(q[4]-q[6])*end,q[7]+(q[5]-q[7])*end],[q[6]+(q[4]-q[6])*start,q[7]+(q[5]-q[7])*start]].map(([x,y])=>pageView.viewport.convertToViewportPoint(x,y));
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),mark=document.createElement('span');mark.className='av-pdf-match'+(hit===current?' active':'');mark.style.left=`${Math.min(...xs)}px`;mark.style.top=`${Math.min(...ys)}px`;mark.style.width=`${Math.max(2,Math.max(...xs)-Math.min(...xs))}px`;mark.style.height=`${Math.max(2,Math.max(...ys)-Math.min(...ys))}px`;layer.append(mark);
   }}view.append(layer);
  }
  if(reveal){const mark=root.querySelector('.av-pdf-match.active');if(mark){reveal=false;mark.scrollIntoView({block:'center',inline:'nearest'})}}
 }
 async function extract(page:PDFPageProxy):Promise<PageText>{
  const content=await page.getTextContent(),data:PageText={text:'',boxes:[],ocr:false};
  for(const item of content.items){if(!('str'in item)||!item.str)continue;if(data.text.length+item.str.length>1024*1024||data.boxes.length>=20000){limited=textLimited=true;detail='A page exceeds its search text limit; results are partial.';break}
   const from=data.text.length;data.text+=item.str;const [a,b,c,d,x,y]=item.transform,h=Math.hypot(c,d)||item.height,w=Math.hypot(a,b)||1,ux=a/w*item.width,uy=b/w*item.width,vx=c/(h||1)*item.height,vy=d/(h||1)*item.height;
   const ascent=content.styles[item.fontName]?.ascent??.8,descent=content.styles[item.fontName]?.descent??-.2;
   data.boxes.push({from,to:data.text.length,rtl:item.dir==='rtl',quad:[x+vx*ascent,y+vy*ascent,x+ux+vx*ascent,y+uy+vy*ascent,x+ux+vx*descent,y+uy+vy*descent,x+vx*descent,y+vy*descent]});data.text+=item.hasEOL?'\n':' ';
  }return data;
 }
 async function loadWorker(slot:OcrSlot,live:()=>boolean){
  const candidate=slot.worker??=new OfflineOcrWorker(new URL(`${import.meta.env.BASE_URL}ocr/`,document.baseURI).href);
  candidate.onProgress=event=>{if(!live()||slot.worker!==candidate)return;slot.stage=event.action==='recognize'?'Recognizing text':event.action==='loadLanguage'?'Loading Arabic and English':event.action==='initialize'?'Preparing recognition':'Loading offline OCR';if(event.action==='recognize')slot.progress=Math.max(slot.progress??0,event.progress);progressChanged()};
  await candidate.ready;if(!live()){candidate.terminate();throw Error('Recognition cancelled.')}return candidate;
 }
 async function recognize(number:number,token:number,slot:OcrSlot,job:number){
  const live=()=>alive(token)&&job===slot.epoch;const page=await pdf.getPage(number);if(!live())return;
  const original=page.getViewport({scale:1,rotation:(page.rotate+viewer.pagesRotation)%360}),scale=ocrRasterScale(original.width,original.height);
  const viewport=page.getViewport({scale,rotation:original.rotation}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
  try{slot.render=page.render({canvas,viewport});await slot.render.promise;if(!live())return;slot.render=undefined;
   slot.stage=slot.worker?'Preparing page image':'Loading offline OCR';progressChanged();const engine=await loadWorker(slot,live);if(!live())return;
   const result=await engine.recognize(canvas);if(!live())return;
   const data:PageText={text:'',boxes:[],ocr:true};
   if(typeof result.data.tsv!=='string')throw Error('Offline recognition returned no word positions.');
   const parsed=ocrWordsFromTsv(result.data.tsv,canvas.width,canvas.height);data.text=parsed.text;if(parsed.limited){limited=textLimited=true;detail='A recognized page exceeds its search text limit; results are partial.'}
   for(const word of parsed.words){const {x0,y0,x1,y1,from,to}=word,points=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]].flatMap(([x,y])=>viewport.convertToPdfPoint(x,y)) as Quad;data.boxes.push({from,to,quad:points,rtl:/\p{Script=Arabic}/u.test(word.text)})}
   if(save(number,merge(cache.get(number),data))){recognized.add(number);failed.delete(number);remember({page:number,text:data.text,boxes:data.boxes,ocr:true})}
  }finally{canvas.width=canvas.height=0;if(job===slot.epoch)slot.render=undefined}
 }
 async function pump(token:number){
  if(running||paused||!alive(token))return;running=true;
  const inFlight=new Map<OcrSlot,Promise<void>>();
  const processPage=async(slot:OcrSlot,number:number)=>{slot.page=number;slot.progress=undefined;slot.stage='Rendering page';ocrBudget++;emit();let timeout:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([recognize(number,token,slot,++slot.epoch),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('OCR page timed out.')),120000)})]);}
   catch{if(alive(token)){slot.epoch++;failed.add(number);detail='Some scanned pages could not be recognized.';slot.worker?.terminate();slot.worker=undefined;slot.render?.cancel();slot.render=undefined}}
   finally{clearTimeout(timeout)}
   if(!alive(token))return;slot.page=0;slot.progress=undefined;update(false,number);await turn();
  };
  try{while(alive(token)){
   // Batches yield to input; they must never leave the remaining document paused.
   if(ocrBudget>=25||performance.now()-batchStarted>90000){ocrBudget=0;batchStarted=performance.now();await turn();if(!alive(token))break}
   await foreground(token);if(!alive(token))break;
   while(needed.size&&inFlight.size<slots.length&&!paused){const slot=slots.find(s=>!inFlight.has(s))!;const number=needed.has(viewer.currentPageNumber)?viewer.currentPageNumber:needed.values().next().value!;needed.delete(number);const saved=stored.get(number);if(saved&&saved.ocr!==false&&save(number,merge(cache.get(number),{text:saved.text,boxes:saved.boxes,ocr:true}))){recognized.add(number);update(false,number);continue}const job=processPage(slot,number).finally(()=>inFlight.delete(slot));inFlight.set(slot,job);if(ocrBudget>=25)break}
   if(!inFlight.size)break;await Promise.race(inFlight.values());
  }}finally{await Promise.allSettled(inFlight.values());if(token===generation){running=false;if(needed.size&&!paused&&!textLimited&&alive(token))void pump(token);emit()}}
 }
 async function foreground(token:number){while(alive(token)&&viewer.getPageView?.(viewer.currentPageNumber-1)?.renderingState===1)await new Promise(resolve=>setTimeout(resolve,16))}
 async function scan(token:number){
  if(indexing||textLimited||attempted.size>=pdf.numPages||!alive(token))return;indexing=true;emit();
  const current=viewer.currentPageNumber,order=[current,...Array.from({length:pdf.numPages},(_,i)=>i+1).filter(n=>n!==current)];let sliceStarted=performance.now();
  await previewReady;if(!alive(token)){if(token===generation)indexing=false;return}loadDisk();await turn();
  try{for(const number of order){if(!alive(token)||paused)break;if(attempted.has(number))continue;
   try{await foreground(token);if(!alive(token))break;const saved=stored.get(number);let data:PageText,native:CachedNativePage;
    if(saved?.native){native=saved.native;data={text:native.text,boxes:native.boxes,ocr:false};if(!save(number,data))break}
    else{const page=await pdf.getPage(number);if(!alive(token))break;data=await extract(page);if(!alive(token))break;
     if(!save(number,data))break;update(false,number);await turn();await foreground(token);if(!alive(token))break;
     const operators=await page.getOperatorList();if(!alive(token))break;const image=pdfImageCoverage(operators.fnArray,operators.argsArray,page.view,OPS);
     native={text:data.text,boxes:data.boxes,scanned:scannedPageCandidate(data.text,image.images,image.coverage)};remember({page:number,text:'',boxes:[],ocr:false,native});
    }
    if(native.scanned&&!diskReady){await cacheGrace;if(!alive(token))break}
    attempted.add(number);if(native.scanned){scanned.add(number);const saved=stored.get(number);if(saved&&saved.ocr!==false&&save(number,merge(data,{text:saved.text,boxes:saved.boxes,ocr:true})))recognized.add(number);else{needed.add(number);void pump(token)}}if(number===current)update();
   }catch{if(alive(token)){attempted.add(number);failed.add(number)}}
   if(performance.now()-sliceStarted>=8){update();await turn();sliceStarted=performance.now()}
  }}finally{if(token===generation){indexing=false;update();if(needed.size&&!paused)void pump(token);emit()}}
 }
 function start(){if(destroyed||closed)return;if(!batchStarted)batchStarted=performance.now();const token=generation;void scan(token);void pump(token)}
 function stop(){generation++;indexing=running=false;for(const slot of slots){if(slot.page&&!recognized.has(slot.page))needed.add(slot.page);slot.epoch++;slot.page=0;slot.progress=undefined;slot.render?.cancel();slot.render=undefined;slot.worker?.terminate();slot.worker=undefined}clearTimeout(progressTimer);progressTimer=undefined;cancelAnimationFrame(paintFrame)}
 function pause(){if(closed)return;for(const slot of slots)if(slot.page)needed.add(slot.page);paused=true;stop();emit()}
 function retryFailures(){for(const page of failed){if(scanned.has(page))needed.add(page);else attempted.delete(page)}failed.clear()}
 function resume(){if(closed)return;paused=false;detail='';ocrBudget=0;batchStarted=performance.now();retryFailures();start()}
 for(const event of ['pagerendered','textlayerrendered'])bus.on(event,paintSoon);
 const reposition=()=>{reveal=true;paintSoon()};bus.on('scalechanging',paintSoon);bus.on('rotationchanging',reposition);
 signal.addEventListener('abort',()=>{destroyed=true;closed=true;stop();cache.clear();needed.clear();matchesByPage.clear();stored.clear();pendingSaves.clear();for(const event of ['pagerendered','textlayerrendered','scalechanging'])bus.off(event,paintSoon);bus.off('rotationchanging',reposition);root.querySelectorAll('.av-pdf-find-layer').forEach(node=>node.remove())},{once:true});
 return {search(value,nextOptions,again,previous,notify){report=notify;query=value;options=nextOptions;const nextKey=JSON.stringify([value,nextOptions]);const reset=nextKey!==key,reopening=closed;key=nextKey;
  if(!value.trim()){closed=true;stop();root.querySelectorAll('.av-pdf-find-layer').forEach(node=>node.remove());notify({current:0,total:0});return}
  void disk?.touch?.().catch(()=>{});
  if(reopening||reset){closed=false;paused=false;ocrBudget=0;batchStarted=performance.now();retryFailures();if(!textLimited)detail=''}update(reset);
  if(again&&!reset&&hits.length){index=(index+(previous?-1:1)+hits.length)%hits.length;go(hits[index]);emit();paintSoon()}start();
 },close(){for(const slot of slots)if(slot.page)needed.add(slot.page);closed=true;stop();root.querySelectorAll('.av-pdf-find-layer').forEach(node=>node.remove())}};
}
