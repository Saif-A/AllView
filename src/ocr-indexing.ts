export interface IndexingProgress {completed:number;total:number;value:number;checked:number;scanned:number;recognized:number;failed:number;state:'working'|'paused'|'ready'|'partial';stage:string;page?:number;pageProgress?:number;active?:number}
/** Fixed page budget: native pages finish both halves; scans reserve half for OCR.
 * Until discovery ends, use document size for OCR too so finding another scan cannot lower progress. */
export function searchProgress(progress:Pick<IndexingProgress,'total'|'checked'|'scanned'|'recognized'|'value'|'state'>,previous={percent:0,ocrPercent:0}){
 const total=Math.max(1,progress.total),checked=Math.min(total,Math.max(0,progress.checked)),scanned=Math.min(checked,Math.max(0,progress.scanned));
 const value=Math.min(scanned,Math.max(0,progress.value));
 const complete=progress.state==='ready'&&checked===total&&progress.recognized>=scanned;
 return {complete,percent:Math.min(complete?100:99,Math.max(previous.percent,Math.floor((2*checked-scanned+value)*100/(2*total)))),ocrPercent:Math.min(checked===total&&progress.recognized>=scanned?100:99,Math.max(previous.ocrPercent,Math.floor(value*100/Math.max(1,checked===total?scanned:total))))};
}
export function ocrWorkerLimit(cores:number,memoryGb?:number){return Number.isFinite(cores)&&cores>=8&&typeof memoryGb==='number'&&memoryGb>=8?2:1}
export function ocrRasterScale(width:number,height:number){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw Error('Invalid OCR page dimensions.');
 return Math.min(200/72,Math.sqrt(4_000_000/(width*height)),3200/Math.max(width,height));
}
/** One-byte lossless luminance PGM; avoid PNG compression and the upstream BMP object-copy path. */
export function grayscalePgm(rgba:Uint8ClampedArray,width:number,height:number){
 if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>8_010_000||rgba.length!==width*height*4)throw Error('Recognition image exceeds its pixel budget.');
 const header=new TextEncoder().encode(`P5\n${width} ${height}\n255\n`),bytes=new Uint8Array(header.length+width*height);bytes.set(header);
 for(let i=0,j=header.length;i<rgba.length;i+=4,j++){
  const gray=(77*rgba[i]+150*rgba[i+1]+29*rgba[i+2]+128)>>8,alpha=rgba[i+3];bytes[j]=alpha===255?gray:Math.round((gray*alpha+255*(255-alpha))/255);
 }return bytes;
}
export function ocrWordsFromTsv(tsv:string,width:number,height:number){
 if(typeof tsv!=='string'||tsv.length>4*1024*1024)throw Error('Recognized page exceeds its text budget.');
 const words:{text:string;from:number;to:number;x0:number;y0:number;x1:number;y1:number}[]=[];let text='',lineKey='',limited=false;
 for(const row of tsv.split('\n')){const fields=row.replace(/\r$/,'').split('\t');if(fields[0]!=='5'||fields.length<12)continue;
  const value=fields.slice(11).join('\t').trim();if(!value)continue;
  const [x,y,w,h]=fields.slice(6,10).map(Number);if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||w<=0||h<=0||x+w>width+1||y+h>height+1)continue;
  if(words.length>=20000||text.length+value.length+2>1024*1024){limited=true;break}
  const key=fields.slice(1,5).join(':');if(text)text+=key===lineKey?' ':'\n';lineKey=key;
  const from=text.length;text+=value;words.push({text:value,from,to:text.length,x0:x,y0:y,x1:x+w,y1:y+h});
 }return {text,words,limited};
}
export function indexingValue(total:number,recognized:number,working:boolean,pageProgress=0){
 const completed=Math.max(0,Math.min(total,recognized));
 const fractional=Math.max(0,Math.min(2,Number.isFinite(pageProgress)?pageProgress:0));
 const value=Math.min(total,completed+(completed<total?fractional:0));
 return {completed,value:working?Math.min(Math.max(0,total-.0001),value):value};
}
