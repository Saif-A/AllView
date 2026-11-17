import type {ViewerController} from '@file-viewer/web';
/** One in-flight document-scale operation and one replaceable target; never resize the viewer host. */
export function rendererZoom(controller:Pick<ViewerController,'getState'|'applyViewState'|'fitToView'>,signal:AbortSignal,onScale:(scale:number)=>void,notify:(text:string)=>void){
 let current=controller.getState().zoom?.scale??1,manual:number|null=null,pending:{scale:number}|{fit:true}|null=null,busy=false,scheduled=false,epoch=0;
 const bounded=(value:number)=>{const bounds=controller.getState().zoom;return Math.max(bounds?.minScale??.01,Math.min(bounds?.maxScale??5,Number.isFinite(value)?value:current))};
 const schedule=()=>{if(scheduled||busy||signal.aborted)return;scheduled=true;queueMicrotask(()=>{scheduled=false;void flush()})};
 async function flush(){
  if(busy||!pending||signal.aborted||!controller.getState().ready)return;
  const wanted=pending,token=epoch;pending=null;busy=true;
  try{
   const result='fit'in wanted?await controller.fitToView({mode:'width',resize:'until-interaction',padding:16}):await controller.applyViewState({scale:wanted.scale},{source:'user',action:'zoom-change'});
   if(signal.aborted||token!==epoch)return;
   const actual=result?.scale??controller.getState().zoom?.scale??current;if(Number.isFinite(actual)&&actual>0)current=actual;
   if(!pending){if('scale'in wanted&&manual!==null)manual=current;onScale(current)}
  }catch(error){if(!signal.aborted&&token===epoch)notify(`Document zoom could not be changed: ${String(error)}`)}
  finally{busy=false;if(pending)schedule()}
 }
 const observe=()=>{
  if(signal.aborted)return;const value=controller.getState().zoom?.scale;if(!Number.isFinite(value)||!value||value<=0)return;current=value;
  if(busy)return;
  if(manual!==null&&Math.abs(current-manual)>.001){pending={scale:bounded(manual)};schedule();return}
  if(!pending)onScale(current);else schedule();
 };
 const cancel=()=>{epoch++;pending=null};signal.addEventListener('abort',cancel,{once:true});
 return {initialZoom:current,observe,cancel,zoom(value:number){manual=bounded(value);pending={scale:manual};schedule()},fit(){manual=null;pending={fit:true};schedule();return current}};
}
