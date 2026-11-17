import {parseXml} from './safe-document';
import type {ContentsProvider,ContentsItem} from './document-outline';
/** Prefer the book's EPUB navigation/NCX; otherwise retain real rendered headings. */
export function bookContents(metadata:{path:string;xml:string;kind:'nav'|'ncx'}|undefined,chapters:string[],fallback:ContentsProvider,root:()=>HTMLElement|ShadowRoot|undefined,signal:AbortSignal,notify:(message:string)=>void):ContentsProvider{
 return async()=>{
  const headings=await fallback();if(signal.aborted||!metadata)return headings;
  try{
   if(metadata.xml.length>4*1024*1024)throw Error('The embedded contents exceeds the 4 MiB preview limit.');
   const document=parseXml(metadata.xml);const result:ContentsItem[]=[];
   const add=(title:string,href:string,level:number)=>{
    if(result.length>=2000)return;let chapter=-1,anchor='';
    try{if(href.length>4096)throw Error();const at=href.indexOf('#'),file=decodeURIComponent(at<0?href:href.slice(0,at));anchor=decodeURIComponent(at<0?'':href.slice(at+1));if(/^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(file))throw Error();const parts=metadata.path.split('/').slice(0,-1);for(const part of file.split('/')){if(part==='..'){if(!parts.length)throw Error();parts.pop()}else if(part&&part!=='.')parts.push(part)}chapter=chapters.indexOf(file?parts.join('/'):metadata.path)}catch{}
    const index=chapter,id=`book-${result.length}`;result.push({id,title:title.replace(/\s+/g,' ').trim().slice(0,512)||'Untitled section',level:Math.min(20,level),disabled:index<0,go(){if(signal.aborted)return;const section=root()?.querySelector<HTMLElement>(`[data-av-chapter="${index}"]`);const target=anchor?section?.querySelector<HTMLElement>('#'+CSS.escape(anchor)):section;if(!target)throw Error('This book destination is unavailable in the preview.');target.scrollIntoView({block:'start'})}});
   };
   if(metadata.kind==='nav'){
    const navigation=Array.from(document.getElementsByTagNameNS('*','nav'));const toc=navigation.find(node=>(node.getAttributeNS('http://www.idpf.org/2007/ops','type')??node.getAttribute('epub:type')??'').split(/\s+/).includes('toc'))??navigation[0];
    if(toc)for(const link of Array.from(toc.getElementsByTagNameNS('*','a')).slice(0,2000)){let level=0;for(let parent=link.parentElement;parent&&parent!==toc;parent=parent.parentElement)if(parent.localName==='li')level++;add(link.textContent??'',link.getAttribute('href')??'',Math.max(1,level))}
   }else{
    const points=Array.from(document.getElementsByTagNameNS('*','navPoint')).slice(0,2000);for(const point of points){let level=1;for(let parent=point.parentElement;parent;parent=parent.parentElement)if(parent.localName==='navPoint')level++;const children=Array.from(point.children);add(children.find(node=>node.localName==='navLabel')?.textContent??'',children.find(node=>node.localName==='content')?.getAttribute('src')??'',level)}
   }
   return result.length?result:headings;
  }catch(error){notify(`Embedded contents could not be read; showing document headings. ${String(error)}`);return headings}
 };
}
