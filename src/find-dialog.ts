import type {FindTarget,FindResult,FindItem,FindSnippet} from './find-text';
import {textMatches,findSnippet} from './find-text';
import {searchProgress} from './ocr-indexing';
import type {DocumentSidebar} from './document-sidebar';
import './document-navigation.css';
import './pdf-reader.css';
let presentation:'compact'|'sidebar'='compact';
export function findDialog(target:FindTarget,signal:AbortSignal,icon:(name:string)=>string,sidebar:DocumentSidebar){
 const dialog=document.createElement('dialog');dialog.className='find-dialog';dialog.setAttribute('aria-label','Find in document');
 const panel=document.createElement('section');panel.className='find-panel';panel.setAttribute('aria-label','Find in document');
 const heading=document.createElement('header');heading.className='find-heading';const title=document.createElement('strong');title.textContent='Find';heading.append(title);
 const input=document.createElement('input');input.type='search';input.maxLength=256;input.placeholder='Find in document';input.setAttribute('aria-label','Find text');
 const query=document.createElement('div');query.className='find-query';query.innerHTML=icon('search');query.append(input);
 const currentMatch=document.createElement('div');currentMatch.className='find-current-match';currentMatch.dir='auto';currentMatch.hidden=true;currentMatch.setAttribute('aria-label','Current match text');
 const renderSnippet=(node:HTMLElement,snippet:FindSnippet)=>{const match=document.createElement('mark');match.dir='auto';match.textContent=snippet.match;node.replaceChildren(document.createTextNode(snippet.before),match,document.createTextNode(snippet.after))};
 let lastSnippet:FindSnippet|undefined;
 let progressFloor={percent:0,ocrPercent:0};
 const status=document.createElement('output');status.setAttribute('aria-live','polite');status.textContent='Enter text to search this document.';
 const actions=document.createElement('div');actions.className='find-actions';const results=document.createElement('div');results.className='find-results';results.setAttribute('aria-label','Search results');
 let opened=false,moving=false,version=0,timer:ReturnType<typeof setTimeout>|undefined,lastItems:FindItem[]|undefined;
 const command=(name:string,label:string,action:()=>void)=>{const button=document.createElement('button');button.type='button';button.className='find-command';button.innerHTML=icon(name);button.title=label;button.setAttribute('aria-label',label);button.onclick=action;return button};
 const previous=command('previous','Previous match · Shift+Enter',()=>run(true,true)),next=command('next','Next match · Enter',()=>run(true,false));previous.disabled=next.disabled=true;
 const mode=command('rail','Move Find to sidebar',()=>switchMode(presentation==='compact'?'sidebar':'compact'));
 const close=()=>{if(!opened)return;opened=false;version++;clearTimeout(timer);panel.dataset.toolOpen='false';if(dialog.open)dialog.close();if(presentation==='sidebar')sidebar.hide();target.close?.()};
 const cancelWork=command('close','Pause search',()=>stopWork?.());let stopWork:(()=>void)|undefined,resumeWork:(()=>void)|undefined;cancelWork.hidden=true;
 const resume=document.createElement('button');resume.type='button';resume.className='find-resume';resume.textContent='Resume search';resume.hidden=true;resume.onclick=()=>resumeWork?.();
 heading.append(mode,command('close','Close Find · Escape',close));actions.append(status,previous,next,cancelWork);
 const options=document.createElement('div');options.className='find-options';
 const check=(label:string)=>{const wrap=document.createElement('label'),node=document.createElement('input');node.type='checkbox';wrap.append(node,document.createTextNode(label));options.append(wrap);node.onchange=()=>run();return node};
 const sensitive=check('Match case'),whole=check('Whole words');
 const indexing=document.createElement('section');indexing.className='find-indexing';indexing.hidden=true;indexing.setAttribute('aria-label','Search progress');
 const indexHeading=document.createElement('div'),indexTitle=document.createElement('strong'),indexPercent=document.createElement('span');indexTitle.setAttribute('aria-live','polite');indexHeading.append(indexTitle,indexPercent);
 const indexBar=document.createElement('progress');indexBar.setAttribute('aria-label','Searching progress');indexBar.max=100;
 indexing.append(indexHeading,indexBar,resume);
 panel.append(heading,query,currentMatch,actions,options,indexing,results);
 const position=()=>{const chrome=document.getElementById('window-chrome'),toolbar=document.getElementById('preview-toolbar');const bottom=Math.max(chrome?.getBoundingClientRect().bottom??32,toolbar&&getComputedStyle(toolbar).visibility==='visible'?toolbar.getBoundingClientRect().bottom:0);dialog.style.top=`${Math.min(innerHeight-100,bottom+8)}px`};
 const resize=new ResizeObserver(position);const chrome=document.getElementById('window-chrome'),toolbar=document.getElementById('preview-toolbar');if(chrome)resize.observe(chrome);if(toolbar)resize.observe(toolbar);window.addEventListener('resize',position,{signal});
 chrome?.addEventListener('pointerenter',position,{signal});toolbar?.addEventListener('focusin',position,{signal});
 const updateMode=()=>{const label=presentation==='compact'?'Move Find to sidebar':'Show compact Find';mode.innerHTML=icon(presentation==='compact'?'rail':'float');mode.title=label;mode.setAttribute('aria-label',label)};
 function mount(){updateMode();if(presentation==='sidebar'){if(dialog.open){moving=true;dialog.close();moving=false}sidebar.searchHost.append(panel);sidebar.open('search')}else{if(sidebar.searchHost.contains(panel))sidebar.hide();dialog.append(panel);if(!dialog.isConnected)document.body.append(dialog);position();if(!dialog.open)dialog.show()}panel.dataset.toolOpen='true'}
 function switchMode(nextMode:'compact'|'sidebar'){if(signal.aborted)return;presentation=nextMode;mount();input.focus()}
 function report(result:FindResult){
  if(signal.aborted||!opened)return;const statusText=!input.value?'Enter text to search this document.':`${result.current} of ${result.total}${result.limited?'+':''} matches${result.message?' · '+result.message:''}`;if(status.textContent!==statusText)status.textContent=statusText;
  currentMatch.hidden=!result.snippet;if(result.snippet&&(!lastSnippet||lastSnippet.before!==result.snippet.before||lastSnippet.match!==result.snippet.match||lastSnippet.after!==result.snippet.after))renderSnippet(currentMatch,result.snippet);lastSnippet=result.snippet;
  const progress=result.indexing;indexing.hidden=!progress;if(progress){const value=searchProgress(progress,progressFloor);progressFloor=value;indexing.dataset.state=progress.state;indexing.hidden=value.complete;const title=progress.state==='paused'?'Searching paused':progress.state==='partial'?'Searching incomplete':progress.active?'Searching by OCR':'Searching';if(indexTitle.textContent!==title)indexTitle.textContent=title;indexPercent.textContent=`${value.percent}%`;indexBar.value=value.percent;indexBar.setAttribute('aria-valuetext',`${title} ${value.percent}%`)}
  stopWork=result.cancel;resumeWork=result.resume;cancelWork.hidden=!stopWork;resume.hidden=!resumeWork;
  previous.disabled=next.disabled=!result.total;
  if(lastItems===result.items)return;lastItems=result.items;results.replaceChildren();
  if(result.items?.length){const caption=document.createElement('p');caption.textContent=result.itemsLabel??'Matches';results.append(caption);for(const item of result.items.slice(0,200)){const button=document.createElement('button');button.type='button';if(item.snippet){const excerpt=document.createElement('span');excerpt.dir='auto';excerpt.className='find-match-text';renderSnippet(excerpt,item.snippet);button.append(excerpt);const location=document.createElement('small');location.textContent=item.label+(item.detail?` · ${item.detail}`:'');button.append(location)}else{button.textContent=item.label;if(item.detail){const detail=document.createElement('small');detail.textContent=item.detail;button.append(detail)}}button.onclick=item.go;results.append(button)}}
 }
 function run(again=false,backwards=false){clearTimeout(timer);const token=++version;target.search(input.value,{caseSensitive:sensitive.checked,wholeWord:whole.checked},again,backwards,result=>{if(token===version)report(result)})}
 input.oninput=()=>{clearTimeout(timer);version++;lastItems=undefined;lastSnippet=undefined;currentMatch.hidden=true;indexing.hidden=true;cancelWork.hidden=resume.hidden=true;results.replaceChildren();previous.disabled=next.disabled=true;status.textContent=input.value?'Searching…':'Enter text to search this document.';timer=setTimeout(run,180)};
 panel.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target===input){event.preventDefault();run(true,event.shiftKey)}});
 dialog.addEventListener('close',()=>{if(!dialog.open&&!moving&&opened&&presentation==='compact')close()});
 sidebar.bindSearch(visible=>{if(presentation==='sidebar')panel.dataset.toolOpen=String(opened&&visible)},close);
 signal.addEventListener('abort',()=>{close();resize.disconnect();dialog.remove();panel.remove()},{once:true});
 return {open(dock=false){if(signal.aborted)return;const wasOpen=opened;opened=true;if(dock)presentation='sidebar';mount();input.focus();input.select();if(!wasOpen&&input.value)run()},refresh(){if(opened&&input.value)run()},next(backwards=false){if(!opened){this.open();return}if(presentation==='sidebar')sidebar.open('search');run(true,backwards)},dismiss(){if(!opened||presentation==='sidebar'&&!sidebar.searchVisible())return false;close();return true}};
}
/** Search rendered document text without injecting markup into the preview. */
export function domFindTarget(stage:HTMLElement|ShadowRoot):FindTarget{
 let text='',matches:{from:number;to:number}[]=[],ranges:Range[]=[],key='',index=-1,limited=false,items:FindItem[]=[],reportResult:((result:FindResult)=>void)|undefined,highlighted=false;
 const owner=stage.ownerDocument,registry=owner.defaultView?.CSS.highlights,MakeHighlight=owner.defaultView?.Highlight;
 const clear=()=>{registry?.delete('av-find');registry?.delete('av-find-active');highlighted=false};
 const emit=()=>{if(registry&&MakeHighlight){if(!highlighted){registry.set('av-find',new MakeHighlight(...ranges));highlighted=true}if(index>=0)registry.set('av-find-active',new MakeHighlight(ranges[index]))}if(index>=0)ranges[index].startContainer.parentElement?.scrollIntoView({block:'center'});reportResult?.({current:index+1,total:ranges.length,limited,items,itemsLabel:'Matches (up to 200)',snippet:index>=0?findSnippet(text,matches[index].from,matches[index].to):undefined})};
 return {close:clear,search(query,options,again,previous,report){
  reportResult=report;if(!query){index=-1;ranges=[];matches=[];items=[];clear();report({current:0,total:0,items});return}
  const nextKey=JSON.stringify([query,options]);if(key!==nextKey||!again||ranges.length&&!ranges[0].startContainer.isConnected){key=nextKey;index=-1;ranges=[];items=[];clear();
   const walker=owner.createTreeWalker(stage,NodeFilter.SHOW_TEXT,{acceptNode:node=>node.parentElement?.closest('button,input,select,script,style,.media-player')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
   const nodes:{node:Text;start:number;end:number}[]=[];text='';let node:Node|null,previousBlock:Element|null=null;
   while((node=walker.nextNode())&&nodes.length<20000&&text.length<8*1024*1024){const block=node.parentElement?.closest('p,h1,h2,h3,h4,h5,h6,li,td,th,div,section,article,[role=heading]')??null;if(text&&block!==previousBlock&&!text.endsWith('\n'))text+='\n';previousBlock=block;const start=text.length;text+=(node.textContent??'').slice(0,8*1024*1024-start);nodes.push({node:node as Text,start,end:text.length})}
   const found=textMatches(text,query,options);matches=found.matches;limited=found.limited;let cursor=0;
   for(const hit of found.matches){while(cursor<nodes.length&&nodes[cursor].end<=hit.from)cursor++;const first=nodes[cursor];if(!first)break;let end=cursor;while(end<nodes.length-1&&nodes[end].end<hit.to)end++;const last=nodes[end];const range=owner.createRange();range.setStart(first.node,hit.from-first.start);range.setEnd(last.node,hit.to-last.start);ranges.push(range)}
   items=found.matches.slice(0,Math.min(200,ranges.length)).map((hit,i)=>({label:`Match ${i+1}`,snippet:findSnippet(text,hit.from,hit.to),go:()=>{if(key!==nextKey||i>=ranges.length)return;index=i;emit()}}));
  }
  if(ranges.length)index=index<0?(previous?ranges.length-1:0):(index+(previous?-1:1)+ranges.length)%ranges.length;
  emit();
 }};
}
