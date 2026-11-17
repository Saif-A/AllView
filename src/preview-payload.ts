export interface PreviewInfo {name:string;path:string;kind:string;mime:string;bytes:number;width:number|null;height:number|null}
export function decodePreview(payload:ArrayBuffer|number[]):{info:PreviewInfo;bytes:Uint8Array<ArrayBuffer>;transport?:'media'|'pdf'}{
  const data=payload instanceof ArrayBuffer?new Uint8Array(payload):new Uint8Array(payload);
  if(data.length<4)throw new Error('The preview response is incomplete.');
  const length=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(0,true);
  if(length<2||length>256*1024||length>data.length-4)throw new Error('The preview descriptor is invalid.');
  const header=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(4,4+length)));
  const info=header?.info as PreviewInfo|undefined;
  const contentLength=data.length-4-length;
  const validTransport=header?.transport==='media'
    ? !!info&&['audio','video'].includes(info.kind)&&contentLength===0
    : header?.transport==='pdf'?info?.kind==='pdf'&&info.bytes>=5&&info.bytes<=2*1024**3&&contentLength===0
    : header?.transport===undefined&&info?.bytes===contentLength;
  if(header?.version!==1||!info||typeof info.kind!=='string'||typeof info.name!=='string'||typeof info.path!=='string'||typeof info.mime!=='string'||!Number.isSafeInteger(info.bytes)||info.bytes<0||!validTransport)throw new Error('The preview response does not match its descriptor.');
  return {info,bytes:data.subarray(4+length),transport:header.transport};
}
export const SOURCE_PLACEHOLDER_LIMIT=64*1024;
export const JSON_AUTO_TREE_LIMIT=256*1024;
export function sourcePlaceholder(text:string):string {
  return text.length>SOURCE_PLACEHOLDER_LIMIT?text.slice(0,SOURCE_PLACEHOLDER_LIMIT)+'\n\nLoading the full source view…':text;
}
