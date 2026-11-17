import {invoke} from '@tauri-apps/api/core';
export interface CachedText {text:string;boxes:{from:number;to:number;quad:[number,number,number,number,number,number,number,number];rtl?:boolean}[]}
export interface CachedNativePage extends CachedText {scanned:boolean}
export interface CachedOcrPage extends CachedText {page:number;native?:CachedNativePage;ocr?:boolean}
export interface PdfOcrCache {load():Promise<CachedOcrPage[]>;save(page:CachedOcrPage):Promise<void>;touch?():Promise<void>}
/** Paths and content identity stay native; a failed/unavailable optional cache is a miss. */
export function nativePdfOcrCache(id:number,signal:AbortSignal,rangedPdf=false):PdfOcrCache{
 return {async load(){if(signal.aborted)return [];try{if(rangedPdf){for(let attempt=0;;attempt++){try{await invoke('prepare_pdf_cache',{id});break}catch(error){if(signal.aborted||attempt>=4||!String(error).includes('busy'))throw error;await new Promise(resolve=>setTimeout(resolve,50))}}}if(signal.aborted)return [];const data=await invoke<ArrayBuffer>('load_pdf_ocr_cache',{id});if(signal.aborted)return [];const pages:unknown=JSON.parse(new TextDecoder().decode(data));return Array.isArray(pages)?pages:[]}catch{return []}},
  async touch(){if(signal.aborted)return;try{await invoke('load_pdf_ocr_cache',{id,touchOnly:true})}catch{/* Cache usage never blocks Find. */}},
  async save(page){if(signal.aborted)return;try{const bytes=new TextEncoder().encode(JSON.stringify(page));if(bytes.length>4*1024*1024)return;await invoke('save_pdf_ocr_page',bytes,{headers:{'x-preview-id':String(id)}})}catch{/* Recognition remains usable if cache storage is unavailable. */}}
 };
}
