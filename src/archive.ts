import { Unzip, UnzipInflate } from 'fflate';

export const PACKAGE_LIMIT = 64 * 1024 * 1024;
export const ENTRY_LIMIT = 16 * 1024 * 1024;
export const ENTRY_COUNT = 5000;
export function safeEntry(name: string): boolean {
  return !!name && name.length <= 1024 && !name.includes('\0') && !/^[\\/]|^[A-Za-z]:/.test(name)
    && !name.replaceAll('\\','/').split('/').some(part=>part==='..');
}
// Streaming inflation caps actual output, including archives with forged size fields.
export function unpackZip(bytes: Uint8Array): Record<string,Uint8Array> {
  const entries: Record<string,Uint8Array> = Object.create(null);
  let total=0, count=0;
  const unzip=new Unzip(file=>{
    if(++count>ENTRY_COUNT)throw new Error('This archive exceeds the 5,000-entry limit.');
    if(!safeEntry(file.name))throw new Error('This archive contains an unsafe entry name.');
    if(file.name.endsWith('/'))return;
    if(Object.hasOwn(entries,file.name))throw new Error('This archive has duplicate entry names.');
    entries[file.name]=new Uint8Array();
    let length=0;const chunks:Uint8Array[]=[];
    file.ondata=(error,data,final)=>{
      if(error)throw error;
      length+=data.length;total+=data.length;
      if(length>ENTRY_LIMIT||total>PACKAGE_LIMIT){file.terminate();throw new Error('Expanded archive exceeds the safe preview limit.');}
      chunks.push(data);
      if(final){const result=new Uint8Array(length);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}entries[file.name]=result;}
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for(let offset=0;offset<bytes.length;offset+=4096)unzip.push(bytes.subarray(offset,offset+4096),offset+4096>=bytes.length);
  if(!count)throw new Error('This package is empty or is not a supported ZIP file.');
  return entries;
}
