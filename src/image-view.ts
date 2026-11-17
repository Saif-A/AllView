import type {ZoomAnchor} from './viewer-interaction';
/** Pixel-accurate image zoom and captured-pointer panning of the rotated bounds. */
export function imageView(stage:HTMLElement,image:HTMLImageElement,signal:AbortSignal){
  stage.className='image-stage pixel-image-stage';const bounds=document.createElement('div');bounds.className='image-bounds';bounds.append(image);stage.replaceChildren(bounds);let scale=1,angle=0;
  let pan:{id:number;x:number;y:number;left:number;top:number}|null=null;
  const canPan=()=>stage.scrollWidth>stage.clientWidth+1||stage.scrollHeight>stage.clientHeight+1;
  const updateCursor=()=>{if(!signal.aborted)stage.classList.toggle('image-can-pan',canPan());};
  const cancelPan=()=>{const id=pan?.id;pan=null;stage.classList.remove('image-panning');if(id!==undefined&&stage.hasPointerCapture(id))stage.releasePointerCapture(id);};
  const dimensions=()=>angle%180?[image.naturalHeight,image.naturalWidth]:[image.naturalWidth,image.naturalHeight];
  const draw=()=>{const [w,h]=dimensions();bounds.style.width=`${w*scale}px`;bounds.style.height=`${h*scale}px`;image.style.width=`${image.naturalWidth*scale}px`;image.style.height=`${image.naturalHeight*scale}px`;image.style.transform=`translate(-50%,-50%) rotate(${angle}deg)`;updateCursor();};
  const fit=(expand=false)=>{cancelPan();const [w,h]=dimensions(),viewport=stage.getBoundingClientRect();scale=Math.max(.01,Math.min(expand?5:1,(viewport.width-16)/Math.max(1,w),(viewport.height-16)/Math.max(1,h)));draw();stage.scrollLeft=stage.scrollTop=0;return scale};
  const anchor=(x:number,y:number):ZoomAnchor=>{const rect=bounds.getBoundingClientRect();return {x,y,u:Math.max(0,Math.min(1,(x-rect.left)/Math.max(1,rect.width))),v:Math.max(0,Math.min(1,(y-rect.top)/Math.max(1,rect.height)))};};
  image.draggable=false;stage.tabIndex=-1;
  stage.addEventListener('dragstart',event=>event.preventDefault(),{signal});
  stage.addEventListener('pointerdown',event=>{
    if(event.button!==0||!event.isPrimary||!canPan())return;
    event.preventDefault();stage.dispatchEvent(new Event('image-pan-start'));
    stage.focus({preventScroll:true});pan={id:event.pointerId,x:event.clientX,y:event.clientY,left:stage.scrollLeft,top:stage.scrollTop};
    stage.setPointerCapture(event.pointerId);stage.classList.add('image-panning');
  },{signal});
  stage.addEventListener('pointermove',event=>{
    if(!pan||event.pointerId!==pan.id)return;
    if(!(event.buttons&1)){cancelPan();return;}
    event.preventDefault();stage.scrollLeft=pan.left-(event.clientX-pan.x);stage.scrollTop=pan.top-(event.clientY-pan.y);
  },{signal});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])stage.addEventListener(type,event=>{if((event as PointerEvent).pointerId===pan?.id)cancelPan();},{signal});
  window.addEventListener('blur',cancelPan,{signal});
  const observer=new ResizeObserver(updateCursor);observer.observe(stage);
  signal.addEventListener('abort',()=>{cancelPan();observer.disconnect();stage.classList.remove('image-can-pan');},{once:true});
  fit();return {anchor,cancelPan,zoom:(value:number,point?:ZoomAnchor)=>{
    const viewport=stage.getBoundingClientRect();
    const fixed=point?.u!==undefined&&point.v!==undefined?point:anchor(point?.x??viewport.left+stage.clientWidth/2,point?.y??viewport.top+stage.clientHeight/2);
    const {x,y}=fixed,fx=fixed.u!,fy=fixed.v!;
    scale=value;draw();const next=bounds.getBoundingClientRect();
    stage.scrollLeft+=next.left+fx*next.width-x;stage.scrollTop+=next.top+fy*next.height-y;
  },rotate:(value:number)=>{angle=value;draw()},fit,initialZoom:scale};
}
