/** Content-only zoom for Word-family layouts that do not publish an SDK zoom provider. */
export function documentZoom(viewport:HTMLElement,content:HTMLElement,page:HTMLElement,signal:AbortSignal,onScale:(value:number)=>void){
 let value=1,manual=false,fitting=false,frame=0,lastWidth=viewport.clientWidth,lastHeight=viewport.clientHeight;
 const logicalWidth=Math.max(1,lastWidth);
 const originals=[viewport.getAttribute('style'),content.getAttribute('style')];
 viewport.style.overflow='auto';viewport.style.height='100%';viewport.style.minHeight='0';viewport.style.background=getComputedStyle(content).backgroundColor;
 content.style.minHeight='0';content.style.height='auto';content.style.overflow='visible';content.style.marginInline='auto';
 const clamp=(n:number)=>Math.max(.01,Math.min(5,Number.isFinite(n)?n:1));
 const draw=()=>{if(signal.aborted)return;content.style.width=`${logicalWidth}px`;content.style.zoom=String(value);onScale(value)};
 const fitViewport=(expand:boolean)=>{value=1;draw();const width=page.getBoundingClientRect().width;value=clamp(Math.min(expand?5:1,(viewport.clientWidth-24)/Math.max(1,width)));draw();viewport.scrollLeft=Math.max(0,(content.getBoundingClientRect().width-viewport.clientWidth)/2);viewport.scrollTop=0;return value};
 const fit=()=>{manual=false;fitting=true;return fitViewport(true)};
 const cancel=()=>{cancelAnimationFrame(frame);frame=0};
 const observer=new ResizeObserver(()=>{const width=viewport.clientWidth,height=viewport.clientHeight;if(width===lastWidth&&height===lastHeight)return;lastWidth=width;lastHeight=height;cancel();if(!manual)frame=requestAnimationFrame(()=>{frame=0;fitViewport(fitting)})});observer.observe(viewport);draw();
 signal.addEventListener('abort',()=>{cancel();observer.disconnect();for(const [i,node]of [viewport,content].entries()){if(originals[i]===null)node.removeAttribute('style');else node.setAttribute('style',originals[i]!)}},{once:true});
 return {initialZoom:value,observe(){if(!signal.aborted)onScale(value)},cancel,fit,zoom(next:number){cancel();manual=true;fitting=false;value=clamp(next);draw()}};
}
