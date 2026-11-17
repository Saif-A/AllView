import {invoke} from '@tauri-apps/api/core';
import {button,field,number,select,toolDialog,frame} from './ux';
import {portraitSheets} from './print-layout';
export function portraitPrint(src:string,title:string,signal?:AbortSignal){
  const {dialog,body,close}=toolDialog('Print image');signal?.addEventListener('abort',close,{once:true});const controls=document.createElement('div');controls.className='tool-grid';
  const preset=select({'35,45':'35 × 45 mm','30,40':'30 × 40 mm','40,60':'40 × 60 mm','50.8,50.8':'2 × 2 inches','custom':'Custom'},'35,45');
  const paper=select({'210,297':'A4','215.9,279.4':'Letter','100,150':'10 × 15 cm','101.6,152.4':'4 × 6 inches'},'210,297');const orientation=select({portrait:'Portrait',landscape:'Landscape'},'portrait');
  const width=number(35,5,500,.1),height=number(45,5,500,.1),copies=number(8,1,100),margin=number(8,0,50,.5),gap=number(3,0,30,.5);const fit=select({cover:'Crop to fill',contain:'Fit whole image'},'cover');
  const positionX=document.createElement('input'),positionY=document.createElement('input');for(const input of [positionX,positionY]){input.type='range';input.min='0';input.max='100';input.value='50'}positionX.setAttribute('aria-label','Crop horizontal position');positionY.setAttribute('aria-label','Crop vertical position');
  controls.append(field('Portrait size',preset),field('Width (mm)',width),field('Height (mm)',height),field('Paper',paper),field('Orientation',orientation),field('Copies',copies),field('Margin (mm)',margin),field('Gap (mm)',gap),field('Placement',fit),field('Horizontal crop',positionX),field('Vertical crop',positionY));
  const status=document.createElement('p');status.className='tool-note';const preview=document.createElement('div');preview.className='sheet-preview';const surface=document.createElement('div');surface.id='print-surface';surface.setAttribute('aria-hidden','true');document.body.append(surface);const style=document.createElement('style');document.head.append(style);
  const print=button('Print…',async()=>{try{await frame();await Promise.all(Array.from(surface.querySelectorAll('img')).map(image=>image.decode()));if('__TAURI_INTERNALS__' in window)await invoke('print_preview');else window.print()}catch(error){status.textContent=String(error)}});print.classList.add('primary-button');
  const note=document.createElement('p');note.className='tool-note';note.textContent='Use 100% / Actual size in the printer dialog. Disable browser headers/footers and match the selected paper. Presets specify physical size; check your issuing authority’s photo rules.';
  const clean=()=>{surface.remove();style.remove()};dialog.addEventListener('close',clean,{once:true});dialog.addEventListener('cancel',clean,{once:true});body.append(controls,status,preview,note,print);
  const draw=()=>{preview.replaceChildren();surface.replaceChildren();try{
    let [pw,ph]=paper.value.split(',').map(Number);if(orientation.value==='landscape')[pw,ph]=[ph,pw];
    const sheets=portraitSheets({paperWidth:pw,paperHeight:ph,width:Number(width.value),height:Number(height.value),margin:Number(margin.value),gap:Number(gap.value),copies:Number(copies.value)});
    style.textContent=`@media print{@page{size:${pw}mm ${ph}mm;margin:0}}`;
    for(const placements of sheets){const sheet=document.createElement('div');sheet.className='print-sheet';sheet.style.width=`${pw}mm`;sheet.style.height=`${ph}mm`;
      for(const place of placements){const image=document.createElement('img');image.src=src;image.alt=title;Object.assign(image.style,{position:'absolute',left:`${place.x}mm`,top:`${place.y}mm`,width:`${place.width}mm`,height:`${place.height}mm`,objectFit:fit.value,objectPosition:`${positionX.value}% ${positionY.value}%`});sheet.append(image)}
      const thumbnail=document.createElement('div');thumbnail.className='sheet-thumbnail';thumbnail.style.width=`${pw*1.25}px`;thumbnail.style.height=`${ph*1.25}px`;const copy=sheet.cloneNode(true) as HTMLElement;copy.style.transform='scale(.3307291667)';copy.style.transformOrigin='top left';thumbnail.append(copy);preview.append(thumbnail);surface.append(sheet);
    }
    status.textContent=`${copies.value} copies · ${sheets.length} sheet${sheets.length===1?'':'s'} · ${width.value} × ${height.value} mm`;print.disabled=false;
  }catch(error){status.textContent=String(error);print.disabled=true}};
  preset.onchange=()=>{if(preset.value!=='custom'){[width.value,height.value]=preset.value.split(',')}draw()};for(const input of [width,height])input.addEventListener('input',()=>{preset.value='custom'});
  controls.addEventListener('input',draw);controls.addEventListener('change',draw);draw();return dialog;
}
export async function printDocument(stage:HTMLElement,title:string,sourceText?:string){
  const {dialog,body}=toolDialog('Print preview');const surface=document.createElement('div');surface.id='print-surface';const content=document.createElement('article');content.className='print-document';const heading=document.createElement('h1');heading.textContent=title;content.append(heading);
  const source=stage.querySelector('iframe') as HTMLIFrameElement|null;const origin=source?.contentDocument?.body??stage.firstElementChild?.shadowRoot??stage;
  if(sourceText!==undefined||stage.querySelector('.cm-editor')){const pre=document.createElement('pre');pre.textContent=sourceText??stage.querySelector('.cm-content')?.textContent??stage.textContent;content.append(pre)}else{for(const child of origin.childNodes)content.append(child.cloneNode(true));
    const canvases=origin.querySelectorAll('canvas'),copies=content.querySelectorAll('canvas');for(let i=0;i<canvases.length;i++){const image=document.createElement('img');image.src=canvases[i].toDataURL();copies[i]?.replaceWith(image)}}
  for(const node of content.querySelectorAll('button,input,select,script,style,link,video,audio,iframe,.textLayer'))node.remove();surface.append(content);document.body.append(surface);
  const summary=document.createElement('p');summary.textContent='Print the current document view. Paged renderers print the visible page. Use the printer dialog to choose pages, paper and scaling.';const sample=document.createElement('div');sample.className='document-print-sample';sample.append(content.cloneNode(true));
  body.append(summary,sample,button('Print…',async()=>{await frame();if('__TAURI_INTERNALS__' in window)await invoke('print_preview');else window.print()}));const clean=()=>surface.remove();dialog.addEventListener('close',clean,{once:true});dialog.addEventListener('cancel',clean,{once:true});
}
