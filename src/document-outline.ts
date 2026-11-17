/** Local destinations only: providers keep renderer/request authority, never filesystem paths. */
export interface ContentsItem {id:string;title:string;level:number;go:()=>void|Promise<void>;disabled?:boolean}
export type ContentsProvider=()=>ContentsItem[]|Promise<ContentsItem[]>;
export interface HeadingLocation {title:string;level:number;occurrence:number}
export const CONTENTS_LIMIT=2000;
export const headingText=(value:string)=>value.replace(/\s+/gu,' ').trim();
/** Resolve destinations again on each activation: Office pagination can replace its DOM. */
export function locatedContents(root:HTMLElement|ShadowRoot,headings:HeadingLocation[]):ContentsItem[]{
 return headings.slice(0,CONTENTS_LIMIT).map((heading,i)=>({id:`heading-${i}`,title:heading.title,level:heading.level,go(){
  const candidates=root.querySelectorAll<HTMLElement>('p,h1,h2,h3,h4,h5,h6,[role=heading]');let occurrence=0;
  for(let n=0;n<Math.min(candidates.length,20000);n++){const node=candidates[n];if(headingText(node.textContent??'').slice(0,512)===heading.title&&occurrence++===heading.occurrence){node.scrollIntoView({block:'start'});return}}
  throw Error('This heading is not available in the rendered pages.');
 }}));
}
export function domContents(root:HTMLElement|ShadowRoot):ContentsItem[]{
 const headings=root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[role=heading]');const result:ContentsItem[]=[];
 for(let i=0;i<Math.min(headings.length,CONTENTS_LIMIT);i++){const node=headings[i];if(node.closest('button,nav,.preview-toolbar,.pdf-toolbar'))continue;const title=headingText(node.textContent??'').slice(0,512);if(!title)continue;result.push({id:`heading-${i}`,title,level:Math.max(1,Math.min(20,Number(node.getAttribute('aria-level')??node.tagName.slice(1))||1)),go:()=>{node.scrollIntoView({block:'start'})}})}return result;
}
