import { runFormatWorker } from './worker-client';
import { ENTRY_LIMIT } from './archive';
import { documentFrame, parseXml, sanitizeSvg } from './safe-document';
import type {ZoomAnchor} from './viewer-interaction';
import {domContents,type ContentsProvider} from './document-outline';

export interface ExtendedInfo {name:string;kind:string;mime:string;bytes:number}
export interface PreviewContext {stage:HTMLElement;signal:AbortSignal;toolbar?:HTMLElement;icon?:(name:string)=>string;mediaUrl?:string;notify:(text:string)=>void;zoomChanged?:(value:number)=>void;fitContent?:(width:number,height:number,extraHeight?:number)=>Promise<void>}
export interface PreviewControls {zoom?:(value:number,anchor?:ZoomAnchor)=>void;anchor?:(x:number,y:number)=>ZoomAnchor;cancelPan?:()=>void;rotate?:(degrees:number)=>void;fit?:(expand?:boolean)=>number;initialZoom?:number;findRoot?:HTMLElement|ShadowRoot;contents?:ContentsProvider}
const decoder=new TextDecoder();
const escape=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
const extension=(name:string)=>name.toLowerCase().split('.').pop()??'';
function ready(ctx:PreviewContext){if(ctx.signal.aborted)throw new DOMException('Preview cancelled','AbortError');}
function mount(ctx:PreviewContext,node:Node,className='extended-stage') {ready(ctx);ctx.stage.className=className;ctx.stage.replaceChildren(node);}
function release(ctx:PreviewContext,fn:()=>void){if(ctx.signal.aborted)fn();else ctx.signal.addEventListener('abort',fn,{once:true});}
function blob(ctx:PreviewContext,bytes:Uint8Array,mime:string){const url=URL.createObjectURL(new Blob([bytes.slice().buffer],{type:mime}));release(ctx,()=>URL.revokeObjectURL(url));return url;}
function frame(ctx:PreviewContext,html:string,title:string){const node=documentFrame(html,title),loaded=new Promise<void>(resolve=>{node.addEventListener('load',()=>resolve(),{once:true});ctx.signal.addEventListener('abort',()=>resolve(),{once:true})});mount(ctx,node,'frame-stage');return {get findRoot(){return node.contentDocument?.body},contents:async()=>{await loaded;return ctx.signal.aborted||!node.contentDocument?.body?[]:domContents(node.contentDocument.body)},zoom:(value:number)=>{node.style.zoom=String(value);node.style.height=`${100/value}%`;node.style.width=`${100/value}%`;}};}
function toolbar(ctx:PreviewContext,parent:HTMLElement,label:string,items:string[],choose:(name:string)=>void){
  const bar=document.createElement('div');bar.className=ctx.toolbar?'format-tools toolbar-group':'preview-toolbar';bar.setAttribute('role','group');bar.setAttribute('aria-label',label);const name=document.createElement('label');name.className='format-label';name.textContent=label;
  const select=document.createElement('select');select.setAttribute('aria-label',label);
  for(const value of items){const option=document.createElement('option');option.value=value;option.textContent=value;select.append(option);}
  select.onchange=()=>choose(select.value);bar.append(name,select);(ctx.toolbar??parent).append(bar);return select;
}
function table(columns:string[],rows:string[][]):HTMLTableElement {
  const result=document.createElement('table');result.className='data-table';
  const head=result.createTHead().insertRow();for(const name of columns){const cell=document.createElement('th');cell.textContent=name;head.append(cell);}
  const body=result.createTBody();for(const values of rows){const row=body.insertRow();for(const value of values){const cell=row.insertCell();cell.textContent=value;}}
  return result;
}
function cellName(column:number):string{let result='';for(let value=column+1;value>0;value=Math.floor((value-1)/26))result=String.fromCharCode(65+(value-1)%26)+result;return result;}
function inlineData(bytes:Uint8Array,name:string):string {
  const ext=extension(name);const mime:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp'};
  if(!mime[ext]||bytes.length>ENTRY_LIMIT)return '';
  let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
  return `data:${mime[ext]};base64,${btoa(binary)}`;
}
function memberPath(base:string,target:string):string {
  if(/^[a-z]+:|^[\\/]/i.test(target))return '';
  const parts=base.split('/').slice(0,-1);for(const part of target.split('/')){if(part==='..'){if(!parts.length)return '';parts.pop();}else if(part!=='.'&&part)parts.push(part);}
  return parts.join('/');
}
function localImages(html:string,base:string,entries:Record<string,Uint8Array>):string {
  const doc=new DOMParser().parseFromString(html,'text/html');
  for(const image of doc.querySelectorAll('img')){const target=memberPath(base,image.getAttribute('src')??'');const data=entries[target];if(data)image.src=inlineData(data,target);else image.removeAttribute('src');}
  return doc.body.innerHTML;
}
async function showPackage(info:ExtendedInfo,bytes:Uint8Array,ctx:PreviewContext):Promise<PreviewControls>{
  const ext=extension(info.name);
  if(['fb2','fodt','fodp','fodg','abw','awt','enex'].includes(ext)){
    const doc=parseXml(decoder.decode(bytes));const html=Array.from(doc.getElementsByTagName('*')).filter(node=>['p','h','title','subtitle','table'].includes(node.localName)).slice(0,20000).map(node=>`<p>${escape(node.textContent??'')}</p>`).join('');
    return frame(ctx,html,info.name);
  }
  const entries=await runFormatWorker<Record<string,Uint8Array>>('unpack',bytes,info.name,ctx.signal);ready(ctx);
  if(ext==='epub'){
    const container=entries['META-INF/container.xml'];if(!container)throw new Error('This EPUB has no container.');
    const location=parseXml(decoder.decode(container)).getElementsByTagNameNS('*','rootfile')[0]?.getAttribute('full-path')??'';
    if(!entries[location])throw new Error('This EPUB has no package document.');
    const packageDoc=parseXml(decoder.decode(entries[location]));const manifest=new Map<string,string>();let navPath='',ncxPath='';
    for(const item of Array.from(packageDoc.getElementsByTagNameNS('*','item'))){const path=memberPath(location,item.getAttribute('href')??'');manifest.set(item.getAttribute('id')??'',path);if((item.getAttribute('properties')??'').split(/\s+/).includes('nav'))navPath=path;if(item.getAttribute('media-type')==='application/x-dtbncx+xml')ncxPath=path;}
    const chapters=Array.from(packageDoc.getElementsByTagNameNS('*','itemref')).map(item=>manifest.get(item.getAttribute('idref')??'')??'');
    if(chapters.length>1000)throw new Error('This book exceeds the 1,000-chapter preview limit.');
    const html=chapters.map((name,index)=>entries[name]?`<section data-av-chapter="${index}">${localImages(decoder.decode(entries[name]),name,entries)}</section>`:'').join('');
    if(!html)throw new Error('This book has no readable chapters.');const controls=frame(ctx,html,info.name),fallback=controls.contents;const {bookContents}=await import('./book-contents');ready(ctx);const outlinePath=navPath||ncxPath;
    return Object.assign(controls,{contents:bookContents(outlinePath&&entries[outlinePath]?{path:outlinePath,xml:decoder.decode(entries[outlinePath]),kind:navPath?'nav':'ncx'}:undefined,chapters,fallback,()=>controls.findRoot,ctx.signal,ctx.notify)});
  }
  if(entries['word/document.xml'])throw new Error('This package needs the DOCX renderer.');
  const slides=Object.keys(entries).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(slides.length){
    if(slides.length>500)throw new Error('This presentation exceeds the 500-slide preview limit.');
    const wrapper=document.createElement('div');wrapper.className='slide-viewer';const content=document.createElement('div');
    let htmls:string[]=[];
    htmls=slides.map((name,index)=>{
      const doc=parseXml(decoder.decode(entries[name]));
      const paragraphs=Array.from(doc.getElementsByTagNameNS('*','p')).map(p=>Array.from(p.getElementsByTagNameNS('*','t')).map(t=>t.textContent??'').join('')).filter(Boolean);
      const relationshipPath=name.replace('/slides/','/slides/_rels/')+'.rels';const relationships=entries[relationshipPath]?parseXml(decoder.decode(entries[relationshipPath])):null;
      const images=Array.from(relationships?.getElementsByTagNameNS('*','Relationship')??[]).filter(rel=>(rel.getAttribute('Type')??'').endsWith('/image')&&rel.getAttribute('TargetMode')!=='External').map(rel=>memberPath(name,rel.getAttribute('Target')??''));
      return `<section class="slide"><h2>Slide ${index+1}</h2>${paragraphs.map(p=>`<p>${escape(p)}</p>`).join('')}${images.filter(image=>entries[image]).map(image=>`<img alt="Slide image" src="${inlineData(entries[image],image)}">`).join('')}</section>`;
    });
    const draw=(index:number)=>{ready(ctx);content.replaceChildren(documentFrame(htmls[index],`${info.name} · Slide ${index+1}`));};
    toolbar(ctx,wrapper,'Slide',slides.map((_,i)=>String(i+1)),value=>draw(Number(value)-1));wrapper.append(content);mount(ctx,wrapper,'frame-stage');draw(0);
    ctx.notify('Slide content preview · Exact shape/chart layout is not implemented.');return {};
  }
  const content=entries['content.xml']??entries['Contents/content.hpf'];
  if(content){
    const doc=parseXml(decoder.decode(content));
    const paragraphs=Array.from(doc.getElementsByTagName('*')).filter(node=>['p','h'].includes(node.localName)).slice(0,20000).map(node=>`<${node.localName==='h'?'h2':'p'}>${escape(node.textContent??'')}</${node.localName==='h'?'h2':'p'}>`);
    if(!paragraphs.length)throw new Error('This document has no supported visual content.');
    ctx.notify('Document flow preview · Exact page/drawing layout remains incomplete.');return frame(ctx,paragraphs.join(''),info.name);
  }
  throw new Error('A full visual renderer for this document package is not implemented yet.');
}
export async function renderExtended(info:ExtendedInfo,bytes:Uint8Array,ctx:PreviewContext):Promise<PreviewControls>{
  ready(ctx);ctx.notify('Local preview · Read only');
  if(info.kind==='paged'){const {renderPaged}=await import('./paged-preview');return renderPaged(info,bytes,ctx);}
  if(info.kind.startsWith('engine-')||info.kind==='bpmn'){const {renderEngine}=await import('./engine-preview');return renderEngine(info,bytes,ctx);}
  if(['npy','arrow','netcdf','hdf5'].includes(info.kind)){
    type Result={names?:string[];datasets:import('./scientific').DatasetPreview[]};
    const first=await runFormatWorker<Result>(info.kind,bytes,info.name,ctx.signal);ready(ctx);
    const wrapper=document.createElement('div'),body=document.createElement('div');body.className='table-scroll';let sequence=0;
    const draw=(result:Result)=>{const data=result.datasets[0];body.replaceChildren(table(['Index',...data.columns],data.rows.map((row,i)=>[String(i),...row])));ctx.notify(`Shape ${data.shape.join(' × ')} · Actual dataset values · Read only`);};
    if(first.names&&first.names.length>1)toolbar(ctx,wrapper,'Dataset',first.names,async name=>{
      const request=++sequence;try{const result=await runFormatWorker<Result>(info.kind,bytes,info.name,ctx.signal,name);ready(ctx);if(request===sequence)draw(result);}catch(error){if(!ctx.signal.aborted)ctx.notify(String(error));}
    });
    wrapper.append(body);mount(ctx,wrapper);draw(first);return {};
  }
  if(info.kind==='graphviz'){
    const result=await runFormatWorker<{svg:string}>('graphviz',bytes,info.name,ctx.signal);ready(ctx);
    // Graphviz emits its standard external SVG DTD declaration; no DTD is needed for display.
    return renderExtended({...info,kind:'svg'},new TextEncoder().encode(result.svg.replace(/<!DOCTYPE[^>]*>/gi,'')),ctx);
  }
  if(info.kind==='package-document')return showPackage(info,bytes,ctx);
  if(info.kind==='html')return frame(ctx,decoder.decode(bytes),info.name);
  if(info.kind==='metafile'){
    const result=await runFormatWorker<{svg:string}>('metafile',bytes,info.name,ctx.signal);ready(ctx);
    return renderExtended({...info,kind:'svg'},new TextEncoder().encode(result.svg),ctx);
  }
  if(info.kind==='svg'){
    const svg=sanitizeSvg(decoder.decode(bytes));ready(ctx);
    const image=document.createElement('img');image.id='preview-image';image.alt=info.name;image.src=blob(ctx,new TextEncoder().encode(svg),'image/svg+xml');mount(ctx,image,'image-stage');
    await image.decode();await ctx.fitContent?.(image.naturalWidth,image.naturalHeight);const {imageView}=await import('./image-view');ready(ctx);return imageView(ctx.stage,image,ctx.signal);
  }
  if(info.kind==='convert-image'){
    const result=await runFormatWorker<{bytes:Uint8Array;width:number;height:number}>('image',bytes,info.name,ctx.signal);ready(ctx);
    const image=document.createElement('img');image.id='preview-image';image.alt=info.name;image.src=blob(ctx,result.bytes,'image/png');mount(ctx,image,'image-stage');ctx.notify(`${result.width} × ${result.height} pixels · Read only`);
    await image.decode();await ctx.fitContent?.(image.naturalWidth,image.naturalHeight);const {imageView}=await import('./image-view');ready(ctx);return imageView(ctx.stage,image,ctx.signal);
  }
  if(info.kind==='audio'||info.kind==='video'){
    const {mediaPreview}=await import('./media-preview');ready(ctx);const controls=mediaPreview(ctx.stage,ctx.mediaUrl??blob(ctx,bytes,info.mime),info.name,info.kind==='video',ctx.signal,ctx.notify,ctx.fitContent,ctx.toolbar,ctx.icon);
    ctx.notify(info.kind==='video'?'Local video · Scroll to seek':'Press Play to start · Local audio · Scroll to seek');return controls;
  }
  if(info.kind==='font'){
    const name=`preview-font-${Math.random().toString(36).slice(2)}`;const face=new FontFace(name,bytes.slice().buffer);await face.load();ready(ctx);document.fonts.add(face);release(ctx,()=>{document.fonts.delete(face);});
    const article=document.createElement('article');article.className='font-specimen';const title=document.createElement('h1');title.textContent=info.name;article.append(title);
    for(const size of [14,18,24,36,48,72]){const line=document.createElement('p');line.style.fontFamily=`"${name}"`;line.style.fontSize=`${size}px`;line.textContent='The quick brown fox jumps over the lazy dog. 0123456789';article.append(line);}
    const input=document.createElement('input');input.type='text';input.setAttribute('aria-label','Font specimen text');input.value='Aa Bb Cc · العربية';input.style.fontFamily=`"${name}"`;input.style.fontSize='36px';article.append(input);mount(ctx,article);return {zoom:value=>{article.style.zoom=String(value);}};
  }
  if(info.kind==='spreadsheet'){
    const sheets=await runFormatWorker<{name:string;rows:string[][];truncated:boolean}[]>('spreadsheet',bytes,info.name,ctx.signal);ready(ctx);
    if(!sheets.length)throw new Error('This workbook has no sheets.');
    const wrapper=document.createElement('div');const body=document.createElement('div');body.className='table-scroll';let rowPages:HTMLSelectElement|undefined;
    const draw=(name:string)=>{
      const sheet=sheets.find(sheet=>sheet.name===name)!;body.replaceChildren();const count=Math.max(0,...sheet.rows.map(row=>row.length));
      const pages=Math.max(1,Math.ceil(sheet.rows.length/500));const renderPage=(page:number)=>body.replaceChildren(table(['',...Array.from({length:count},(_,i)=>cellName(i))],sheet.rows.slice(page*500,(page+1)*500).map((row,i)=>[String(page*500+i+1),...row])));
      rowPages?.parentElement?.remove();rowPages=toolbar(ctx,wrapper,'Rows',Array.from({length:pages},(_,i)=>`${i*500+1}–${Math.min((i+1)*500,sheet.rows.length)}`),value=>renderPage(Math.floor((Number(value.split('–')[0])-1)/500)));if(!ctx.toolbar)wrapper.insertBefore(rowPages.parentElement!,body);renderPage(0);
      ctx.notify(`${sheet.rows.length.toLocaleString()} rows · Formulas are not executed${sheet.truncated?' · Preview limit reached':''} · Charts/layout fidelity incomplete`);
    };
    toolbar(ctx,wrapper,'Sheet',sheets.map(sheet=>sheet.name),draw);wrapper.append(body);mount(ctx,wrapper);draw(sheets[0].name);return {zoom:value=>{body.style.fontSize=`${13*value}px`;}};
  }
  if(info.kind==='sqlite'||info.kind==='access'){
    type Result={tables:string[];columns:string[];rows:string[][];truncated?:boolean};
    const result=await runFormatWorker<Result>(info.kind,bytes,info.name,ctx.signal);ready(ctx);const wrapper=document.createElement('div'),body=document.createElement('div');body.className='table-scroll';
    let sequence=0;toolbar(ctx,wrapper,'Table',result.tables,async name=>{const order=++sequence;ctx.notify('Reading table…');try{const value=await runFormatWorker<Result>(info.kind,bytes,info.name,ctx.signal,name);ready(ctx);if(order!==sequence)return;body.replaceChildren(table(value.columns,value.rows));ctx.notify(`Read only · Up to 1,000 rows${value.truncated?' · More rows available in source':''}`);}catch(error){if(!ctx.signal.aborted)ctx.notify(String(error));}});
    wrapper.append(body);body.append(table(result.columns,result.rows));mount(ctx,wrapper);ctx.notify('Read-only table preview · Up to 1,000 rows per table');return {};
  }
  if(info.kind==='archive'){
    type Result={entries:{name:string;size:number;type:string}[];member?:Uint8Array;name?:string};
    const result=await runFormatWorker<Result>('archive',bytes,info.name,ctx.signal);ready(ctx);
    const wrapper=document.createElement('div');wrapper.className='archive-preview';const title=document.createElement('h2');title.textContent=info.name;wrapper.append(title);
    wrapper.append(table(['Name','Size (bytes)','Type'],result.entries.map(entry=>[entry.name,String(entry.size),entry.type])));
    const images=result.entries.filter(entry=>entry.type==='File'&&/\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name)).map(entry=>entry.name).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    if(images.length){
      const viewer=document.createElement('div');viewer.className='comic-page';let order=0,oldUrl='';
      const draw=async(name:string)=>{const request=++order;try{const member=await runFormatWorker<Result>('archive',bytes,info.name,ctx.signal,name);ready(ctx);if(request!==order||!member.member)return;const image=document.createElement('img');image.alt=name;image.src=blob(ctx,member.member,/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':/\.gif$/i.test(name)?'image/gif':'image/jpeg');if(oldUrl)URL.revokeObjectURL(oldUrl);oldUrl=image.src;viewer.replaceChildren(image);}catch(error){if(!ctx.signal.aborted)ctx.notify(String(error));}};
      toolbar(ctx,wrapper,'Image',images,name=>{void draw(name);});wrapper.append(viewer);if(/\.cb[rz7]$/i.test(info.name))void draw(images[0]);
    }
    mount(ctx,wrapper);ctx.notify(`${result.entries.length} archive entries · Nothing extracted to disk`);return {};
  }
  if(info.kind==='notebook'){
    const {renderMarkdown}=await import('./markdown');ready(ctx);
    const notebook=JSON.parse(decoder.decode(bytes));if(!Array.isArray(notebook.cells)||notebook.cells.length>2000)throw new Error('This notebook is invalid or exceeds 2,000 cells.');
    const html=notebook.cells.map((cell:{cell_type:string;source:string[]|string;outputs?:{data?:Record<string,string|string[]>;text?:string[]|string}[]})=>{
      const source=Array.isArray(cell.source)?cell.source.join(''):String(cell.source??'');
      let content=cell.cell_type==='markdown'?renderMarkdown(source).html:`<pre><code>${escape(source)}</code></pre>`;
      for(const output of (cell.outputs??[]).slice(0,100)){
        const data=output.data??{};const get=(key:string)=>Array.isArray(data[key])?(data[key] as string[]).join(''):String(data[key]??'');
        if(data['image/png'])content+=`<img alt="Saved notebook output" src="data:image/png;base64,${get('image/png').replace(/[^A-Za-z0-9+/=]/g,'')}">`;
        else if(data['text/html'])content+=get('text/html');
        else content+=`<pre>${escape(get('text/plain')||(Array.isArray(output.text)?output.text.join(''):output.text??''))}</pre>`;
      }
      return `<section class="notebook-cell">${content}</section>`;
    }).join('');return frame(ctx,html,info.name);
  }
  if(info.kind==='calendar'){
    const unfolded=decoder.decode(bytes).replace(/\r?\n[ \t]/g,'');const records=unfolded.split(/BEGIN:(?:VEVENT|VCARD|VTODO)/i).slice(1,1001);
    const article=document.createElement('article');article.className='record-cards';
    for(const record of records){const card=document.createElement('section');for(const line of record.split(/\r?\n/)){const split=line.indexOf(':');if(split<1||/^END:/.test(line))continue;const row=document.createElement('p');const label=document.createElement('strong');label.textContent=line.slice(0,split).replace(/;.*/,'')+': ';row.append(label,document.createTextNode(line.slice(split+1).replace(/\\n/gi,'\n').replace(/\\([,;\\])/g,'$1')));card.append(row);}article.append(card);}
    if(!records.length)throw new Error('This contact/calendar format does not have a visual decoder yet.');mount(ctx,article);return {};
  }
  if(info.kind==='email'){
    const source=decoder.decode(bytes);const [headers,...parts]=source.split(/\r?\n\r?\n/);const body=parts.join('\n\n');
    const headerLines=headers.replace(/\r?\n[ \t]/g,' ').split(/\r?\n/).filter(line=>/^(From|To|Subject|Date|Cc):/i.test(line));
    return frame(ctx,headerLines.map(line=>`<p><strong>${escape(line)}</strong></p>`).join('')+`<hr><pre>${escape(body)}</pre>`,info.name);
  }
  if(info.kind==='model'){
    const {renderModel}=await import('./model-preview');ready(ctx);return renderModel(info,bytes,ctx);
  }
  throw new Error('A full visual renderer for this format is not implemented yet.');
}
