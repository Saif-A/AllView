import type {PDFDataRangeTransport} from 'pdfjs-dist';

export const PDF_PREFETCH_LIMIT=128*1024*1024;
const CHUNK=256*1024,MAX_RANGE=64*1024*1024;
type Read=(begin:number,end:number)=>Promise<ArrayBuffer|Uint8Array<ArrayBuffer>|number[]>;
/** Native reads stay bounded; queued visible-page requests precede background bytes. */
export function pdfRange(Transport:typeof PDFDataRangeTransport,length:number,read:Read,signal:AbortSignal,onError:(error:unknown)=>void){
 if(!Number.isSafeInteger(length)||length<5||length>2*1024**3)throw Error('PDFs must be nonempty and at most 2 GiB.');
 const small=length<PDF_PREFETCH_LIMIT,transport=new Transport(length,new Uint8Array(0),!small);
 const queue:{begin:number;end:number}[]=[];
 let stopped=false,running=false,painted=false,position=0,finished=false;
 const stats={requestedBytes:0,firstPaintBytes:0,prefetchStarted:false,prefetchComplete:false};
 const live=()=>!stopped&&!signal.aborted;
 const abort=()=>{stopped=true;queue.length=0};transport.abort=abort;signal.addEventListener('abort',abort,{once:true});
 async function bytes(begin:number,end:number){const value=await read(begin,end);if(!live())throw Error('Preview cancelled.');const result=value instanceof Uint8Array?value:new Uint8Array(value);if(result.byteLength!==end-begin)throw Error('The PDF range response is incomplete.');stats.requestedBytes+=result.byteLength;return result}
 async function pump(){
  if(running||!live())return;running=true;
  try{while(live()){
   const request=queue.shift();
   if(request){const data=new Uint8Array(request.end-request.begin);for(let offset=request.begin;offset<request.end;offset+=CHUNK){const part=await bytes(offset,Math.min(request.end,offset+CHUNK));data.set(part,offset-request.begin)}if(live())transport.onDataRange(request.begin,data);}
   else if(painted&&small&&!finished){stats.prefetchStarted=true;const data=await bytes(position,Math.min(length,position+CHUNK));position+=data.length;transport.onDataProgressiveRead(data);if(position===length){finished=true;stats.prefetchComplete=true;transport.onDataProgressiveDone();performance.mark('av-pdf-prefetch-complete')}}
   else break;
   // Let input, new range requests and canvas painting run between chunks.
   await new Promise<void>(resolve=>setTimeout(resolve,0));
  }}catch(error){if(live()){abort();onError(error)}}finally{running=false}
 }
 transport.requestDataRange=(begin,end)=>{if(!live())return;if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin||end>length||end-begin>MAX_RANGE||queue.length>=64){abort();onError(Error('This PDF requires an excessive data range.'));return}queue.push({begin,end});void pump()};
 return {transport,stats,afterFirstPaint(){if(!live()||painted)return;painted=true;stats.firstPaintBytes=stats.requestedBytes;performance.mark('av-pdf-first-paint');void pump()}};
}
