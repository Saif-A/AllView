import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {button,formatBytes,select} from './ux';
interface FolderNode {token:number;parent:number|null;name:string;directory:boolean;bytes:number;files:number;folders:number;partial:boolean;issue:string|null}
interface Report {root:string;nodes:FolderNode[];elapsedMs:number;partial:boolean}
export async function folderView(stage:HTMLElement,id:number,signal:AbortSignal,notify:(text:string)=>void,open:(request:{id:number;path:string})=>void,toolbarHost?:HTMLElement,icon?:(name:string)=>string){
  stage.className='folder-stage';stage.replaceChildren();const toolbar=document.createElement('div');toolbar.className=toolbarHost?'format-tools toolbar-group':'preview-toolbar';toolbar.setAttribute('role','group');toolbar.setAttribute('aria-label','Folder controls');
  const mode=select({bytes:'Size',files:'File count',name:'Name'},'bytes');mode.setAttribute('aria-label','Sort folders by');const status=document.createElement('span');status.textContent='Scanning folder…';
  const cancel=button('Cancel',()=>{void invoke('cancel_directory');status.textContent='Stopping…'});const up=button('↑ Parent',()=>{void invoke<{id:number;path:string}>('open_containing_folder',{id}).then(open).catch(error=>notify(String(error)))});
  const refresh=button('Rescan',()=>{void load()});if(toolbarHost&&icon){for(const [node,symbol,label]of [[up,'up','Parent folder'],[refresh,'reset','Rescan folder'],[cancel,'close','Cancel folder scan']]as const){node.innerHTML=icon(symbol);node.setAttribute('aria-label',label);node.title=label}}status.className='format-status';toolbar.append(up,mode,refresh,cancel,status);const tree=document.createElement('div');tree.className='folder-tree';if(toolbarHost)toolbarHost.append(toolbar);else stage.append(toolbar);stage.append(tree);signal.addEventListener('abort',()=>toolbar.remove(),{once:true});
  const unlisten=await listen<{id:number;visited:number}>('folder-progress',event=>{if(event.payload.id===id&&!signal.aborted)status.textContent=`${event.payload.visited.toLocaleString()} entries…`});if(signal.aborted){unlisten();return}
  signal.addEventListener('abort',()=>{unlisten();void invoke('cancel_directory')},{once:true});let busy=false,report:Report|null=null;
  const openItem=(token:number)=>{void invoke<{id:number;path:string}>('open_tree_item',{id,token}).then(open).catch(error=>notify(String(error)))};
  const draw=()=>{
    if(!report)return;const table=document.createElement('div');table.className='folder-table';const header=document.createElement('div');header.className='folder-columns';
    for(const label of ['Name','Share','Size','Files','Folders','Status','Action']){const cell=document.createElement('span');cell.textContent=label;header.append(cell)}
    header.children[1].setAttribute('title',mode.value==='files'?'Share of total file count':'Share of total logical size');table.append(header);tree.replaceChildren(table);const children=new Map<number,FolderNode[]>();for(const node of report.nodes){if(node.parent!==null){const list=children.get(node.parent)??[];list.push(node);children.set(node.parent,list)}}
    const order=(a:FolderNode,b:FolderNode)=>mode.value==='name'?a.name.localeCompare(b.name,undefined,{numeric:true}):(mode.value==='files'?b.files-a.files:b.bytes-a.bytes)||a.name.localeCompare(b.name,undefined,{numeric:true});
    for(const list of children.values())list.sort(order);
    const row=(node:FolderNode,root=false,depth=0):HTMLElement=>{
      const wrap=document.createElement(node.directory?'details':'div');wrap.className='folder-node';const line=document.createElement(node.directory?'summary':'div');line.className='folder-line';line.dataset.token=String(node.token);line.style.setProperty('--folder-depth',String(depth));
      const name=document.createElement('span');name.className='folder-name';name.textContent=`${node.directory?'▸ ':''}${root?report!.root:node.name}`;name.title=root?report!.root:node.name;
      const total=mode.value==='files'?report!.nodes[0].files:report!.nodes[0].bytes;const share=total?(mode.value==='files'?node.files:node.bytes)/total*100:0;line.style.setProperty('--share',`${Math.max(0,Math.min(100,share))}%`);
      const stat=(key:string,label:string,value:string)=>{const cell=document.createElement('span');cell.className=`folder-stat folder-${key}`;cell.title=`${label}: ${value}`;const caption=document.createElement('span');caption.className='folder-stat-label';caption.textContent=`${label}: `;cell.append(caption,document.createTextNode(value));return cell};
      const shareCell=stat('share',mode.value==='files'?'Share of total file count':'Share of total logical size',`${share.toFixed(1)}%`);
      const statusCell=stat('status','Status',node.partial?'Partial':'—');if(node.issue)statusCell.title=node.issue;
      if(node.issue)line.title=node.issue;const openButton=button(node.directory?'Open':'Preview',()=>openItem(node.token));line.append(name,shareCell,stat('size','Size',formatBytes(node.bytes)),stat('files','Files',node.files.toLocaleString()),stat('folders','Folders',node.directory?node.folders.toLocaleString():'—'),statusCell,openButton);wrap.append(line);
      if(node.directory){const container=document.createElement('div');container.className='folder-children';wrap.append(container);let shown=0;const list=children.get(node.token)??[];
        const append=()=>{const until=Math.min(shown+150,list.length);for(;shown<until;shown++)container.append(row(list[shown],false,depth+1));if(shown<list.length){const more=button(`Show more (${list.length-shown})`,()=>{more.remove();append()});container.append(more)}};
        wrap.addEventListener('toggle',()=>{if((wrap as HTMLDetailsElement).open&&!shown)append()});if(root){(wrap as HTMLDetailsElement).open=true;append()}
      }return wrap;
    };if(report.nodes.length)table.append(row(report.nodes[0],true));
  };
  async function load(){if(busy||signal.aborted)return;busy=true;refresh.disabled=true;cancel.disabled=false;try{const next=await invoke<Report>('scan_directory',{id});if(signal.aborted)return;report=next;status.textContent=`${next.nodes.length.toLocaleString()} entries · ${(next.elapsedMs/1000).toFixed(2)} s${next.partial?' · partial totals':''}`;notify('Logical file sizes · Links skipped · Expand a folder or choose Preview');draw()}catch(error){if(!signal.aborted)status.textContent=String(error)}finally{busy=false;refresh.disabled=false;cancel.disabled=true}}
  mode.onchange=draw;await load();
}
