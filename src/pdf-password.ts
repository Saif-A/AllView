/** Password entry belongs to read-only PDF viewing; no editing engine is loaded. */
export function pdfPassword(retry:boolean,signal:AbortSignal):Promise<string|null>{
  if(signal.aborted)return Promise.resolve(null);
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='tool-dialog';
    const form=document.createElement('form');form.method='dialog';
    const heading=document.createElement('h2');heading.textContent=retry?'Incorrect password — try again':'Open protected PDF';
    const label=document.createElement('label');label.textContent='Password';
    const input=document.createElement('input');input.type='password';input.autocomplete='off';input.maxLength=127;input.setAttribute('aria-label','Password');label.append(input);
    const actions=document.createElement('div');actions.className='startup-actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
    const unlock=document.createElement('button');unlock.type='submit';unlock.textContent='Unlock';
    let finished=false;
    const finish=(value:string|null)=>{if(finished)return;finished=true;signal.removeEventListener('abort',abort);input.value='';dialog.close();dialog.remove();resolve(value)};
    const abort=()=>finish(null);signal.addEventListener('abort',abort,{once:true});
    cancel.onclick=abort;form.onsubmit=e=>{e.preventDefault();finish(input.value)};dialog.oncancel=e=>{e.preventDefault();finish(null)};
    actions.append(cancel,unlock);form.append(heading,label,actions);dialog.append(form);document.body.append(dialog);dialog.showModal();input.focus();
  });
}
