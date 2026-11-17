import {EditorState,Compartment} from '@codemirror/state';
import {EditorView,lineNumbers,Decoration} from '@codemirror/view';
import {textMatches,findSnippet,type FindTarget,type FindItem,type FindResult} from './find-text';
import {syntaxHighlighting,defaultHighlightStyle,HighlightStyle,LanguageDescription} from '@codemirror/language';
import {json} from '@codemirror/lang-json';
import {markdown} from '@codemirror/lang-markdown';
export function sourceView(parent:HTMLElement,text:string,name:string,kind:string,zoom:number,wrapped:boolean,signal:AbortSignal) {
  const wrapping=new Compartment(),language=new Compartment(),size=new Compartment(),findMarks=new Compartment();
  const theme=(value:number)=>EditorView.theme({'&':{height:'100%',fontSize:`${14*value}px`},'.cm-scroller':{fontFamily:'Cascadia Code, Consolas, monospace',overflow:'auto'},'.cm-content':{padding:'24px 0'},'.cm-gutters':{background:'transparent',border:'none',color:'var(--muted)'},'.cm-line':{padding:'0 24px'},'&.cm-focused':{outline:'none'}});
  const colors:Record<string,string>={'#404740':'var(--syntax-comment)','#708':'var(--syntax-purple)','#219':'var(--syntax-blue)','#164':'var(--syntax-string)','#a11':'var(--syntax-red)','#e40':'var(--syntax-number)','#00f':'var(--syntax-blue)','#30a':'var(--syntax-purple)','#085':'var(--syntax-string)','#167':'var(--syntax-cyan)','#256':'var(--syntax-cyan)','#00c':'var(--syntax-blue)','#940':'var(--syntax-comment)','#f00':'var(--syntax-red)'};
  const highlight=HighlightStyle.define(defaultHighlightStyle.specs.map(spec=>({...spec,...(spec.color?{color:colors[spec.color]??spec.color}:{})})));
  const view=new EditorView({parent,state:EditorState.create({doc:text,extensions:[lineNumbers(),EditorState.readOnly.of(true),EditorView.editable.of(false),EditorView.contentAttributes.of({tabindex:'0','aria-label':'Read-only source'}),syntaxHighlighting(highlight),language.of(text.length>524288?[]:kind==='json'?json():kind==='markdown'?markdown():[]),wrapping.of(wrapped?EditorView.lineWrapping:[]),size.of(theme(zoom)),findMarks.of([])]})});
  signal.addEventListener('abort',()=>view.destroy(),{once:true});
  if(kind==='text'&&text.length<=524288)void import('@codemirror/language-data').then(async({languages})=>{const description=LanguageDescription.matchFilename(languages,name);if(!description)return;const support=await description.load();if(!signal.aborted&&view.dom.isConnected)view.dispatch({effects:language.reconfigure(support)})}).catch(()=>{});
  let found:ReturnType<typeof textMatches>={matches:[],limited:false},key='',index=-1,items:FindItem[]=[],reportResult:((result:FindResult)=>void)|undefined;
  const emit=()=>{if(signal.aborted)return;const marks=found.matches.map((hit,i)=>Decoration.mark({class:i===index?'av-source-match active':'av-source-match'}).range(hit.from,hit.to));view.dispatch({effects:[findMarks.reconfigure(EditorView.decorations.of(Decoration.set(marks))),...(index>=0?[EditorView.scrollIntoView(found.matches[index].from,{y:'center'})]:[])]});reportResult?.({current:index+1,total:found.matches.length,limited:found.limited,items,itemsLabel:'Matches (up to 200)',snippet:index>=0?findSnippet(text,found.matches[index].from,found.matches[index].to):undefined})};
  const search:FindTarget={close:()=>{if(!signal.aborted)view.dispatch({effects:findMarks.reconfigure([])})},search(query,options,again,previous,report){reportResult=report;const next=JSON.stringify([query,options]);if(key!==next||!again){found=textMatches(text,query,options);key=next;index=-1;items=found.matches.slice(0,200).map((hit,i)=>({label:`Match ${i+1}`,detail:`Line ${view.state.doc.lineAt(hit.from).number}`,snippet:findSnippet(text,hit.from,hit.to),go:()=>{if(signal.aborted||key!==next)return;index=i;emit()}}))}if(found.matches.length)index=index<0?(previous?found.matches.length-1:0):(index+(previous?-1:1)+found.matches.length)%found.matches.length;
   emit();
  }};
  return {destroy:()=>view.destroy(),zoom:(value:number)=>view.dispatch({effects:size.reconfigure(theme(value))}),wrap:(enabled:boolean)=>view.dispatch({effects:wrapping.reconfigure(enabled?EditorView.lineWrapping:[])}),search};
}
