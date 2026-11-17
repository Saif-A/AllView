import type {Page} from 'tesseract.js';
import {grayscalePgm} from './ocr-indexing';
/** Pinned Tesseract.js 7 browser-worker protocol. Own the Worker before asynchronous startup
 * so missing models, load failures, timeout and cancellation can always terminate it. */
export class OfflineOcrWorker {
 readonly ready:Promise<void>;
 private readonly worker:Worker;
 private job=0;
 private stopped=false;
 onProgress?:((event:{action:string;progress:number})=>void);
 private pending:{id:string;action:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
 constructor(base:string){
  this.worker=new Worker(base+'worker.min.js');
  this.worker.onmessage=event=>{const {jobId,status,data}=event.data??{};if(!this.pending||jobId!==this.pending.id)return;if(status==='progress'){if(typeof data?.progress==='number'&&Number.isFinite(data.progress))this.onProgress?.({action:this.pending.action,progress:Math.max(0,Math.min(1,data.progress))});return}const pending=this.pending;this.pending=undefined;clearTimeout(pending.timer);if(status==='resolve')pending.resolve(data);else pending.reject(Error(typeof data==='string'?data:'Offline recognition failed.'))};
  this.worker.onerror=event=>{event.preventDefault();this.terminate(Error(event.message||'Offline recognition worker failed.'))};
  this.worker.onmessageerror=()=>this.terminate(Error('Offline recognition returned invalid data.'));
  this.ready=this.initialize(base);
 }
 private call(action:string,payload:unknown,transfer:Transferable[]=[]):Promise<unknown>{
  if(this.stopped)return Promise.reject(Error('Recognition cancelled.'));
  if(this.pending)return Promise.reject(Error('Recognition is already busy.'));
  return new Promise((resolve,reject)=>{const id=String(++this.job),timer=setTimeout(()=>this.terminate(Error('Offline recognition timed out.')),120000);this.pending={id,action,resolve,reject,timer};try{this.worker.postMessage({workerId:'allview-ocr',jobId:id,action,payload},transfer)}catch(error){this.terminate(error instanceof Error?error:Error(String(error)))}});
 }
 private async initialize(base:string){
  try{await this.call('load',{options:{lstmOnly:true,corePath:base,logging:false}});
   await this.call('loadLanguage',{langs:['ara','eng'],options:{langPath:base.replace(/\/$/,''),cacheMethod:'none',gzip:true,lstmOnly:true}});
   await this.call('initialize',{langs:['ara','eng'],oem:1,config:{}});
   // Tesseract.js defaults to a single text block. Scanned documents contain
   // tables/columns/headers: detect their layout instead of joining whole rows.
   await this.call('setParameters',{params:{tessedit_pageseg_mode:'3'}});
  }catch(error){this.terminate();throw error}
 }
 async recognize(canvas:HTMLCanvasElement):Promise<{data:Page}>{
  await this.ready;if(this.stopped)throw Error('Recognition cancelled.');
  const context=canvas.getContext('2d');if(!context)throw Error('Could not prepare recognition image.');
  const bytes=grayscalePgm(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);if(this.stopped)throw Error('Recognition cancelled.');
  const data=await this.call('recognize',{image:bytes,options:{},output:{text:false,blocks:false,tsv:true}},[bytes.buffer]);return {data:data as Page};
 }
 terminate(error=Error('Recognition cancelled.')){
  if(this.stopped)return;this.stopped=true;this.worker.terminate();const pending=this.pending;this.pending=undefined;if(pending){clearTimeout(pending.timer);pending.reject(error)}
 }
}
