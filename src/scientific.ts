export interface DatasetPreview {name:string;shape:number[];columns:string[];rows:string[][]}
export function arrayPreview(name:string,shape:number[],values:ArrayLike<unknown>,fortran=false):DatasetPreview {
  const count=shape.reduce((a,b)=>a*b,1);
  if(!Number.isSafeInteger(count)||count>250000||shape.some(n=>!Number.isInteger(n)||n<0))throw new Error('This dataset exceeds the 250,000-value preview limit.');
  const columns=shape.length>1?shape.at(-1)!:1,rows=columns?count/columns:0;
  if(columns>256||rows>10000)throw new Error('This dataset exceeds the 256-column / 10,000-row preview limit.');
  const data:string[][]=[];
  for(let row=0;row<rows;row++){
    const result:string[]=[];
    for(let column=0;column<columns;column++){
      let position=row*columns+column;
      if(fortran&&shape.length>1){let index=position;const coordinates=shape.map(()=>0);for(let d=shape.length-1;d>=0;d--){coordinates[d]=index%shape[d];index=Math.floor(index/shape[d]);}position=0;let stride=1;for(let d=0;d<shape.length;d++){position+=coordinates[d]*stride;stride*=shape[d];}}
      const value=values[position];result.push(typeof value==='object'?JSON.stringify(value)?.slice(0,32768)??'':String(value??'').slice(0,32768));
    }
    data.push(result);
  }
  return {name,shape,columns:Array.from({length:columns},(_,i)=>String(i)),rows:data};
}
export function readNpy(bytes:Uint8Array):DatasetPreview {
  if(bytes.length<12||new TextDecoder().decode(bytes.subarray(1,6))!=='NUMPY'||bytes[0]!==0x93)throw new Error('This is not a NumPy file.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const version=bytes[6];
  const headerBytes=version===1?view.getUint16(8,true):view.getUint32(8,true);const offset=(version===1?10:12)+headerBytes;
  if(headerBytes>65536||offset>bytes.length)throw new Error('Invalid NumPy header.');
  const header=new TextDecoder().decode(bytes.subarray(version===1?10:12,offset));
  const dtype=/['"]descr['"]\s*:\s*['"]([<>=|])([?biufcSU])(\d*)['"]/.exec(header);
  const dimensions=/['"]shape['"]\s*:\s*\(([\d,\s]*)\)/.exec(header);
  if(!dtype||!dimensions)throw new Error('This NumPy data type needs a visual decoder. Object/pickle arrays are never executed.');
  const shape=dimensions[1].split(',').map(s=>s.trim()).filter(Boolean).map(Number);if(!shape.length)shape.push(1);
  const count=shape.reduce((a,b)=>a*b,1);if(!Number.isSafeInteger(count)||count>250000)throw new Error('This array exceeds the 250,000-value preview limit.');
  const type=dtype[2],size=Number(dtype[3]||1),width=type==='U'?size*4:size,little=dtype[1]!== '>';
  if(!width||width>4096||offset+count*width>bytes.length)throw new Error('This NumPy array is truncated or has an invalid element width.');
  const values:unknown[]=[];
  for(let i=0;i<count;i++){
    const index=offset+i*width;let value:unknown;
    if(type==='f')value=size===4?view.getFloat32(index,little):size===8?view.getFloat64(index,little):undefined;
    else if(type==='i')value=size===1?view.getInt8(index):size===2?view.getInt16(index,little):size===4?view.getInt32(index,little):size===8?view.getBigInt64(index,little).toString():undefined;
    else if(type==='u')value=size===1?view.getUint8(index):size===2?view.getUint16(index,little):size===4?view.getUint32(index,little):size===8?view.getBigUint64(index,little).toString():undefined;
    else if(type==='?'||type==='b')value=Boolean(view.getUint8(index));
    else if(type==='S')value=new TextDecoder().decode(bytes.subarray(index,index+width)).replace(/\0+$/,'');
    else if(type==='U'){let text='';for(let p=0;p<width;p+=4){const code=view.getUint32(index+p,little);if(code)text+=String.fromCodePoint(code<=0x10ffff?code:0xfffd);}value=text;}
    else if(type==='c'&&(size===8||size===16)){const get=size===8?view.getFloat32.bind(view):view.getFloat64.bind(view);value=`${get(index,little)} + ${get(index+size/2,little)}i`;}
    if(value===undefined)throw new Error('This NumPy numeric type needs an additional visual decoder.');values.push(value);
  }
  return arrayPreview('Array',shape,values,/['"]fortran_order['"]\s*:\s*True/.test(header));
}
