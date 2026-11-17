import {textMatches,type FindOptions} from './find-text.ts';
/** Normalize Arabic presentation forms/marks without losing source offsets for highlights. */
export function normalizedPdfText(text:string){
 let value='',offset=0,lastSpace=false;const starts:number[]=[],ends:number[]=[];
 for(const point of text){const from=offset;offset+=point.length;
  for(const char of point.normalize('NFKC')){
   if(/[\p{M}\u0640\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(char))continue;
   const next=/\s/u.test(char)?' ':char;
   if(next===' '&&lastSpace){ends[ends.length-1]=offset;continue}
   lastSpace=next===' ';value+=next;for(let i=0;i<next.length;i++){starts.push(from);ends.push(offset)}
  }
 }
 return {value,starts,ends};
}
export function pdfTextMatches(text:string,query:string,options:FindOptions,limit=10000){
 return preparedPdfMatches(preparePdfText(text),query,options,limit);
}
export interface PreparedPdfText {value:string;starts?:Uint32Array;ends?:Uint32Array;limited?:boolean}
/** Cache normalization once per indexed page; ordinary text needs no offset arrays. */
export function preparePdfText(text:string,limit=1024*1024):PreparedPdfText{
 const normalized=text.normalize('NFKC');
 if(normalized===text&&!/[\p{M}\u0640\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|\s{2}/u.test(text))return {value:text.slice(0,limit).replace(/\s/gu,' '),limited:text.length>limit};
 let value='',offset=0,lastSpace=false;const starts=new Uint32Array(Math.min(limit,normalized.length)),ends=new Uint32Array(starts.length);let limited=false;
 outer:for(const point of text){const from=offset;offset+=point.length;for(const char of point.normalize('NFKC')){
  if(/[\p{M}\u0640\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(char))continue;
  const next=/\s/u.test(char)?' ':char;if(next===' '&&lastSpace){ends[value.length-1]=offset;continue}
  if(value.length+next.length>limit){limited=true;break outer}lastSpace=next===' ';const start=value.length;value+=next;for(let n=start;n<value.length;n++){starts[n]=from;ends[n]=offset}
 }}return {value,starts:starts.subarray(0,value.length),ends:ends.subarray(0,value.length),limited};
}
export function preparedPdfMatches(source:PreparedPdfText,query:string,options:FindOptions,limit=10000){
 const needle=normalizedPdfText(query.slice(0,256)).value;
 if(!needle.trim())return {matches:[],limited:false};
 const found=textMatches(source.value,needle,options,limit);
 return {limited:found.limited,matches:source.starts&&source.ends?found.matches.map(hit=>({from:source.starts![hit.from],to:source.ends![hit.to-1]})):found.matches};
}
export function scannedPageCandidate(text:string,hasImages:boolean,imageCoverage=0){
 const letters=(text.match(/[\p{L}\p{N}]/gu)??[]).length;
 return !letters||hasImages&&(imageCoverage>=.6||letters<40||(text.match(/\ufffd/g)?.length??0)>letters/10);
}
