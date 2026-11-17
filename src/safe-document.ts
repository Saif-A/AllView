import DOMPurify from 'dompurify';
export function sanitizeSvg(source:string):string {
  const doc=parseXml(source);if(doc.documentElement.localName!=='svg')throw new Error('This file is not an SVG image.');
  const nodes=Array.from(doc.querySelectorAll('*'));if(nodes.length>50000)throw new Error('This vector image exceeds the 50,000-element preview limit.');
  for(const node of nodes)for(const name of node.getAttributeNames()){
    const value=node.getAttribute(name)??'';
    if(/href$/i.test(name)&&!value.startsWith('#')&&!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(value))node.removeAttribute(name);
    const withoutLocal=value.replace(/url\s*\(\s*(['"]?)#[^)'"\s]+\1\s*\)/gi,'');
    if(/url\s*\(/i.test(withoutLocal))node.removeAttribute(name);
  }
  for(const style of doc.querySelectorAll('style'))style.remove();
  return DOMPurify.sanitize(new XMLSerializer().serializeToString(doc),{USE_PROFILES:{svg:true,svgFilters:true},ADD_TAGS:['use'],FORBID_TAGS:['foreignObject','script','a','animate','set']});
}
export function sanitizeDocument(html:string):string {
  const result=DOMPurify.sanitize(html,{WHOLE_DOCUMENT:false,FORBID_TAGS:['script','iframe','frame','object','embed','form','input','button','textarea','select','base','link','meta'],ADD_TAGS:['style'],FORBID_ATTR:['srcset','action','formaction','autofocus']});
  const document=new DOMParser().parseFromString(result,'text/html');
  for(const node of document.querySelectorAll('[href],[src],[xlink\\:href]')){
    for(const attribute of ['href','src','xlink:href']){
      const value=node.getAttribute(attribute);
      if(value&&!value.startsWith('#')&&!/^data:image\/(png|jpeg|gif|webp|bmp);base64,/i.test(value))node.removeAttribute(attribute);
    }
  }
  for(const node of document.querySelectorAll('a'))node.removeAttribute('href');
  return document.body.innerHTML;
}
export function documentFrame(html:string,title:string):HTMLIFrameElement {
  const frame=document.createElement('iframe');frame.className='document-frame';frame.title=title;
  // Same-origin lets our parent-owned listener preserve app shortcuts. Scripts remain
  // forbidden by both the sandbox (no allow-scripts) and the child CSP.
  frame.setAttribute('sandbox','allow-same-origin');frame.referrerPolicy='no-referrer';
  frame.addEventListener('load',()=>{
    frame.contentDocument?.addEventListener('keydown',event=>{
      const key=event.key.toLowerCase();
      const shortcut=key==='escape'||key==='f11'||key==='f3'||(!event.ctrlKey&&!event.shiftKey&&['arrowleft','arrowright'].includes(key))
        ||(event.ctrlKey&&['f','o','p','+','=','-','0'].includes(key));
      if(!shortcut)return;
      const forwarded=new KeyboardEvent('keydown',{key:event.key,code:event.code,ctrlKey:event.ctrlKey,altKey:event.altKey,shiftKey:event.shiftKey,metaKey:event.metaKey,repeat:event.repeat,bubbles:true,cancelable:true});
      frame.dispatchEvent(forwarded);if(forwarded.defaultPrevented)event.preventDefault();
    });
    frame.contentDocument?.addEventListener('wheel',event=>{if(!event.ctrlKey)return;const forwarded=new WheelEvent('wheel',{ctrlKey:true,deltaY:event.deltaY,deltaMode:event.deltaMode,clientX:event.clientX,clientY:event.clientY,bubbles:true,cancelable:true});frame.dispatchEvent(forwarded);if(forwarded.defaultPrevented)event.preventDefault()},{passive:false});
  });
  const csp="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';";
  frame.srcdoc=`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>::highlight(av-find){background:#ffe36a;color:#171717}::highlight(av-find-active){background:#ffab45;color:#171717}body{margin:24px;background:#fff;color:#1a1a1a;font:16px/1.65 Georgia,serif;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px}pre{white-space:pre-wrap}section.slide{min-height:450px;padding:32px;border:1px solid #ddd;margin:20px auto;max-width:900px}</style></head><body>${sanitizeDocument(html)}</body></html>`;
  return frame;
}
export function parseXml(text:string):XMLDocument {
  if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('XML document declarations/entities are not allowed in previews.');
  const doc=new DOMParser().parseFromString(text,'application/xml');
  if(doc.querySelector('parsererror'))throw new Error('This document contains damaged XML.');
  return doc;
}
