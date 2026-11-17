import { unpackZip, ENTRY_COUNT, ENTRY_LIMIT, safeEntry } from './archive';
import { readNpy, arrayPreview } from './scientific';

declare const self: { location:Location; onmessage:((event:MessageEvent<Job>)=>void)|null; postMessage:(value:unknown)=>void };
interface Job { operation:string; bytes:Uint8Array; name:string; selection?:string }
async function perform(job:Job):Promise<unknown> {
  const {operation,bytes}=job;
  if(operation==='unpack')return unpackZip(bytes);
  if(operation==='validate-package'){unpackZip(bytes);return true;}
  if(operation==='validate-word-package'){
    const entries=unpackZip(bytes);
    try{const {wordHeadings}=await import('./word-outline');return {headings:wordHeadings(entries)}}
    catch(error){return {headings:[],error:`Contents unavailable: ${String(error)}`}}
  }
  if(operation==='metafile'){
    const {expandMetafile,inspectMetafile}=await import('./metafile');const emf=/\.em[fz]$/i.test(job.name);
    const expanded=expandMetafile(bytes,/\.(wmz|emz)$/i.test(job.name)),bounds=inspectMetafile(expanded,emf);
    const {DOMImplementation,XMLSerializer}=await import('@xmldom/xmldom');
    const globals=globalThis as unknown as {window:unknown;document:unknown};globals.window=globalThis;globals.document=new DOMImplementation().createDocument('http://www.w3.org/2000/svg','svg',null);
    const {EMFJS,WMFJS}=await import('rtf.js');EMFJS.loggingEnabled(false);WMFJS.loggingEnabled(false);
    const width=1000,height=Math.max(1,Math.round(1000*bounds.height/bounds.width));
    if(height>8192)throw new Error('This metafile exceeds the output aspect-ratio limit.');
    const settings={width:width+'px',height:height+'px',xExt:bounds.width,yExt:bounds.height,wExt:bounds.width,hExt:bounds.height,mapMode:8};
    const renderer=emf?new EMFJS.Renderer(expanded.slice().buffer):new WMFJS.Renderer(expanded.slice().buffer);
    const svg=new XMLSerializer().serializeToString(renderer.render(settings) as unknown as import('@xmldom/xmldom').Node);
    if(svg.length>16*1024*1024)throw new Error('Metafile vector output exceeds 16 MiB.');return {svg};
  }
  if(operation==='access'){
    const [{default:browserProcess},{Buffer}]=await Promise.all([import('process'),import('buffer')]);
    const globals=globalThis as unknown as {process:unknown;Buffer:unknown};globals.process=browserProcess;globals.Buffer=Buffer;
    const {default:MDBReader}=await import('mdb-reader');
    const reader=new MDBReader(Buffer.from(bytes));const tables=reader.getTableNames({normalTables:true,systemTables:false,linkedTables:false});
    if(tables.length>100)throw new Error('This Access file exceeds the 100-table preview limit.');
    const name=job.selection??tables[0];if(!name)return {tables,columns:[],rows:[]};if(!tables.includes(name))throw new Error('Unknown Access table.');
    const table=reader.getTable(name),columns=table.getColumnNames();if(columns.length>256)throw new Error('This Access table exceeds the 256-column limit.');
    const rows=table.getData({rowLimit:1000}).map(row=>columns.map(column=>{
      const value=row[column];if(value==null)return '';if(value instanceof Uint8Array)return '['+value.length+' binary bytes]';if(value instanceof Date)return value.toISOString();if(Array.isArray(value))return '['+value.length+' attachments; inert]';return String(value).slice(0,4096);
    }));return {tables,name,columns,rows,truncated:table.rowCount>1000};
  }
  if(operation==='patch-xps'){
    const entries=unpackZip(bytes);if(!job.selection||job.selection.length>32*1024*1024)throw new Error('This XPS XML patch exceeds the preview budget.');
    const changes=JSON.parse(job.selection) as Record<string,string>;let expanded=0;
    for(const [name,text] of Object.entries(changes)){
      if(!Object.hasOwn(entries,name)||!/\.(fdseq|fdoc|fpage|dict)$/i.test(name)||typeof text!=='string')throw new Error('Invalid XPS resource patch.');
      const replacement=new TextEncoder().encode(text);if(replacement.length>ENTRY_LIMIT)throw new Error('An XPS XML member exceeds the preview budget.');entries[name]=replacement;
    }
    for(const data of Object.values(entries))expanded+=data.length;
    if(expanded>64*1024*1024)throw new Error('Expanded XPS exceeds the preview budget.');
    const {zipSync}=await import('fflate');return zipSync(entries);
  }
  if(operation==='dxf'){
    const {parseDxf}=await import('dxf-render/parser');const source=new TextDecoder().decode(bytes);
    if(source.length>16*1024*1024)throw new Error('DXF source is limited to 16 MiB.');return {data:parseDxf(source)};
  }
  if(operation==='npy')return {datasets:[readNpy(bytes)]};
  if(operation==='arrow'){
    const {tableFromIPC}=await import('apache-arrow');const data=tableFromIPC(bytes);
    if(data.numRows*data.numCols>250000||data.numRows>10000||data.numCols>256)throw new Error('This Arrow table exceeds the preview cell/row/column limit.');
    return {datasets:[{name:'Table',shape:[data.numRows,data.numCols],columns:data.schema.fields.map(field=>field.name),rows:Array.from(data).map(row=>data.schema.fields.map(field=>String(row[field.name]??'')))}]};
  }
  if(operation==='netcdf'){
    const {NetCDFReader}=await import('netcdfjs');const reader=new NetCDFReader(bytes);
    if(reader.variables.length>100)throw new Error('This netCDF file exceeds the 100-variable preview limit.');
    const name=job.selection??reader.variables[0]?.name;const variable=reader.variables.find(item=>item.name===name);
    if(!variable)throw new Error('This netCDF file has no variables.');
    const shape=variable.dimensions.map(index=>reader.dimensions[index].size||reader.recordDimension.length);
    if(shape.reduce((a,b)=>a*b,1)>250000)throw new Error('This variable exceeds the 250,000-value preview limit.');
    const data=reader.getDataVariable(variable).flat(Infinity);
    return {names:reader.variables.map(item=>item.name),datasets:[arrayPreview(name,shape.length?shape:[data.length],data)]};
  }
  if(operation==='hdf5'){
    const HDF=await import('h5wasm');const {FS}=await HDF.ready;FS.writeFile('/preview.h5',bytes);const file=new HDF.File('/preview.h5','r');
    try {
      const names:string[]=[];let scanned=0;
      const scan=(group:InstanceType<typeof HDF.Group>,prefix:string,depth:number)=>{
        if(depth>12)throw new Error('This HDF5 hierarchy exceeds the preview depth limit.');
        for(const key of group.keys()){
          if(++scanned>5000)throw new Error('This HDF5 hierarchy exceeds the 5,000-entry limit.');
          const name=prefix+'/'+key,item=group.get(key);
          if(item instanceof HDF.Dataset){names.push(name);if(names.length>100)throw new Error('This HDF5 file exceeds the 100-dataset preview limit.');}
          else if(item instanceof HDF.Group)scan(item,name,depth+1);
        }
      };scan(file,'',0);
      const name=job.selection??names[0];if(!name||!names.includes(name))throw new Error('No supported dataset was selected.');
      const item=file.get(name);if(!(item instanceof HDF.Dataset))throw new Error('This HDF5 entry is not a dataset.');
      const shape=item.shape??[1];if(shape.reduce((a,b)=>a*b,1)>250000)throw new Error('This dataset exceeds the 250,000-value preview limit.');
      const value=item.value;const data=Array.isArray(value)||ArrayBuffer.isView(value)?value as ArrayLike<unknown>:[value];
      return {names,datasets:[arrayPreview(name,shape,data)]};
    } finally {file.close();FS.unlink('/preview.h5');}
  }
  if(operation==='graphviz'){
    const {instance}=await import('@viz-js/viz');const viz=await instance();
    const source=new TextDecoder().decode(bytes);if(source.length>1024*1024)throw new Error('Graphviz source is limited to 1 MiB.');
    return {svg:viz.renderString(source,{format:'svg',engine:'dot'})};
  }
  if(operation==='ifc'){
    const {IfcAPI}=await import('web-ifc');const {default:wasm}=await import('web-ifc/web-ifc.wasm?url');const api=new IfcAPI();
    await api.Init(()=>new URL(wasm,self.location.href).href,true);const model=api.OpenModel(bytes,{COORDINATE_TO_ORIGIN:true});
    const meshes:{vertices:Float32Array;indices:Uint32Array;matrix:number[];color:number[]}[]=[];let vertices=0;
    try{
      api.StreamAllMeshes(model,mesh=>{for(let i=0;i<mesh.geometries.size();i++){
        const part=mesh.geometries.get(i);const geometry=api.GetGeometry(model,part.geometryExpressID);
        try{
          const data=api.GetVertexArray(geometry.GetVertexData(),geometry.GetVertexDataSize());vertices+=data.length/6;
          if(vertices>2000000||meshes.length>20000)throw new Error('This IFC model exceeds the geometry preview budget.');
          meshes.push({vertices:data.slice(),indices:api.GetIndexArray(geometry.GetIndexData(),geometry.GetIndexDataSize()).slice(),matrix:part.flatTransformation,color:[part.color.x,part.color.y,part.color.z,part.color.w]});
        }finally{geometry.delete();}
      }});return {meshes};
    }finally{api.CloseModel(model);api.Dispose();}
  }
  if(operation==='spreadsheet'){
    const XLSX=await import('xlsx');
    if(bytes[0]===0x50&&bytes[1]===0x4b)unpackZip(bytes);
    const book=XLSX.read(bytes,{type:'array',cellFormula:false,cellHTML:false,cellStyles:false,sheetRows:10001,dense:true,FS:job.name.endsWith('.psv')?'|':undefined});
    let cells=0;
    return book.SheetNames.slice(0,100).map(name=>{
      const sheet=book.Sheets[name];
      const rows=XLSX.utils.sheet_to_json<string[]>(sheet,{header:1,raw:false,defval:'',blankrows:true});
      const limited=rows.slice(0,10000).map(row=>{
        cells+=row.length;if(cells>250000)throw new Error('This workbook exceeds the 250,000-cell preview limit.');
        return row.slice(0,256).map(cell=>String(cell).slice(0,32768));
      });
      return {name,rows:limited,truncated:rows.length>10000||rows.some(row=>row.length>256)};
    });
  }
  if(operation==='image'){
    const {initializeImageMagick,ImageMagick,MagickFormat,ResourceLimits,MagickReadSettings}=await import('@imagemagick/magick-wasm');
    const {default:wasmUrl}=await import('@imagemagick/magick-wasm/magick.wasm?url');
    await initializeImageMagick(new URL(wasmUrl,self.location.href));
    ResourceLimits.memory=256n*1024n*1024n;ResourceLimits.disk=0n;ResourceLimits.width=40000n;ResourceLimits.height=40000n;
    ResourceLimits.area=40000000n;ResourceLimits.time=15n;ResourceLimits.listLength=128n;ResourceLimits.maxMemoryRequest=256n*1024n*1024n;
    const settings=new MagickReadSettings();settings.frameCount=1;
    return ImageMagick.read(bytes,settings,image=>{
      if(image.width*image.height>40000000)throw new Error('This image exceeds the 40-megapixel preview limit.');
      return image.write(MagickFormat.Png,data=>({bytes:data.slice(),width:image.width,height:image.height}));
    });
  }
  if(operation==='archive'){
    const {ArchiveReader,libarchiveWasm}=await import('libarchive-wasm');
    const {default:wasmUrl}=await import('libarchive-wasm/dist/libarchive.wasm?url');
    const module=await libarchiveWasm({locateFile:()=>new URL(wasmUrl,self.location.href).href});
    const reader=new ArchiveReader(module,new Int8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength));
    const entries: {name:string;size:number;type:string}[]=[];
    try {
      for(const entry of reader.entries()){
        if(entries.length>=ENTRY_COUNT)throw new Error('This archive exceeds the 5,000-entry preview limit.');
        const name=entry.getPathname(),size=entry.getSize();
        if(!safeEntry(name))throw new Error('This archive contains an unsafe entry name.');
        entries.push({name,size,type:entry.getFiletype()});
        if(name===job.selection){
          if(entry.getFiletype()!=='File'||size<0||size>ENTRY_LIMIT)throw new Error('This archive member cannot be previewed safely.');
          const data=reader.readData(ENTRY_LIMIT+1);
          if(data.length>ENTRY_LIMIT)throw new Error('This archive member exceeds the preview limit.');
          return {entries,member:new Uint8Array(data),name};
        }
      }
      if(job.selection)throw new Error('Archive member was not found.');
      return {entries};
    } finally {reader.free();}
  }
  if(operation==='sqlite'){
    const {default:initSqlJs}=await import('sql.js');
    const {default:wasmUrl}=await import('sql.js/dist/sql-wasm.wasm?url');
    const SQL=await initSqlJs({locateFile:()=>new URL(wasmUrl,self.location.href).href});
    const db=new SQL.Database(bytes);
    try {
      db.run('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const tables=(db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 101")[0]?.values??[]).map(row=>String(row[0]));
      if(tables.length>100)throw new Error('This database exceeds the 100-table preview limit.');
      const name=job.selection??tables[0];
      if(!name)return {tables,columns:[],rows:[]};
      if(!tables.includes(name))throw new Error('Unknown table.');
      const result=db.exec(`SELECT * FROM "${name.replaceAll('"','""')}" LIMIT 1001`)[0];
      return {tables,name,columns:result?.columns??[],rows:result?.values.slice(0,1000).map(row=>row.slice(0,256).map(cell=>cell instanceof Uint8Array?`[${cell.length} binary bytes]`:String(cell??'')))??[],truncated:(result?.values.length??0)>1000};
    } finally {db.close();}
  }
  throw new Error('Unknown preview operation.');
}
self.onmessage=async event=>{
  try{self.postMessage({ok:true,result:await perform(event.data)});}
  catch(error){const message=error&&typeof error==='object'&&'message' in error?String(error.message):String(error);self.postMessage({ok:false,error:message.slice(0,1000)});}
};
