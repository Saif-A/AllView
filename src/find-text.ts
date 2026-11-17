/** Literal, Unicode-index-preserving search with bounded results. */
import type {IndexingProgress} from './ocr-indexing';
export interface FindOptions {caseSensitive:boolean;wholeWord:boolean}
export interface FindSnippet {before:string;match:string;after:string}
export interface FindItem {label:string;detail?:string;snippet?:FindSnippet;go:()=>void}
export interface FindResult {current:number;total:number;limited?:boolean;pending?:boolean;items?:FindItem[];itemsLabel?:string;message?:string;snippet?:FindSnippet;cancel?:()=>void;resume?:()=>void;indexing?:IndexingProgress}
export interface FindTarget {search(query:string,options:FindOptions,again:boolean,previous:boolean,report:(result:FindResult)=>void):void;close?():void}
/** Bounded literal context from original UTF-16 match offsets, including normalized Arabic hits. */
export function findSnippet(text:string,from:number,to:number):FindSnippet|undefined {
 if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<=from||to>text.length)return;
 const low=(i:number)=>i>0&&i<text.length&&/[\uDC00-\uDFFF]/.test(text[i])?i-1:i;
 const high=(i:number)=>i>0&&i<text.length&&/[\uD800-\uDBFF]/.test(text[i-1])?i+1:i;
 const start=low(Math.max(0,from-45)),end=high(Math.min(text.length,to+45)),cut=low(Math.min(to,from+512));
 const clean=(value:string)=>value.replace(/\s+/gu,' ');
 return {before:(start?'…':'')+clean(text.slice(start,from)),match:clean(text.slice(from,cut))+(cut<to?'…':''),after:clean(text.slice(to,end))+(end<text.length?'…':'')};
}
export function textMatches(text:string,query:string,options:FindOptions,limit=10000){
 const matches:{from:number;to:number}[]=[];if(!query)return {matches,limited:false};
 const pattern=new RegExp(query.slice(0,256).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),options.caseSensitive?'gu':'giu');
 const word=(value:string)=>/[\p{L}\p{N}_]/u.test(value);let match:RegExpExecArray|null;
 while((match=pattern.exec(text))){const from=match.index,to=from+match[0].length;
  if(options.wholeWord&&(word(Array.from(text.slice(Math.max(0,from-2),from)).at(-1)??'')||word(Array.from(text.slice(to,to+2))[0]??'')))continue;
  if(matches.length===limit)return {matches,limited:true};matches.push({from,to});
 }return {matches,limited:false};
}
