import {OfflineOcrWorker} from './offline-ocr-worker';
import {ocrRasterScale,ocrWordsFromTsv} from './ocr-indexing';
import {preparePdfText,preparedPdfMatches,type PreparedPdfText} from './pdf-search-text';
import {findSnippet,type FindTarget,type FindOptions,type FindResult,type FindItem} from './find-text';
import type {PdfOcrCache,CachedOcrPage} from './pdf-ocr-cache';
import './image-search.css';

/** One decoded image, one cancellable local worker. Boxes use unrotated unit coordinates. */
export function imageSearch(image:HTMLImageElement,signal:AbortSignal,disk?:PdfOcrCache):FindTarget{
 const layer=document.createElement('div');layer.className='image-find-layer';layer.setAttribute('aria-hidden','true');image.parentElement!.append(layer);
 let data:CachedOcrPage|undefined,prepared:PreparedPdfText|undefined,worker:OfflineOcrWorker|undefined;
 let epoch=0,closed=true,running=false,paused=false,failed=false,limited=false,textLimited=false,progress=0;
 let query='',key='',options:FindOptions={caseSensitive:false,wholeWord:false},hits:{from:number;to:number}[]=[],index=-1,items:FindItem[]=[];
 let report:((result:FindResult)=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined,lastProgress=0;
 const live=(token:number)=>!signal.aborted&&!closed&&token===epoch;
 const layout=()=>{layer.style.width=image.style.width;layer.style.height=image.style.height;layer.style.transform=image.style.transform};
 const observer=new MutationObserver(layout);observer.observe(image,{attributes:true,attributeFilter:['style']});layout();
 function paint(reveal=false){
  layer.replaceChildren();if(closed||!data)return;const active=hits[index];let cursor=0,marks=0;
  for(const box of data.boxes){while(cursor<hits.length&&hits[cursor].to<=box.from)cursor++;
   for(let n=cursor;n<hits.length&&hits[n].from<box.to;n++){const hit=hits[n];if(marks++>=2000&&hit!==active)continue;
    const length=box.to-box.from;let start=Math.max(0,hit.from-box.from)/length,end=Math.min(length,hit.to-box.from)/length;if(box.rtl)[start,end]=[1-end,1-start];
    const [x0,y0,x1,,,y1]=box.quad,mark=document.createElement('span');mark.className='image-find-match'+(hit===active?' active':'');
    mark.style.left=`${(x0+(x1-x0)*start)*100}%`;mark.style.top=`${y0*100}%`;mark.style.width=`${(x1-x0)*(end-start)*100}%`;mark.style.height=`${(y1-y0)*100}%`;layer.append(mark);
   }
  }
  if(reveal)layer.querySelector('.active')?.scrollIntoView({block:'center',inline:'nearest'});
 }
 function emit(){if(closed||signal.aborted||!report)return;const ready=!!data,hit=hits[index];
  report({current:index+1,total:hits.length,pending:running,limited,items,itemsLabel:'Matches (up to 200)',snippet:hit&&data?findSnippet(data.text,hit.from,hit.to):undefined,
   message:failed?'This image could not be recognized. Resume to retry.':limited?'Image search limit reached; results are partial.':undefined,
   indexing:{completed:ready?1:0,total:1,value:ready?1:Math.min(.999,progress),checked:1,scanned:1,recognized:ready?1:0,failed:failed?1:0,state:running?'working':paused?'paused':failed||limited?'partial':'ready',stage:running?'Recognizing image text':'',active:running?1:0},
   cancel:running?pause:undefined,resume:paused||failed?resume:undefined});
 }
 function update(){
  const result=prepared?preparedPdfMatches(prepared,query,options,10000):{matches:[],limited:false};hits=result.matches;limited=!!prepared?.limited||result.limited||textLimited;index=hits.length?0:-1;
  const resultKey=key;items=hits.slice(0,200).map((hit,i)=>({label:`Match ${i+1}`,detail:'OCR',snippet:findSnippet(data!.text,hit.from,hit.to),go(){if(closed||key!==resultKey)return;index=i;paint(true);emit()}}));paint();emit();
 }
 function stop(){epoch++;running=false;worker?.terminate();worker=undefined;clearTimeout(timer);timer=undefined}
 function pause(){paused=true;stop();emit()}
 function resume(){if(closed||signal.aborted)return;paused=false;failed=false;void start()}
 function progressChanged(){if(timer)return;timer=setTimeout(()=>{timer=undefined;lastProgress=performance.now();emit()},Math.max(0,100-(performance.now()-lastProgress)))}
 async function start(){
  if(running||data||paused||closed||signal.aborted)return;const token=++epoch;running=true;failed=false;progress=0;emit();let canvas:HTMLCanvasElement|undefined;
  try{
   const saved=(await disk?.load().catch(()=>[])??[]).find(page=>page.page===1&&typeof page.text==='string'&&page.text.length<=1024*1024&&Array.isArray(page.boxes)&&page.boxes.length<=20000&&page.boxes.every(box=>Number.isInteger(box.from)&&Number.isInteger(box.to)&&box.from>=0&&box.to>box.from&&box.to<=page.text.length&&box.quad.length===8&&box.quad.every(n=>Number.isFinite(n)&&n>=0&&n<=1)));
   if(!live(token))return;
   if(saved){data=saved;prepared=preparePdfText(data.text);return}
   const width=image.naturalWidth,height=image.naturalHeight,scale=Math.min(1,ocrRasterScale(width,height));
   canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(width*scale));canvas.height=Math.max(1,Math.floor(height*scale));
   const context=canvas.getContext('2d');if(!context)throw Error('Recognition canvas unavailable.');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
   const engine=worker=new OfflineOcrWorker(new URL(`${import.meta.env.BASE_URL}ocr/`,document.baseURI).href);
   engine.onProgress=event=>{if(live(token)&&event.action==='recognize'){progress=Math.max(progress,event.progress);progressChanged()}};
   const result=await engine.recognize(canvas);if(!live(token))return;
   const parsed=ocrWordsFromTsv(result.data.tsv!,canvas.width,canvas.height);textLimited=parsed.limited;
   const x=(value:number)=>Math.min(1,value/canvas!.width),y=(value:number)=>Math.min(1,value/canvas!.height);
   data={page:1,text:parsed.text,boxes:parsed.words.map(word=>({from:word.from,to:word.to,rtl:/\p{Script=Arabic}/u.test(word.text),quad:[x(word.x0),y(word.y0),x(word.x1),y(word.y0),x(word.x1),y(word.y1),x(word.x0),y(word.y1)]}))};
   prepared=preparePdfText(data.text);if(!textLimited)void disk?.save(data).catch(()=>{});
  }catch{if(live(token))failed=true}
  finally{if(canvas)canvas.width=canvas.height=0;if(live(token)){worker?.terminate();worker=undefined;running=false;clearTimeout(timer);timer=undefined;update()}}
 }
 signal.addEventListener('abort',()=>{closed=true;stop();observer.disconnect();layer.remove();data=prepared=undefined;hits=[];items=[]},{once:true});
 return {search(value,nextOptions,again,previous,notify){if(signal.aborted)return;report=notify;
  if(!value.trim()){closed=true;stop();layer.replaceChildren();notify({current:0,total:0});return}
  const nextKey=JSON.stringify([value,nextOptions]),reset=nextKey!==key||closed;query=value;options=nextOptions;key=nextKey;closed=false;
  if(reset){paused=false;failed=false;update()}else if(again&&hits.length){index=(index+(previous?-1:1)+hits.length)%hits.length;paint(true);emit()}else emit();
  void disk?.touch?.().catch(()=>{});if(!failed)void start();
 },close(){closed=true;stop();layer.replaceChildren()}};
}
