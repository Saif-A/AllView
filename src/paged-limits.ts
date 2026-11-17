// Validate document geometry before asking a decoder to allocate page pixels.
export const PAGE_PIXEL_LIMIT=24_000_000;
export function rasterScale(bounds:readonly number[],viewport:number,zoom:number,dpr:number):number {
  if(bounds.length!==4||bounds.some(value=>!Number.isFinite(value)))throw new Error('This page has invalid geometry.');
  const width=bounds[2]-bounds[0],height=bounds[3]-bounds[1];
  if(width<=0||height<=0||width>1e7||height>1e7)throw new Error('This page has unsupported dimensions.');
  if(![viewport,zoom,dpr].every(value=>Number.isFinite(value)&&value>0))throw new Error('Invalid page zoom or viewport.');
  // Leave room for raster rounding at each edge and constrain long thin pages too.
  const scale=Math.min(Math.min(viewport,4096)/width*Math.min(zoom,8)*Math.min(dpr,2),Math.sqrt(PAGE_PIXEL_LIMIT/(width+2)/(height+2))*.999,8190/width,8190/height,16);
  if(width*scale<1||height*scale<1)throw new Error('This page is too narrow to render within the pixel budget.');
  return scale;
}
