import {DOMParser} from '@xmldom/xmldom';
import {CONTENTS_LIMIT,headingText,type HeadingLocation} from './document-outline.ts';
/** Bounded semantic headings; this module runs only in the existing package worker. */
export function wordHeadings(entries:Record<string,Uint8Array>):HeadingLocation[]{
 const read=(name:string)=>{const bytes=entries[name];if(!bytes)return null;const text=new TextDecoder().decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Document type/entity declarations are disabled.');return new DOMParser({onError:level=>{if(level==='fatalError')throw Error('Invalid document outline XML.')}}).parseFromString(text,'application/xml')};
 const document=read('word/document.xml')??read('content.xml');if(!document)return [];
 const all=(node:import('@xmldom/xmldom').Element,name:string)=>Array.from(node.getElementsByTagNameNS('*',name));
 const value=(node:import('@xmldom/xmldom').Element|null|undefined,name:string)=>node?.getAttributeNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main',name)??node?.getAttribute(`w:${name}`)??'';
 const styles=new Map<string,{level:number|null;base:string}>(),styleDoc=read('word/styles.xml');
 for(const node of Array.from(styleDoc?.getElementsByTagNameNS('*','style')??[]).slice(0,10000)){const id=value(node,'styleId'),outline=all(node,'outlineLvl')[0],label=value(all(node,'name')[0],'val');styles.set(id,{level:outline?Number(value(outline,'val')):null,base:value(all(node,'basedOn')[0],'val')});if(!outline&&/^heading\s*[1-9]$/i.test(label))styles.get(id)!.level=Number(label.match(/[1-9]/)![0])-1}
 const styleLevel=(id:string)=>{const seen=new Set<string>();for(let depth=0;id&&depth<32&&!seen.has(id);depth++){seen.add(id);const style=styles.get(id);if(!style)return /^heading[1-9]$/i.test(id)?Number(id.at(-1))-1:null;if(style.level!==null)return style.level;id=style.base}return null};
 const headings:HeadingLocation[]=[],occurrences=new Map<string,number>();
 for(const node of Array.from(document.getElementsByTagNameNS('*','p')).slice(0,20000)){
  const title=headingText(all(node,'t').map(text=>text.textContent??'').join('')).slice(0,512);if(!title)continue;const occurrence=occurrences.get(title)??0;occurrences.set(title,occurrence+1);
  const properties=Array.from(node.childNodes).find(child=>child.nodeType===1&&(child as import('@xmldom/xmldom').Element).localName==='pPr') as import('@xmldom/xmldom').Element|undefined;
  const outline=properties&&all(properties,'outlineLvl')[0],level=outline?Number(value(outline,'val')):properties?styleLevel(value(all(properties,'pStyle')[0],'val')):null;
  if(level!==null&&Number.isInteger(level)&&level>=0&&level<=8){headings.push({title,level:level+1,occurrence});if(headings.length===CONTENTS_LIMIT)break}
 }
 if(!entries['word/document.xml']){const seen=new Map<string,number>();for(const node of Array.from(document.getElementsByTagName('*')).slice(0,20000)){if(!['h','p'].includes(node.localName??''))continue;const title=headingText(node.textContent??'').slice(0,512),occurrence=seen.get(title)??0;seen.set(title,occurrence+1);if(node.localName==='h'&&title){headings.push({title,level:Math.max(1,Math.min(20,Number(node.getAttributeNS('urn:oasis:names:tc:opendocument:xmlns:text:1.0','outline-level'))||1)),occurrence});if(headings.length===CONTENTS_LIMIT)break}}}
 return headings.slice(0,CONTENTS_LIMIT);
}
