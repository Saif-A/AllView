/** Pure input policy: wheel values are continuous; discrete shortcuts keep their steps. */
export interface ZoomAnchor {x:number;y:number;u?:number;v?:number}
export const ZOOM_GESTURE_GAP=400;
export function createZoomGesture<T>() {
  let anchor:T|undefined,last=-Infinity;
  return {
    next(now:number,capture:()=>T):T {if(anchor===undefined||now-last>=ZOOM_GESTURE_GAP)anchor=capture();last=now;return anchor;},
    reset(){anchor=undefined;last=-Infinity;},
  };
}
export function wheelZoom(value:number,delta:number,mode=0,pageHeight=800):number {
  if(!Number.isFinite(delta)||delta===0)return value;
  const pixels=delta*(mode===1?16:mode===2?pageHeight:1);
  return Math.min(5,Math.max(.01,value*Math.exp(-Math.max(-240,Math.min(240,pixels))*.0015)));
}
export function siblingDirection(event:Pick<KeyboardEvent,'key'|'altKey'|'ctrlKey'|'shiftKey'|'metaKey'|'repeat'|'defaultPrevented'>,interactive:boolean,kind:string|undefined):-1|0|1 {
  if(event.defaultPrevented||event.repeat||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight'].includes(event.key))return 0;
  if(!event.altKey&&(interactive||['audio','video','model','engine-model','engine-geo','engine-cad','engine-dicom','engine-spreadsheet','engine-data','bpmn'].includes(kind??'')))return 0;
  return event.key==='ArrowLeft'?-1:1;
}
