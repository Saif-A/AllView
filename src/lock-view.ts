import {invoke} from '@tauri-apps/api/core';
import {button,toolDialog} from './ux';
export interface LockProcess {token:number;pid:number;executable:string;paths:string[];protectedReason:string}
export interface LockReport {scanId:number;processes:LockProcess[];partial:boolean;inaccessible:number;elapsedMs:number}
type NativeInvoke = <T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
// Optional transport allows the emitted UI to be exercised with controlled results.
export function lockView(id:number,path:string,signal:AbortSignal,call:NativeInvoke=invoke){
  const {dialog,body}=toolDialog('File and folder locks');dialog.classList.add('lock-dialog');
  const target=document.createElement('p');target.className='lock-target';target.textContent=path;
  const note=document.createElement('p');note.className='tool-note';note.textContent='Shows applications using this file or folder, including files below a folder. An open handle may allow some operations. Protected or inaccessible applications can be missing.';
  const toolbar=document.createElement('div');toolbar.className='lock-toolbar';
  const status=document.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const list=document.createElement('div');list.className='lock-list';
  const confirmation=document.createElement('section');confirmation.className='lock-confirm';confirmation.hidden=true;
  let closed=false,busy=false,report:LockReport|null=null;
  const alive=()=>!closed&&!signal.aborted&&dialog.isConnected;
  const refresh=button('Refresh',()=>{void load()});
  const cancel=button('Cancel scan',()=>{void call('cancel_locks');status.textContent='Stopping scan…'});
  toolbar.append(refresh,cancel);body.append(target,note,toolbar,status,confirmation,list);
  const onAbort=()=>{dialog.close();dialog.remove();stop();observer.disconnect()};
  const stop=()=>{if(closed)return;closed=true;signal.removeEventListener('abort',onAbort);void call('cancel_locks')};
  const observer=new MutationObserver(()=>{if(!dialog.isConnected){stop();observer.disconnect()}});observer.observe(document.body,{childList:true});
  dialog.addEventListener('close',()=>{stop();observer.disconnect()},{once:true});
  signal.addEventListener('abort',onAbort,{once:true});
  function setBusy(value:boolean){busy=value;refresh.disabled=value;cancel.disabled=!value;list.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=value||b.dataset.protected==='true')}
  function confirm(process:LockProcess,force:boolean){
    if(busy||!report)return;confirmation.replaceChildren();confirmation.hidden=false;
    const text=document.createElement('p');const name=process.executable.split(/[\\/]/).pop()||'Application';
    text.textContent=force?`End ${name} (PID ${process.pid})? Unsaved work in this application can be lost. This affects the whole process, including its other files.`:`Ask ${name} (PID ${process.pid}) to close? Save your work in that application when prompted. This closes its windows, including other open files.`;
    const actions=document.createElement('div');actions.className='tool-actions';
    const back=button('Cancel',()=>{confirmation.hidden=true});
    const submit=button(force?'End process':'Ask to close',()=>{confirmation.hidden=true;void release(process,force)});if(force)submit.classList.add('lock-danger');actions.append(back,submit);confirmation.append(text,actions);back.focus();
  }
  function draw(){
    list.replaceChildren();if(!report)return;
    if(!report.processes.length){const empty=document.createElement('p');empty.textContent='No accessible applications found using this path. This does not guarantee it is unlocked.';list.append(empty);return}
    for(const process of report.processes){
      const row=document.createElement('article');row.className='lock-process';const title=document.createElement('h3');title.textContent=`${process.executable.split(/[\\/]/).pop()||'Unknown application'} · PID ${process.pid}`;
      const exe=document.createElement('p');exe.className='tool-note';exe.textContent=process.executable||'Executable path unavailable';
      const paths=document.createElement('ul');for(const path of process.paths){const item=document.createElement('li');item.textContent=path;paths.append(item)}
      const actions=document.createElement('div');actions.className='lock-toolbar';
      const close=button('Ask to close',()=>confirm(process,false));const end=button('End process…',()=>confirm(process,true));end.classList.add('lock-danger');
      for(const control of [close,end]){control.disabled=!!process.protectedReason;control.dataset.protected=String(!!process.protectedReason);if(process.protectedReason)control.title=process.protectedReason}
      const protection=document.createElement('span');protection.className='tool-note';protection.textContent=process.protectedReason;actions.append(close,end,protection);row.append(title,exe,paths,actions);list.append(row);
    }
  }
  async function load(){
    if(!alive()||busy)return;confirmation.hidden=true;report=null;list.replaceChildren();setBusy(true);status.textContent='Checking Windows handles…';
    try{const next=await call<LockReport>('scan_locks',{id});if(!alive())return;report=next;draw();status.textContent=`${next.processes.length} application(s) · ${(next.elapsedMs/1000).toFixed(2)} s${next.partial?' · Partial scan':''}${next.inaccessible?` · ${next.inaccessible} inaccessible process(es)`:''}`}
    catch(error){if(alive())status.textContent=String(error)}finally{if(alive())setBusy(false)}
  }
  async function release(process:LockProcess,force:boolean){
    if(!alive()||busy||!report)return;const scanId=report.scanId;setBusy(true);status.textContent='Rechecking application and requesting release…';
    try{const result=await call<string>('release_lock',{id,scanId,token:process.token,force});if(alive())status.textContent=result}
    catch(error){if(alive())status.textContent=String(error)}finally{if(alive()){report=null;list.replaceChildren();setBusy(false)}}
  }
  void load();return dialog;
}
