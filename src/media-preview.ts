import {button,field,select,typing} from './ux';
import {createMediaWheel} from './media-interaction';
export function mediaPreview(parent:HTMLElement,url:string,name:string,video:boolean,signal:AbortSignal,notify:(text:string)=>void,fitContent?:(width:number,height:number,extraHeight?:number)=>Promise<void>,toolbarHost?:HTMLElement,icon?:(name:string)=>string) {
  const root=document.createElement('section');root.className=video?'media-player video-player':'media-player';root.tabIndex=0;root.setAttribute('aria-label',name);
  const media=document.createElement(video?'video':'audio');media.preload=video?'auto':'metadata';media.src=url;media.autoplay=false;
  const title=document.createElement('div');title.className='media-name';title.textContent=name;const bar=document.createElement('div');bar.className=toolbarHost?'format-tools media-tools toolbar-group':'media-controls';bar.setAttribute('role','group');bar.setAttribute('aria-label','Playback controls');if(toolbarHost)root.classList.add('shared-media-tools');
  const play=button('▶',()=>{if(media.paused)void media.play().catch(error=>notify(String(error)));else media.pause()});play.setAttribute('aria-label','Play / Pause (K)');
  const seek=document.createElement('input');seek.type='range';seek.min='0';seek.max='1000';seek.value='0';seek.step='1';seek.setAttribute('aria-label','Seek');const time=document.createElement('span');time.className='media-time';
  const stamp=(n:number)=>Number.isFinite(n)?`${n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}`:Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`:'0:00';
  const volume=document.createElement('input');volume.type='range';volume.min='0';volume.max='1';volume.step='.05';volume.value='1';volume.setAttribute('aria-label','Volume');
  const mute=button('Sound',()=>{media.muted=!media.muted;update()});mute.setAttribute('aria-label','Mute / Unmute (M)');
  const speed=select({'0.25':'0.25×','0.5':'0.5×','0.75':'0.75×','1.00':'1×','1.25':'1.25×','1.5':'1.5×','1.75':'1.75×','2.00':'2×'},'1.00');speed.setAttribute('aria-label','Playback speed');
  const full=button('⛶',()=>{if(document.fullscreenElement)void document.exitFullscreen();else void (toolbarHost?document.getElementById('app')??root:root).requestFullscreen()});full.setAttribute('aria-label','Fullscreen (F)');full.hidden=!video;
  const update=()=>{if(toolbarHost&&icon){play.innerHTML=icon(media.paused?'play':'pause');mute.innerHTML=icon(media.muted?'muted':'sound')}else{play.textContent=media.paused?'▶':'Ⅱ';mute.textContent=media.muted?'Muted':'Sound'}play.title=media.paused?'Play · K / Space':'Pause · K / Space';mute.setAttribute('aria-pressed',String(media.muted));volume.value=String(media.volume);volume.title=`Volume ${Math.round(media.volume*100)}% · Scroll to adjust`;time.textContent=`${stamp(media.currentTime)} / ${stamp(media.duration)}`;if(Number.isFinite(media.duration)&&media.duration>0)seek.value=String(media.currentTime/media.duration*1000)};
  const skip=(seconds:number)=>{if(Number.isFinite(media.duration))media.currentTime=Math.max(0,Math.min(media.duration,media.currentTime+seconds))};
  const wheel=createMediaWheel();let wheelFrame=0,pendingSeek=0,pendingVolume=0;
  const cancelWheel=()=>{cancelAnimationFrame(wheelFrame);wheelFrame=0;pendingSeek=0;pendingVolume=0;wheel.reset()};
  const setVolume=(value:number)=>{media.volume=Math.max(0,Math.min(1,value));media.muted=false;update()};
  const onWheel=(event:WheelEvent)=>{
    if(event.defaultPrevented||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||document.querySelector('dialog[open]:not(.find-dialog)')||!(event.target instanceof Element)||event.target.closest('select')||!Number.isFinite(event.deltaY)||!event.deltaY)return;
    const target=event.target===volume||mute.contains(event.target)?'volume':'seek';
    if(target==='seek'&&(!Number.isFinite(media.duration)||media.duration<=0))return;
    event.preventDefault();const steps=wheel.steps(target,event.deltaY,event.deltaMode,performance.now());
    if(target==='volume')pendingVolume=Math.max(-1,Math.min(1,pendingVolume+steps*.05));else pendingSeek=Math.max(-60,Math.min(60,pendingSeek+steps*5));
    if(!wheelFrame&&(pendingSeek||pendingVolume))wheelFrame=requestAnimationFrame(()=>{wheelFrame=0;if(pendingSeek)skip(pendingSeek);if(pendingVolume)setVolume(media.volume+pendingVolume);pendingSeek=0;pendingVolume=0;update()});
  };root.addEventListener('wheel',onWheel,{passive:false,signal});if(toolbarHost)bar.addEventListener('wheel',onWheel,{passive:false,signal});
  seek.title='Scroll up/down to seek forward/backward 5 seconds';mute.title='Mute / Unmute · Scroll to adjust volume';
  seek.oninput=()=>{cancelWheel();if(Number.isFinite(media.duration))media.currentTime=Number(seek.value)/1000*media.duration};volume.oninput=()=>{cancelWheel();setVolume(Number(volume.value))};speed.onchange=()=>{media.playbackRate=Number(speed.value)};
  for(const event of ['loadedmetadata','timeupdate','play','pause','volumechange','ended'])media.addEventListener(event,update,{signal});
  media.addEventListener('loadedmetadata',()=>{if(media instanceof HTMLVideoElement&&!signal.aborted)void fitContent?.(media.videoWidth,media.videoHeight,toolbarHost?0:44)},{once:true,signal});
  media.addEventListener('error',()=>notify('This media could not be played. Its codec may be unsupported, or the file may have changed or become unavailable.'),{signal});
  let clickTimer:ReturnType<typeof setTimeout>|undefined;
  media.addEventListener('click',event=>{clearTimeout(clickTimer);if(event instanceof MouseEvent&&event.detail===1)clickTimer=setTimeout(()=>play.click(),320)},{signal});
  media.addEventListener('dblclick',()=>clearTimeout(clickTimer),{signal});
  document.addEventListener('keydown',event=>{
    if(!root.isConnected||document.querySelector('dialog[open]:not(.find-dialog)')||event.ctrlKey||event.altKey||event.metaKey||typing(event.target)||(event.target instanceof Element&&event.target.closest('.document-sidebar,.find-panel')))return;
    if(event.key===' '&&event.target instanceof HTMLButtonElement)return;
    cancelWheel();
    const key=event.key.toLowerCase();let handled=true;
    if(key==='k'||key===' ')play.click();else if(key==='j')skip(-10);else if(key==='l')skip(10);else if(key==='arrowleft')skip(-5);else if(key==='arrowright')skip(5);else if(key==='m')mute.click();else if(key==='f'&&video)full.click();else if(key==='arrowup'||key==='arrowdown')setVolume(media.volume+(key==='arrowup'?.05:-.05));else if(/^[0-9]$/.test(key)&&Number.isFinite(media.duration))media.currentTime=Number(key)/10*media.duration;else handled=false;
    if(handled){event.preventDefault();update()}
  },{signal});
  bar.append(play,seek,time,mute,volume,field('Speed',speed));if(toolbarHost)toolbarHost.append(bar);else{bar.append(full);root.append(bar)}root.prepend(media,title);parent.replaceChildren(root);parent.className='media-stage';update();
  if(video&&!signal.aborted)void media.play().then(()=>{if(signal.aborted||!root.isConnected||document.hidden)media.pause()}).catch(error=>{if(!signal.aborted&&(error as DOMException).name!=='AbortError')notify('Automatic playback could not start. Press Play to start this clip.')});
  signal.addEventListener('abort',()=>{clearTimeout(clickTimer);cancelWheel();bar.remove();media.pause();media.removeAttribute('src');media.load()},{once:true});return {cancelPan:()=>{clearTimeout(clickTimer);cancelWheel()}};
}
