/** Image placement in PDF user coordinates; bounded work, without fetching image pixels. */
type Matrix=[number,number,number,number,number,number];
const multiply=(a:Matrix,b:Matrix):Matrix=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
export function pdfImageCoverage(fnArray:ArrayLike<number>,argsArray:unknown[],view:readonly number[],ops:Record<string,number>){
 const area=Math.max(1,(view[2]-view[0])*(view[3]-view[1]));let matrix:Matrix=[1,0,0,1,0,0],coverage=0,images=false,checks=0,covered=0;const stack:Matrix[]=[],tiles=new Uint8Array(32*32);
 const image=(m:Matrix)=>{if(!m.every(Number.isFinite))return;checks++;images=true;const xs=[m[4],m[0]+m[4],m[2]+m[4],m[0]+m[2]+m[4]],ys=[m[5],m[1]+m[5],m[3]+m[5],m[1]+m[3]+m[5]];
  const left=Math.max(view[0],Math.min(...xs)),right=Math.min(view[2],Math.max(...xs)),bottom=Math.max(view[1],Math.min(...ys)),top=Math.min(view[3],Math.max(...ys));
  const width=Math.max(0,right-left),height=Math.max(0,top-bottom);coverage=Math.max(coverage,Math.min(1,width*height/area));
  // Conservative union for axis-aligned tiled scans; overlap never counts twice.
  if((m[1]===0&&m[2]===0)||(m[0]===0&&m[3]===0)){
   const dx=(view[2]-view[0])/32,dy=(view[3]-view[1])/32;if(dx<=0||dy<=0)return;
   for(let y=Math.max(0,Math.ceil((bottom-view[1])/dy));y<Math.min(32,Math.floor((top-view[1])/dy));y++)for(let x=Math.max(0,Math.ceil((left-view[0])/dx));x<Math.min(32,Math.floor((right-view[0])/dx));x++){const cell=y*32+x;if(!tiles[cell]){tiles[cell]=1;covered++}}
   coverage=Math.max(coverage,covered/1024);
  }};
 for(let i=0;i<Math.min(fnArray.length,100000);i++){const op=fnArray[i],args=argsArray[i] as any[];
  if(op===ops.save){if(stack.length>=64)return {images,coverage};stack.push(matrix)}
  else if(op===ops.paintFormXObjectBegin){if(stack.length>=64)return {images,coverage};stack.push(matrix);if(args?.[0]?.length===6&&args[0].every(Number.isFinite))matrix=multiply(matrix,args[0])}
  else if(op===ops.restore||op===ops.paintFormXObjectEnd)matrix=stack.pop()??[1,0,0,1,0,0];
  else if(op===ops.transform&&args?.length===6&&args.every(Number.isFinite))matrix=multiply(matrix,args as Matrix);
  else if(op===ops.paintImageXObject||op===ops.paintInlineImageXObject||op===ops.paintImageMaskXObject||op===ops.paintSolidColorImageMask)image(matrix);
  else if(op===ops.paintImageXObjectRepeat||op===ops.paintImageMaskXObjectRepeat){const mask=op===ops.paintImageMaskXObjectRepeat,positions=args?.[mask?5:3];if(positions?.length)for(let j=0;j<Math.min(positions.length,4096)&&checks<4096;j+=2)image(multiply(matrix,[args[1],mask?args[3]:0,mask?args[2]:0,args[mask?4:2],positions[j],positions[j+1]]))}
  else if(op===ops.paintInlineImageXObjectGroup||op===ops.paintImageMaskXObjectGroup){const group=op===ops.paintInlineImageXObjectGroup?args?.[1]:args?.[0];if(Array.isArray(group))for(const entry of group.slice(0,Math.min(2048,4096-checks)))if(entry.transform?.length===6)image(multiply(matrix,entry.transform))}
  if(coverage>=.6||checks>=4096)break;
 }return {images,coverage};
}
