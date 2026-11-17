/** Small dependency-free controls shared by preview tools. No global state or parser imports. */
export const ZOOM_STEPS = [.25,.33,.5,.67,.75,.8,.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5];
export function zoomStep(value:number,direction:number):number {
  return direction>0 ? ZOOM_STEPS.find(step=>step>value+.001)??5 : [...ZOOM_STEPS].reverse().find(step=>step<value-.001)??Math.min(.25,value);
}
export function clampZoom(value:number):number {return Math.min(5,Math.max(.01,Number.isFinite(value)?value:1));}
export function typing(target:EventTarget|null):boolean {return target instanceof Element&&!!target.closest('input,textarea,select,[contenteditable="true"],.cm-editor');}
export function button(label:string,action:()=>void,className='tool-button'):HTMLButtonElement {
  const node=document.createElement('button');node.type='button';node.textContent=label;node.className=className;node.onclick=action;return node;
}
export function field(label:string,input:HTMLElement):HTMLLabelElement {const node=document.createElement('label');node.className='tool-field';const span=document.createElement('span');span.textContent=label;node.append(span,input);return node;}
export function select(items:Record<string,string>,value:string):HTMLSelectElement {const node=document.createElement('select');for(const [key,label] of Object.entries(items)){const option=document.createElement('option');option.value=key;option.textContent=label;node.append(option)}node.value=value;return node;}
export function number(value:number,min:number,max:number,step=1):HTMLInputElement {const node=document.createElement('input');node.type='number';node.value=String(value);node.min=String(min);node.max=String(max);node.step=String(step);return node;}
export function formatBytes(bytes:number):string {if(bytes===0)return '0 B';const unit=Math.min(4,Math.floor(Math.log(Math.max(1,bytes))/Math.log(1024)));return `${(bytes/1024**unit).toLocaleString(undefined,{maximumFractionDigits:unit?1:0})} ${['B','KiB','MiB','GiB','TiB'][unit]}`;}
export function frame():Promise<void> {return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));}
export function toolDialog(title:string):{dialog:HTMLDialogElement;body:HTMLElement;close:()=>void} {
  const dialog=document.createElement('dialog');dialog.className='tool-dialog';const header=document.createElement('header');const heading=document.createElement('h2');heading.textContent=title;
  const close=()=>{dialog.close();dialog.remove()};const dismiss=button('Close',close);dismiss.setAttribute('aria-label',`Close ${title}`);header.append(heading,dismiss);
  const body=document.createElement('section');body.className='tool-body';dialog.append(header,body);dialog.addEventListener('cancel',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();return {dialog,body,close};
}
