export function runFormatWorker<T>(operation:string,bytes:Uint8Array,name:string,signal:AbortSignal,selection?:string):Promise<T> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(new DOMException('Preview cancelled','AbortError'));return;}
    const worker=new Worker(new URL('./format.worker.ts',import.meta.url),{type:'module'});
    const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);worker.terminate();};
    const cancel=()=>{finish();reject(new DOMException('Preview cancelled','AbortError'));};
    const timer=setTimeout(()=>{finish();reject(new Error('This preview exceeded the 20-second processing limit.'));},20000);
    signal.addEventListener('abort',cancel,{once:true});
    worker.onmessage=event=>{finish();if(event.data.ok)resolve(event.data.result);else reject(new Error(event.data.error));};
    worker.onerror=()=>{finish();reject(new Error('The preview decoder failed. This file may be damaged or unsupported.'));};
    const copy=bytes.slice();worker.postMessage({operation,bytes:copy,name,selection},[copy.buffer]);
  });
}
