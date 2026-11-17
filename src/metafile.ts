import {Gunzip} from 'fflate';
const LIMIT=16*1024*1024;
export function expandMetafile(bytes:Uint8Array,compressed:boolean):Uint8Array{
  if(!compressed){if(bytes.length>LIMIT)throw new Error('Metafile input exceeds 16 MiB.');return bytes;}
  const chunks:Uint8Array[]=[];let length=0;
  const unzip=new Gunzip(chunk=>{length+=chunk.length;if(length>LIMIT)throw new Error('Expanded metafile exceeds 16 MiB.');chunks.push(chunk);});
  for(let start=0;start<bytes.length;start+=4096)unzip.push(bytes.subarray(start,start+4096),start+4096>=bytes.length);
  const output=new Uint8Array(length);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.length;}return output;
}
export function inspectMetafile(bytes:Uint8Array,emf:boolean):{width:number;height:number}{
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=0,width=1000,height=1000;
  if(emf){
    if(bytes.length<88||view.getUint32(0,true)!==1||view.getUint32(40,true)!==0x464d4520)throw new Error('Invalid EMF header.');
    width=view.getInt32(16,true)-view.getInt32(8,true);height=view.getInt32(20,true)-view.getInt32(12,true);
  }else{
    if(bytes.length<18)throw new Error('Invalid WMF header.');
    if(view.getUint32(0,true)===0x9ac6cdd7){
      if(bytes.length<40)throw new Error('Truncated placeable WMF header.');
      width=view.getInt16(10,true)-view.getInt16(6,true);height=view.getInt16(12,true)-view.getInt16(8,true);offset=22;
    }
    if(view.getUint16(offset+2,true)!==9)throw new Error('Invalid WMF record header.');offset+=18;
  }
  let records=0;
  while(offset<bytes.length){
    const header=emf?8:6;if(offset+header>bytes.length)throw new Error('Truncated metafile record.');
    const length=emf?view.getUint32(offset+4,true):view.getUint32(offset,true)*2;
    if(length<header||!Number.isSafeInteger(length)||offset+length>bytes.length)throw new Error('Invalid metafile record size.');
    if(++records>20000)throw new Error('Metafile exceeds the 20,000-record preview limit.');
    if(!emf&&view.getUint16(offset+4,true)===0x020c&&length>=10){height=Math.abs(view.getInt16(offset+6,true));width=Math.abs(view.getInt16(offset+8,true));}
    offset+=length;
  }
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>1000000||height>1000000)throw new Error('Invalid metafile bounds.');
  return {width,height};
}
