/** One resident toolbar: transient reveal, one pin toggle and arrow-key focus. */
export function setupToolbar(){
  const app=document.getElementById('app')!,chrome=document.getElementById('window-chrome')!;
  const toolbar=document.getElementById('preview-toolbar')!,reveal=document.getElementById('toolbar-reveal') as HTMLButtonElement;
  let pinned=false,last:HTMLElement|null=null;
  const controls=()=>[...toolbar.querySelectorAll<HTMLElement>('button,input,select')].filter(node=>!node.hasAttribute('disabled')&&!node.hidden&&getComputedStyle(node).display!=='none'&&!node.closest('[hidden]'));
  const refresh=()=>{const nodes=controls();const active=nodes.includes(last!)?last:nodes[0];for(const node of toolbar.querySelectorAll<HTMLElement>('button,input,select'))node.tabIndex=node===active?0:-1;};
  const hide=()=>{app.classList.remove('toolbar-open');reveal.setAttribute('aria-expanded','false');};
  reveal.addEventListener('focus',()=>{if(reveal.matches(':focus-visible')){app.classList.add('toolbar-open');reveal.setAttribute('aria-expanded','true');controls()[0]?.focus();}});
  reveal.addEventListener('click',()=>{app.classList.add('toolbar-open');reveal.setAttribute('aria-expanded','true');controls()[0]?.focus();});
  toolbar.addEventListener('focusin',event=>{if(event.target instanceof HTMLElement&&event.target.matches('button,input,select')){last=event.target;refresh();}});
  toolbar.addEventListener('keydown',event=>{
    if(!(event.target instanceof HTMLButtonElement)||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const nodes=controls(),index=nodes.indexOf(event.target);if(index<0)return;event.preventDefault();event.stopPropagation();
    const next=event.key==='Home'?0:event.key==='End'?nodes.length-1:(index+(event.key==='ArrowRight'?1:-1)+nodes.length)%nodes.length;nodes[next]?.focus();
  });
  document.addEventListener('pointerdown',event=>{if(event.target instanceof Node&&!chrome.contains(event.target))hide();});
  new MutationObserver(refresh).observe(toolbar,{subtree:true,attributes:true,attributeFilter:['hidden','disabled'],childList:true});refresh();
  return {setPinned(value:boolean){pinned=value;app.classList.toggle('toolbar-pinned',value);hide();refresh();},dismiss(){
    if(!pinned&&app.classList.contains('toolbar-open')){hide();document.getElementById('stage')?.focus({preventScroll:true});return true}return false;
  }};
}
