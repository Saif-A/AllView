import {parseXml} from './safe-document';
// The DWF/XPS engine treats absolute OPC resource URIs as relative paths. Normalize
// references in memory so valid absolute and relative packages share one decoder.
export function normalizeXpsResources(entries:Record<string,Uint8Array>):Record<string,string>{
  const changes:Record<string,string>={};let references=0;
  for(const [name,bytes] of Object.entries(entries)){
    if(!/\.(fdseq|fdoc|fpage|dict)$/i.test(name))continue;
    const doc=parseXml(new TextDecoder().decode(bytes));let changed=false;
    for(const node of Array.from(doc.getElementsByTagName('*'))){
      for(const attr of ['Source','FontUri','ImageSource','ColorContext']){
        const value=node.getAttribute(attr);if(!value)continue;
        if(++references>50000)throw new Error('This XPS exceeds the 50,000-resource-reference preview limit.');
        if(/^[a-z][a-z0-9+.-]*:|^\/\/|\\/i.test(value))throw new Error('External XPS resources are disabled.');
        if(!value.startsWith('/'))continue;
        const base=name.split('/').slice(0,-1),target=value.slice(1).split('/');
        if(target.some(part=>part==='.'||part==='..'))throw new Error('This XPS contains an invalid absolute resource path.');
        while(base.length&&target.length&&base[0]===target[0]){base.shift();target.shift();}
        node.setAttribute(attr,[...base.map(()=>'..'),...target].join('/'));changed=true;
      }
    }
    if(changed)changes[name]=new XMLSerializer().serializeToString(doc);
  }
  return changes;
}
