import {invoke} from '@tauri-apps/api/core';

/** Pass decoded pixels and a current request identity; filesystem paths stay native. */
export async function nativeImageEditor(image:HTMLImageElement,id:number,signal:AbortSignal){
  if(image.naturalWidth*image.naturalHeight>16_000_000)throw Error('Image editing is limited to 16 megapixels.');
  const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
  try{
    canvas.getContext('2d')!.drawImage(image,0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('Could not prepare image editing.')),'image/png'));
    if(signal.aborted)return;if(blob.size>64*1024*1024)throw Error('Image editing is limited to 64 MiB.');
    const bytes=new Uint8Array(await blob.arrayBuffer());if(signal.aborted)return;
    await invoke('edit_image_native',bytes,{headers:{'x-preview-id':String(id),'x-image-light':String(document.documentElement.dataset.theme==='light')}});
  }finally{canvas.width=canvas.height=1}
}
