/** Lazy JSON/XML tree: bounded parsing and at most 200 children mounted per expansion. */
import {button} from './ux';
export function structuredView(parent:HTMLElement,text:string,xml=false) {
  if(text.length>2*1024*1024)throw new Error('Tree view is limited to 2 MiB. Source view is available.');
  let value:unknown;
  if(xml){if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('XML declarations with entities cannot be expanded.');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw new Error('This XML is not well formed.');
    let count=0;const convert=(node:Element,depth=0):unknown=>{if(++count>20_000||depth>80)throw new Error('This XML tree exceeds the node/depth limit.');const result:Record<string,unknown>=Object.create(null);for(const a of node.attributes)result[`@${a.name}`]=a.value;for(const child of node.children){const next=convert(child,depth+1);if(child.tagName in result){const prior=result[child.tagName];if(Array.isArray(prior))prior.push(next);else result[child.tagName]=[prior,next]}else result[child.tagName]=next;}if(!node.children.length)return Object.keys(result).length?{...result,'#text':node.textContent??''}:node.textContent??'';return result};value={[doc.documentElement.tagName]:convert(doc.documentElement)};
  }else value=JSON.parse(text);
  parent.replaceChildren();parent.className='structured-stage';let mounted=0;
  const render=(key:string,item:unknown,depth:number):HTMLElement=>{
    if(++mounted>20_000){const row=document.createElement('p');row.textContent='Tree display limit reached; use Source for the full file.';return row;}
    if(item!==null&&typeof item==='object'){
      const details=document.createElement('details');const summary=document.createElement('summary');const keys=Object.keys(item);summary.textContent=`${key} ${Array.isArray(item)?`[${keys.length}]`:`{${keys.length}}`}`;details.append(summary);
      let shown=0;const children=document.createElement('div');children.className='tree-children';details.append(children);
      const more=button('Show more',()=>{more.remove();append()});
      const append=()=>{const end=Math.min(keys.length,shown+200);for(;shown<end;shown++){const k=keys[shown];children.append(render(k,(item as Record<string,unknown>)[k],depth+1));}if(shown<keys.length&&mounted<20_000)children.append(more)};
      details.addEventListener('toggle',()=>{if(details.open&&!shown&&depth<100)append()});if(depth===0){details.open=true;append()}return details;
    }
    const row=document.createElement('div');row.className='tree-value';const name=document.createElement('span');name.textContent=`${key}: `;const content=document.createElement('span');content.className=`value-${typeof item}`;const display=typeof item==='string'?JSON.stringify(item):String(item);content.textContent=display.slice(0,4096)+(display.length>4096?'…':'');row.append(name,content);return row;
  };
  parent.append(render('$',value,0));return {zoom:(value:number)=>{parent.style.fontSize=`${14*value}px`}};
}
