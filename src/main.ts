import './style.css';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {FindTarget} from './find-text';
import type {PdfControls} from './pdf-preview';
import type { Heading } from './markdown';
import type { PreviewControls } from './extended-preview';
import {zoomStep,clampZoom,typing,frame} from './ux';
import {decodePreview,sourcePlaceholder,JSON_AUTO_TREE_LIMIT} from './preview-payload';
import {wheelZoom,siblingDirection,createZoomGesture,type ZoomAnchor} from './viewer-interaction';
import {initializeTheme} from './theme';
import {setupToolbar} from './toolbar';
import {documentSidebar} from './document-sidebar';
import type {ContentsProvider} from './document-outline';
import {documentPreview,imagePreview} from './preview-policy';

const theme = initializeTheme();

let pdfjs:typeof import('pdfjs-dist');
async function loadPdf(){if(!pdfjs){const [library,worker]=await Promise.all([import('pdfjs-dist'),import('pdfjs-dist/build/pdf.worker.min.mjs?url'),import('pdfjs-dist/web/pdf_viewer.css')]);pdfjs=library;pdfjs.GlobalWorkerOptions.workerSrc=worker.default}return pdfjs}
interface Request { id: number; path: string; editImage?: boolean }
interface Info { name: string; path: string; kind: string; mime: string; bytes: number; width: number|null; height: number|null }
interface Settings { enabled: boolean; available: boolean; autostart: boolean; startupPrompt: boolean; pinned: boolean; headerPinned: boolean }
interface Navigation { position: number; total: number; previous: string|null; next: string|null }
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const icons: Record<string, string> = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  apps: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 17h7m-3-3 3 3-3 3"/>',
  open: '<path d="M3 7h6l2 2h10l-2 11H3z"/><path d="M3 7V4h6l2 3"/>',
  settings: '<path d="m10 3-.8 2.4-2 .8L5 5l-2 3 1.8 1.8-.2 2.2L3 14l2 3 2.4-.6 1.8 1.2L10 20h4l.8-2.4 1.8-1.2 2.4.6 2-3-1.6-2 .2-2.2L21 8l-2-3-2.2 1.2-2-.8L14 3z"/><circle cx="12" cy="11.5" r="3"/>',
  rail: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  float: '<path d="M19 7V4H3v13h5"/><rect x="9" y="9" width="12" height="11" rx="1"/><path d="M9 12h12"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  full: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  rotate: '<path d="M4 10a8 8 0 1 1 2 8M4 10V4m0 6h6"/>',
  'toolbar-pin': '<path d="m9 3 6 0-1 6 3 3v2H7v-2l3-3zM12 14v7"/>',
  collapse: '<path d="m6 15 6-6 6 6"/>',
  expand: '<path d="m6 9 6 6 6-6"/>',
  'window-pin': '<path d="M12 5H4a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5M3 10h8M16 3h4l-1 4 2 2v1h-6V9l2-2zM18 10v5"/>',
  previous: '<path d="m14 6-6 6 6 6"/>',
  next: '<path d="m10 6 6 6-6 6"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<rect x="5" y="5" width="14" height="14"/>',
  folder: '<path d="M3 7V5h6l2 2h10v13H3z"/>',
  locks: '<rect x="5" y="10" width="14" height="11" rx="1"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="m6 10 6-6 6 6M12 4v16"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',pause:'<path d="M8 4v16M16 4v16"/>',
  sound:'<path d="M3 9h4l5-5v16l-5-5H3zM16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',muted:'<path d="M3 9h4l5-5v16l-5-5H3zM16 9l6 6m0-6-6 6"/>',
  reset: '<path d="M4 9a8 8 0 1 1 1 9M4 9V3m0 6h6"/>',
  edit: '<path d="m4 16-1 5 5-1L20 8l-4-4zM13 7l4 4M4 16l4 4"/>',
  print: '<path d="M6 8V3h12v5M6 17H3V8h18v9h-3M6 14h12v7H6zM17 11h1"/>',
  tree: '<rect x="3" y="3" width="6" height="5"/><path d="M6 8v11h7M6 13h7"/><rect x="13" y="10" width="8" height="5"/><rect x="13" y="17" width="8" height="4"/>',
  source: '<path d="m8 6-5 6 5 6m8-12 5 6-5 6M14 4l-4 16"/>',
  document: '<path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h8"/>',
  wrap: '<path d="M3 5h18M3 10h14a4 4 0 0 1 0 8h-5m3-3-3 3 3 3M3 15h4M3 20h4"/>',
  'font-serif': '<path d="m6 20 6-16 6 16M8 14h8M3 20h6m6 0h6M9 4h6"/>',
  'font-sans': '<path d="m5 20 7-16 7 16M8 14h8"/>',
  column: '<path d="M7 3v18M17 3v18M10 6h4m-4 4h4m-4 4h4m-4 4h4"/>',
  wide: '<path d="M3 5h18M3 10h18M3 15h18M3 20h18"/>',
  fit: '<rect x="3" y="4" width="18" height="16"/><path d="m6 16 4-4 3 3 3-4 3 5M7 8h1"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  first:'<path d="M5 4v16m13-14-7 6 7 6"/>',last:'<path d="M19 4v16M6 6l7 6-7 6"/>',
  'fit-page':'<rect x="5" y="2" width="14" height="20"/><path d="M8 9V6h3m5 9v3h-3"/>',
  'fit-width':'<rect x="3" y="4" width="18" height="16"/><path d="M6 12h12m-9-3-3 3 3 3m6-6 3 3-3 3"/>',
  actual:'<path d="M5 8h2v9m7-9h2v9M10 10h1m-1 5h1"/>',
  'rotate-left':'<path d="M20 10a8 8 0 1 0-2 8m2-8V4m0 6h-6"/>',
  hand:'<path d="M7 12V7a2 2 0 0 1 4 0v4-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v7-2a2 2 0 0 1 4 0v5c0 5-3 7-7 7h-2c-2 0-4-1-5-3l-4-5a2 2 0 0 1 3-2l3 3"/>',
  pages:'<rect x="7" y="3" width="13" height="16"/><path d="M4 6v16h13M10 8h7m-7 4h7"/>',
  bookmark:'<path d="M6 3h12v18l-6-4-6 4z"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
const icon = (name: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ''}</svg>`;
function commandIcon(id:string,name:string,label:string,title=label){const node=$(id);if(node.dataset.icon!==name){node.innerHTML=icon(name);node.dataset.icon=name}node.setAttribute('aria-label',label);node.title=title;}
document.getElementById('app')!.innerHTML = `
  <header id="window-chrome" class="window-chrome" aria-label="Window title and toolbar">
  <div class="titlebar" aria-label="Window title">
    <div id="titlebar-caption" class="titlebar-caption" data-tauri-drag-region="deep">
      <span id="document-name" class="window-title">All View</span>
      <span class="titlebar-info"><span id="file-kind" class="type-badge" hidden></span><span id="file-status">Ready</span><span id="notice" role="status"></span></span>
    </div>
    <div class="caption-controls">
    <button id="pin" class="caption-button pin-button" aria-label="Pin window" aria-pressed="false" title="Pin window · Keep preview open when switching apps">${icon('window-pin')}</button>
    <button id="minimize" class="caption-button" aria-label="Minimize" title="Minimize">${icon('minimize')}</button>
    <button id="maximize" class="caption-button" aria-label="Maximize or restore" title="Maximize or restore">${icon('maximize')}</button>
    <button id="dismiss" class="caption-button caption-close" aria-label="Close preview" title="Close preview · Esc">${icon('close')}</button>
    </div>
  </div>
  <div class="toolbar-host">
    <button id="toolbar-reveal" aria-label="Show toolbar" aria-controls="preview-toolbar" title="Show toolbar · Ctrl+F1 keeps it visible">${icon('expand')}</button>
  <div id="preview-toolbar" class="command-toolbar" role="toolbar" aria-label="Preview toolbar">
    <div class="toolbar-group" role="group" aria-label="Browse files">
    <div class="file-navigation" aria-label="Folder navigation"><button id="previous-file" aria-label="Previous file" title="Previous file · Left / Alt+Left" disabled>${icon('previous')}</button><span id="folder-position" title="Files in this folder, sorted by name"></span><button id="next-file" aria-label="Next file" title="Next file · Right / Alt+Right" disabled>${icon('next')}</button></div>
    </div>
    <div class="toolbar-group" role="group" aria-label="File tools"><button id="file-open" aria-label="Open" title="Open in default application" hidden>${icon('external')}</button><button id="file-open-with" aria-label="Open with…" title="Open with… · Choose an application" hidden>${icon('apps')}</button>
    <button id="folder-view" title="Containing folder · Enter" aria-label="Folder view">${icon('folder')}</button>
    <button id="file-locks" aria-label="File locks" title="Find applications using this file or folder" disabled>${icon('locks')}</button>
    <button id="find-toggle" aria-label="Find in document" title="Find in document · Ctrl+F" disabled>${icon('search')}</button>
    </div>
    <div class="toolbar-group" role="group" aria-label="Viewer settings">
    <button id="theme-toggle" type="button" class="icon-button" aria-label="Dark theme" aria-pressed="false" title="Light theme · Switch to dark">${icon('sun')}</button>
    <button id="rail-toggle" class="icon-button" title="Document contents" aria-label="Contents" hidden>${icon('rail')}</button>
    </div>
    <div id="controls" hidden>
    <div class="toolbar-group" role="group" aria-label="Zoom">
    <button id="zoom-out" aria-label="Zoom out" title="Zoom out · Ctrl+−">${icon('minus')}</button><input id="zoom-value" class="zoom-input" type="number" min="1" max="500" value="100" aria-label="Zoom percentage" title="Zoom percentage · Ctrl+0 resets"><button id="zoom-in" aria-label="Zoom in" title="Zoom in · Ctrl++">${icon('plus')}</button>
    <button id="zoom-reset" aria-label="Reset zoom" title="Reset zoom · Ctrl+0">${icon('reset')}</button></div>
    <div id="format-controls"></div>
    <div class="toolbar-group" role="group" aria-label="File actions"><button id="tree-view" aria-label="Show tree" title="Show tree" hidden>${icon('tree')}</button><button id="image-edit" aria-label="Edit image" title="Edit image" hidden>${icon('edit')}</button><button id="print" aria-label="Print" hidden title="Print · Ctrl+P">${icon('print')}</button></div>
    <div class="toolbar-group" role="group" aria-label="View"><button id="source" aria-label="Show source" title="Show source" hidden>${icon('source')}</button><button id="wrap" aria-label="Wrap lines" title="Wrap lines" hidden>${icon('wrap')}</button><button id="face" aria-label="Change font" title="Change font" hidden>${icon('font-serif')}</button><button id="width" aria-label="Reading width" title="Reading width" hidden>${icon('column')}</button><button id="rotate" hidden aria-label="Rotate image" title="Rotate image">${icon('rotate')}</button><button id="fit" aria-label="Fit to window" title="Fit to window" hidden>${icon('fit')}</button><button id="fullscreen" aria-label="Full screen" title="Full screen · F11">${icon('full')}</button></div></div>
    <div class="toolbar-display-controls">
      <button id="header-pin" aria-label="Pin toolbar" aria-pressed="false" title="Always show toolbar · Ctrl+F1">${icon('toolbar-pin')}</button>
    </div>
  </div></div>
  </header>
  <div class="workspace"><aside id="rail" hidden></aside><main id="stage" aria-live="polite"></main></div>
  <dialog id="preferences"><form method="dialog"><div class="dialog-title"><h2>Make room for a quick look.</h2><button aria-label="Close settings" class="icon-button">${icon('close')}</button></div><p class="muted">All View lives in your tray while you browse.</p>
    <label class="setting"><span><strong>Remember document sidebar</strong><small>Restore its visibility and tab for supported files.</small></span><input id="remember-sidebar" type="checkbox"></label>
    <label class="setting"><span><strong>Space previews in Explorer</strong><small>Only when a file is selected. Typing stays yours.</small></span><input id="enable-space" type="checkbox"></label>
    <label class="setting"><span><strong>Start with Windows</strong><small>Start quietly in the tray when you sign in.</small></span><input id="autostart" type="checkbox"></label>
    <p id="settings-error" role="alert"></p><div class="dialog-note">Read-only previews · Local files · No uploads<br>Version 0.4.1 · Third-party licences apply</div><button id="quit-app" type="button" class="quit-button">Quit All View</button></form></dialog>
  <dialog id="startup-offer" aria-labelledby="startup-title" aria-describedby="startup-description"><h2 id="startup-title">Start All View with Windows?</h2><p id="startup-description" class="muted">Keep Space previews ready whenever you sign in. All View will start quietly in the tray.</p><p class="muted">You can change this later in Settings → Start with Windows.</p><p id="startup-error" role="alert"></p><div class="startup-actions"><button id="startup-later" type="button" autofocus>Not now</button><button id="startup-enable" type="button" class="primary-button">Start with Windows</button></div></dialog>`;

let current: Request|null = null, info: Info|null = null, sourceText = '', sourceMode = false;
let zoom = 1, rotation = 0, serif = true, column = true, wrapped = true;
let editor: {destroy:()=>void;zoom:(value:number)=>void;wrap:(enabled:boolean)=>void;search?:FindTarget}|null = null, parser: Worker|null = null, imageUrl: string|null = null;
let pdf: PDFDocumentProxy|null = null, pdfTask: ReturnType<typeof import('pdfjs-dist').getDocument>|null = null, pdfControls:PdfControls|null=null;
let findUI:ReturnType<typeof import('./find-dialog').findDialog>|null=null,findOpening=false,findDockRequested=false;
let previewReady=false,findPending=false;
let currentContents:ContentsProvider|undefined;
let headings: Heading[] = [], renderedMarkdown = '';
let settings: Settings = { enabled: true, available: true, autostart: false, startupPrompt: false, pinned: false, headerPinned: false };
let navigation: Navigation|null = null, navigating = false;
let previewAbort: AbortController|null = null, extendedControls: PreviewControls|null = null;
let imageControls:ReturnType<typeof import('./image-view').imageView>|null=null;
let imageFind:FindTarget|undefined;
let treeMode=false,editorGeneration=0,treeControls:{zoom:(value:number)=>void}|null=null,editorOpening=false;
let wheelFrame=0,wheelTarget=1,wheelTime=0,wheelEpoch=0;
let wheelAnchor:ZoomAnchor|undefined;
const wheelGesture=createZoomGesture<ZoomAnchor>();
const desktop = '__TAURI_INTERNALS__' in window;
const message = (text: string) => { $('notice').textContent = text;$('notice').title=text; };
const sidebarUI=documentSidebar($('rail'),icon,()=>showFind(true),message);
function setContents(provider?:ContentsProvider){currentContents=provider;sidebarUI.setContents(provider);$('rail-toggle').hidden=!provider;}
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
const kindLabel = (kind:string) => ({'engine-word':'WORD','engine-presentation':'SLIDES','engine-spreadsheet':'SHEETS','engine-geo':'MAP','engine-drawing':'DIAGRAM','engine-model':'3D','engine-dicom':'DICOM','engine-email':'EMAIL','engine-data':'DATA','engine-iwork':'IWORK','engine-wordperfect':'WORDPERFECT','engine-hangul':'HANGUL','engine-cad':'CAD','paged':'DOCUMENT','bpmn':'DIAGRAM','access':'DATABASE','metafile':'IMAGE','convert-image':'IMAGE','package-document':'DOCUMENT','graphviz':'GRAPH','npy':'NUMPY','netcdf':'NETCDF','hdf5':'HDF5'} as Record<string,string>)[kind]??kind.replace(/^engine-/,'').toUpperCase();
function emptyState() {
  $('stage').innerHTML = `<section class="empty"><div class="empty-mark" aria-hidden="true">AV</div><h1>All View</h1><p>Select a file or folder in Explorer and press <kbd>Space</kbd>.</p><button id="empty-open" class="primary-button">Open a file</button><p class="key-hint">Ctrl+O to open · Esc to dismiss</p></section>`;
  $('empty-open').onclick = pickFile; $('rail-toggle').hidden = true;
}
function cleanup() {
  sidebarUI.beginDocument();
  findUI=null;findOpening=false;findDockRequested=false;previewReady=false;findPending=false;pdfControls?.destroy();pdfControls=null;
  cancelViewportRefit();
  stopWheelZoom();
  editorGeneration++;treeControls=null;for(const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.tool-dialog[open]')){dialog.close();dialog.remove()}
  previewAbort?.abort(); previewAbort=null; extendedControls=null;
  $('format-controls').replaceChildren();
  imageControls=null;imageFind=undefined;
  editor?.destroy(); editor = null; parser?.terminate(); parser = null;
  void pdfTask?.destroy(); pdfTask = null; pdf = null;
  if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null;
  sidebarUI.reset();currentContents=undefined;$('rail-toggle').hidden=true;headings=[];renderedMarkdown='';
}
function errorState(error: unknown) {
  $('stage').replaceChildren(); const section = document.createElement('section'); section.className='error-state';
  const eyebrow=document.createElement('span');eyebrow.className='eyebrow';eyebrow.textContent='PREVIEW';
  const title=document.createElement('h1');title.textContent='Preview unavailable.';
  const text=document.createElement('p');text.textContent=String(error);
  const button=document.createElement('button');button.className='primary-button';button.textContent='Open another file';button.onclick=pickFile;
  section.append(eyebrow,title,text,button);$('stage').append(section);$('controls').hidden=true;$('rail-toggle').hidden=true;
  $('file-status').textContent=info?.name??'Preview unavailable';
  message('The original file is unchanged.');
}
function updateNavigation() {
  ($('previous-file') as HTMLButtonElement).disabled=navigating||!navigation?.previous;
  ($('next-file') as HTMLButtonElement).disabled=navigating||!navigation?.next;
  $('folder-position').textContent=navigation?`${navigation.position} / ${navigation.total}`:'';
  $('previous-file').title=`Previous file · Left / Alt+Left${navigation?.previous?` · ${navigation.previous}`:''}`;
  $('next-file').title=`Next file · Right / Alt+Right${navigation?.next?` · ${navigation.next}`:''}`;
}
async function loadNavigation(request: Request) {
  if(!desktop)return;
  try {
    const result=await invoke<Navigation>('folder_status',{id:request.id});
    if(current?.id!==request.id)return;navigation=result;updateNavigation();$('folder-position').title='Files in this folder, sorted by name';
  } catch(error) {if(current?.id===request.id){navigation=null;updateNavigation();$('folder-position').textContent='—';$('folder-position').title=String(error)}}
}
async function navigateFile(direction: -1|1) {
  if(!desktop||!current||navigating||!(direction===-1?navigation?.previous:navigation?.next))return;
  const request=current;navigating=true;updateNavigation();
  try {const next=await invoke<Request>('navigate_file',{id:request.id,direction});if(current?.id===request.id)void openRequest(next)}
  catch(error) {if(current?.id===request.id){message(String(error));void loadNavigation(request)}}
  finally {if(current?.id===request.id){navigating=false;updateNavigation()}}
}
function updateControls() {
  const kind=info?.kind;
  $<HTMLButtonElement>('find-toggle').disabled=!info;
  $('controls').hidden=!info;
  $('tree-view').hidden=!(kind==='json'||info?.name.toLowerCase().endsWith('.xml'));commandIcon('tree-view',treeMode?'source':'tree',treeMode?'Show source':'Show tree');
  $('image-edit').hidden=!kind||!['image','convert-image','svg','metafile'].includes(kind);
  $('print').hidden=!kind||['directory','audio','video','model','engine-model'].includes(kind);
  $('source').hidden=kind!=='markdown'; $('source').classList.toggle('active',sourceMode);
  $('source').setAttribute('aria-pressed',String(sourceMode));
  commandIcon('source',sourceMode?'document':'source',sourceMode?'Show rendered Markdown':'Show Markdown source');
  $('wrap').hidden=!(kind==='text'||kind==='json'||(kind==='markdown'&&sourceMode));
  $('wrap').classList.toggle('active',wrapped);$('wrap').setAttribute('aria-pressed',String(wrapped));
  $('face').hidden=kind!=='markdown'||sourceMode; $('width').hidden=kind!=='markdown'||sourceMode;
  commandIcon('face',serif?'font-serif':'font-sans',serif?'Use sans-serif font':'Use serif font');commandIcon('width',column?'column':'wide',column?'Use full width':'Use reading column');
  const image=!!kind&&['image','convert-image','svg'].includes(kind);
  $('rotate').hidden=!image; $('fit').hidden=!(image||kind==='engine-word');commandIcon('fit',kind==='engine-word'?'fit-width':'fit',kind==='engine-word'?'Fit document to width':'Fit image to window');
  const canZoom=!!kind&&(['text','json','markdown','image','pdf'].includes(kind)||!!extendedControls?.zoom);
  for(const id of ['zoom-out','zoom-value','zoom-in','zoom-reset'])$(id).hidden=!canZoom;
  $<HTMLInputElement>('zoom-value').value=String(Math.round(zoom*100));
  $('file-open').hidden=!desktop||!current;
  $('file-open-with').hidden=!desktop||!current||kind==='directory';
  $<HTMLButtonElement>('folder-view').disabled=false;$<HTMLButtonElement>('file-locks').disabled=!desktop;
  updateNavigation();
}
function showOutline() {
  setContents(sourceMode?undefined:()=>headings.map(heading=>({...heading,go:()=>{document.getElementById(heading.id)?.scrollIntoView({block:'start'})}})));
  if(headings.length&&!sourceMode&&!sidebarUI.isOpen()&&!sidebarUI.remember)sidebarUI.open('contents');
}
async function showEditor() {
  const generation=++editorGeneration,signal=previewAbort?.signal;editor?.destroy();editor=null;treeControls=null;
  // Paint readable content before downloading/parsing the optional editor chunk.
  const fallback=document.createElement('pre');fallback.className='source-placeholder';fallback.textContent=sourcePlaceholder(sourceText);fallback.style.fontSize=`${14*zoom}px`;fallback.style.whiteSpace=wrapped?'pre-wrap':'pre';$('stage').replaceChildren(fallback);$('stage').className='source-stage';
  editor={destroy:()=>fallback.remove(),zoom:value=>{fallback.style.fontSize=`${14*value}px`},wrap:enabled=>{fallback.style.whiteSpace=enabled?'pre-wrap':'pre'}};
  setContents();updateControls();await frame();
  const {sourceView}=await import('./source-view');if(generation!==editorGeneration||signal?.aborted||!signal)return;
  $('stage').replaceChildren();$('stage').className='source-stage';editor=sourceView($('stage'),sourceText,info?.name??'',info?.kind??'text',zoom,wrapped,signal);
  setContents();updateControls();findUI?.refresh();
}
async function showTree(){const generation=++editorGeneration;editor?.destroy();editor=null;const {structuredView}=await import('./structured-view');if(generation!==editorGeneration||previewAbort?.signal.aborted)return;try{treeControls=structuredView($('stage'),sourceText,info?.name.toLowerCase().endsWith('.xml'));treeControls.zoom(zoom);setContents();updateControls();findUI?.refresh()}catch(error){treeMode=false;void showEditor();message(String(error))}}
function showMarkdown() {
  editorGeneration++;treeControls=null;
  editor?.destroy();editor=null; $('stage').className='document-stage';$('stage').innerHTML='<article class="paper"></article>';
  const article=$('stage').firstElementChild as HTMLElement;article.innerHTML=renderedMarkdown;
  styleMarkdown(article);
  article.addEventListener('click',event=>{
    const anchor=(event.target as HTMLElement).closest('a');if(!anchor)return;event.preventDefault();
    const href=anchor.getAttribute('href')??'';if(href.startsWith('#'))document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({behavior:'smooth'});else message('External links stay closed in a local preview.');
  });
  showOutline();updateControls();findUI?.refresh();
}
function styleMarkdown(article=$('stage').querySelector<HTMLElement>('article.paper')) {
  if(!article)return;article.style.fontSize=`${17*zoom}px`;article.classList.toggle('sans',!serif);article.classList.toggle('wide',!column);
}
function decodeText(bytes: Uint8Array) {
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes);
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{message('Showing this file with a Windows text encoding.');return new TextDecoder('windows-1252').decode(bytes)}
}
async function openRequest(request: Request,browserFile?:File,force=false) {
  if(current && request.id<=current.id&&!force)return;
  const started=performance.now();current=request;cleanup();info=null;sourceMode=false;treeMode=false;zoom=1;rotation=0;message('');updateControls();
  $<HTMLButtonElement>('file-locks').disabled=!desktop;
  const abort=new AbortController();previewAbort=abort;
  const formatTools=document.createElement('div');formatTools.className='format-tools-host';$('format-controls').replaceChildren(formatTools);
  navigation=null;navigating=false;updateNavigation();
  $('stage').className='';$('stage').innerHTML='<section class="loading"><span class="spinner"></span><p>Taking a closer look…</p></section>';
  $('document-name').textContent=request.path.split(/[\\/]/).pop()??request.path;$('file-kind').hidden=true;$('file-status').textContent='Loading preview…';
  let directory=false;
  try {
    let details:Info,bytes:Uint8Array<ArrayBuffer>,mediaUrl:string|undefined,rangedPdf=false;
    if(browserFile){
      const {default:formats}=await import('./formats.json');if(abort.signal.aborted)return;
      details={name:browserFile.name,path:browserFile.name,bytes:browserFile.size,kind:(formats as Record<string,{kind:string}>)[browserFile.name.toLowerCase().split('.').pop()??'']?.kind??'unsupported',mime:browserFile.type,width:null,height:null};
      if(['audio','video'].includes(details.kind)){mediaUrl=URL.createObjectURL(browserFile);abort.signal.addEventListener('abort',()=>URL.revokeObjectURL(mediaUrl!),{once:true});bytes=new Uint8Array(0)}
      else if(details.kind==='pdf'){rangedPdf=true;bytes=new Uint8Array(0)}else bytes=new Uint8Array(await browserFile.arrayBuffer());
    }
    else {const loaded=decodePreview(await invoke<ArrayBuffer|number[]>('load_preview',{id:request.id}));details=loaded.info;bytes=loaded.bytes;rangedPdf=loaded.transport==='pdf';if(loaded.transport==='media')mediaUrl=convertFileSrc(String(request.id),'av-media');}
    if(current?.id!==request.id)return;info=details;
    const fitContent=async(width=0,height=0,extraHeight=0)=>{
      if(!desktop||abort.signal.aborted)return;
      extraHeight=Math.min(200,extraHeight+$('window-chrome').getBoundingClientRect().height);
      try{await invoke('fit_preview_window',{id:request.id,width,height,extraHeight});await frame()}catch(error){if(!abort.signal.aborted)console.warn('Window fit unavailable',error)}
    };
    if(!['image','pdf','svg','metafile','convert-image','video','paged'].includes(details.kind))await fitContent();
    if(abort.signal.aborted)return;
    $('document-name').textContent=details.name;$('document-name').title=details.path;$('file-kind').textContent=kindLabel(details.kind);$('file-kind').hidden=false;
    $('file-status').textContent=bytesLabel(details.bytes);$('file-status').title=details.path;
    if(details.kind==='directory'){directory=true;updateControls();const {folderView}=await import('./folder-view');if(abort.signal.aborted)return;await folderView($('stage'),request.id,abort.signal,message,next=>{void openRequest(next)},formatTools,icon);return}
    updateControls();
    if(details.kind==='image'){
      imageUrl=URL.createObjectURL(new Blob([bytes],{type:details.mime}));$('stage').className='image-stage';$('stage').innerHTML='<img id="preview-image" alt="">';
      const image=$<HTMLImageElement>('preview-image');image.alt=details.name;image.src=imageUrl;
      image.onerror=()=>{if(current?.id===request.id)errorState('This image could not be decoded. The file may be damaged.')};
      await image.decode();
      if(abort.signal.aborted)return;
      message(`${image.naturalWidth} × ${image.naturalHeight} pixels · Read only`);
      await fitContent(image.naturalWidth,image.naturalHeight);if(abort.signal.aborted)return;
      const {imageView}=await import('./image-view');if(abort.signal.aborted)return;imageControls=imageView($('stage'),image,abort.signal);zoom=imageControls.initialZoom;updateControls();if(request.editImage)$('image-edit').click();
    } else if(details.kind==='pdf') {
      message('Reading PDF…');
      await loadPdf();if(abort.signal.aborted)return;
      const {pdfRange}=await import('./pdf-range');if(abort.signal.aborted)return;
      const range=rangedPdf?pdfRange(pdfjs.PDFDataRangeTransport,details.bytes,(begin,end)=>browserFile?browserFile.slice(begin,end).arrayBuffer():invoke<ArrayBuffer>('read_pdf_range',{id:request.id,begin,end}),abort.signal,error=>{if(!abort.signal.aborted){void loading.destroy();errorState(String(error))}}):undefined;
      const loading=pdfjs.getDocument({...range?{range:range.transport,rangeChunkSize:65536,disableStream:true}:{data:bytes},useWasm:false,enableXfa:false,useSystemFonts:true,disableAutoFetch:true});pdfTask=loading;
      loading.onPassword=async(callback:(password:string)=>void,reason:number)=>{const {pdfPassword}=await import('./pdf-password');if(abort.signal.aborted)return;const answer=await pdfPassword(reason===2,abort.signal);if(abort.signal.aborted)return;if(answer!==null)callback(answer);else{void loading.destroy();errorState('Password entry cancelled.')}};
      const document=await loading.promise;if(current?.id!==request.id){void loading.destroy();return}pdf=document;
      const firstPage=await document.getPage(1);const dimensions=firstPage.getViewport({scale:1});await fitContent(dimensions.width,dimensions.height);if(abort.signal.aborted)return;const [{pdfPreview},{nativePdfOcrCache}]=await Promise.all([import('./pdf-preview'),import('./pdf-ocr-cache')]);if(abort.signal.aborted)return;const controls=await pdfPreview($('stage'),document,details.name,details.bytes,abort.signal,icon,value=>{if(!abort.signal.aborted){if(!wheelFrame){zoom=value;updateControls()}else $<HTMLInputElement>('zoom-value').value=String(Math.round(value*100))}},message,sidebarUI,formatTools,desktop&&!browserFile?nativePdfOcrCache(request.id,abort.signal,rangedPdf):undefined,()=>{range?.afterFirstPaint();performance.measure('av-pdf-first-view',{start:started,end:performance.now()})});if(abort.signal.aborted){controls.destroy();return}pdfControls=controls;setContents(controls.contents);
    } else if(!['text','json','markdown'].includes(details.kind)) {
      const {renderExtended}=await import('./extended-preview');if(current?.id!==request.id)return;
      const controls=await renderExtended(details,bytes,{stage:$('stage'),signal:abort.signal,toolbar:formatTools,icon,fitContent,mediaUrl,zoomChanged:value=>{if(!abort.signal.aborted&&current?.id===request.id){if(!wheelFrame){zoom=value;updateControls()}else $<HTMLInputElement>('zoom-value').value=String(Math.round(value*100))}},notify:text=>{if(current?.id===request.id){message(text);if(text==='Local visual preview · Read only')void frame().then(()=>{if(!abort.signal.aborted)performance.measure(`av-engine-ready:${details.kind}`,{start:started,end:performance.now()})});}}});
      if(abort.signal.aborted||current?.id!==request.id)return;extendedControls=controls;setContents(controls.contents);
      if(current?.id===request.id){if(extendedControls.initialZoom)zoom=extendedControls.initialZoom;updateControls();}
    } else {
      sourceText=decodeText(bytes);
      // Wrapping a multi-megabyte line forces expensive layout even with a
      // virtualized editor. The user can explicitly enable Wrap if needed.
      if(sourceText.length>524288)wrapped=false;
      if(details.kind==='markdown'){
        await new Promise<void>(resolve=>{
        abort.signal.addEventListener('abort',()=>resolve(),{once:true});
        parser=new Worker(new URL('./parse.worker.ts',import.meta.url),{type:'module'});
        parser.onmessage=event=>{
          if(current?.id!==request.id){resolve();return}
          if(event.data.ok){renderedMarkdown=event.data.html;headings=event.data.headings;showMarkdown();message('Read only · Source available')}
          else{sourceMode=true;void showEditor();message(event.data.error)}parser?.terminate();parser=null;resolve();
        };
        parser.onerror=()=>{if(current?.id===request.id){sourceMode=true;void showEditor();message('Showing source because the styled preview could not be prepared.')}resolve()};
        parser.postMessage(sourceText);
        });
      } else {if(details.kind==='json'&&sourceText.length<=JSON_AUTO_TREE_LIMIT){treeMode=true;await showTree()}else await showEditor();message(sourceText.length>524288?'Read only · Highlighting paused for this large file':'Read only');}
    }
    if(current?.id===request.id){previewReady=true;await sidebarUI.restore(documentPreview(details.kind));if(current?.id!==request.id)return;findUI?.refresh();await frame();if(performance.getEntriesByType('measure').length>=50)performance.clearMeasures();performance.measure(`av-preview:${details.kind}`,{start:started,end:performance.now()});}
  } catch(error) {if(current?.id===request.id)errorState(error);}
  finally {if(current?.id===request.id){previewReady=true;if(findPending){findPending=false;void showFind()}if(!directory)void loadNavigation(request)}}
}
function stopWheelZoom(){wheelEpoch++;cancelAnimationFrame(wheelFrame);wheelFrame=0;wheelAnchor=undefined;wheelGesture.reset();imageControls?.cancelPan();extendedControls?.cancelPan?.();pdfControls?.cancelInteraction();}
function applyZoom(wheel=false){
  updateControls();if(treeMode&&treeControls){treeControls.zoom(zoom);return}
  if(extendedControls){extendedControls.zoom?.(zoom,wheel?wheelAnchor:undefined);return}
  if(info?.kind==='pdf'){
    pdfControls?.zoom(zoom,wheel,wheel?wheelAnchor:undefined);
  }else if(imageControls)imageControls.zoom(zoom,wheel?wheelAnchor:undefined);
  else if(info?.kind==='markdown'&&!sourceMode)styleMarkdown();else editor?.zoom(zoom);
}
function changeZoom(delta:number,value?:number){
  // Hiding a focused number field can commit its old value during file replacement.
  if(!info||extendedControls&&!extendedControls.zoom)return;
  const target=delta?zoomStep(wheelFrame?wheelTarget:zoom,delta):clampZoom(value??zoom);
  cancelViewportRefit();stopWheelZoom();
  wheelTarget=target;
  if(matchMedia('(prefers-reduced-motion: reduce)').matches||Math.abs(target-zoom)<.0001){zoom=target;applyZoom();return}
  wheelTime=0;queueZoomFrame(wheelEpoch);
}
function queueZoomFrame(token:number){wheelFrame=requestAnimationFrame(time=>animateWheel(time,token))}
function animateWheel(time:number,token:number){
  if(token!==wheelEpoch)return;
  const elapsed=wheelTime?Math.min(64,time-wheelTime):16;wheelTime=time;
  const blend=matchMedia('(prefers-reduced-motion: reduce)').matches?1:1-Math.exp(-elapsed/45);
  zoom+= (wheelTarget-zoom)*blend;
  const done=Math.abs(wheelTarget-zoom)<.0001;if(done)zoom=wheelTarget;
  applyZoom(!done);if(token!==wheelEpoch)return;if(done)wheelFrame=0;else queueZoomFrame(token);
}
async function pickFile() {if(!desktop){message('File opening is available in the desktop app.');return}try{await invoke('pick_file')}catch(error){message(String(error))}}
function updateListenerSetting() { $<HTMLInputElement>('enable-space').checked=settings.enabled; }
function updatePin() {
  toolbarUI.setPinned(settings.headerPinned);
  $('header-pin').setAttribute('aria-pressed',String(settings.headerPinned));$('header-pin').setAttribute('aria-label',settings.headerPinned?'Auto-hide toolbar':'Pin toolbar');$('header-pin').title=settings.headerPinned?'Auto-hide toolbar · Ctrl+F1':'Always show toolbar · Ctrl+F1';$('header-pin').innerHTML=icon(settings.headerPinned?'collapse':'toolbar-pin');
  $('pin').setAttribute('aria-pressed',String(settings.pinned));$('pin').setAttribute('aria-label',settings.pinned?'Unpin window':'Pin window');$('pin').title=settings.pinned?'Unpin window · Hide preview when focus moves away':'Pin window · Keep preview open when switching apps';$('pin').classList.toggle('pinned',settings.pinned);
}
async function refreshSettings() {if(!desktop)return;settings=await invoke<Settings>('get_settings');updateListenerSetting();updatePin();$<HTMLInputElement>('autostart').checked=settings.autostart;}
$('dismiss').onclick=()=>{if(desktop)void invoke('dismiss_preview')};
async function togglePin(header:boolean){
  const control=$<HTMLButtonElement>(header?'header-pin':'pin'),key=header?'headerPinned':'pinned';control.disabled=true;
  try{settings[key]=desktop?await invoke<boolean>(header?'set_header_pinned':'set_pinned',{pinned:!settings[key]}):!settings[key];updatePin()}
  catch(error){message(String(error))}finally{control.disabled=false}
}
$('pin').onclick=()=>{void togglePin(false)};
$('header-pin').onclick=()=>{void togglePin(true)};
const toolbarUI=setupToolbar();
$('titlebar-caption').addEventListener('mousedown',event=>{if(event.button===0&&event.detail===2)requestViewportRefit()},{capture:true});
$('minimize').onclick=()=>{if(desktop)void getCurrentWindow().minimize()};$('maximize').onclick=()=>{if(desktop)void getCurrentWindow().toggleMaximize().then(requestViewportRefit)};
$('previous-file').onclick=()=>{void navigateFile(-1)};$('next-file').onclick=()=>{void navigateFile(1)};
function showPreferences(){if(($('startup-offer') as HTMLDialogElement).open)return;void refreshSettings().catch(error=>message(String(error)));const dialog=$('preferences') as HTMLDialogElement;if(!dialog.open)dialog.showModal();}
function showStartupOffer(){if(!settings.startupPrompt)return;const preferences=$('preferences') as HTMLDialogElement;if(preferences.open)preferences.close();const dialog=$('startup-offer') as HTMLDialogElement;if(!dialog.open)dialog.showModal();}
let startupSaving=false;
async function finishStartup(enabled:boolean){
  if(startupSaving||!desktop)return;startupSaving=true;
  const buttons=[$<HTMLButtonElement>('startup-later'),$<HTMLButtonElement>('startup-enable')];buttons.forEach(b=>b.disabled=true);
  try{await invoke('set_autostart',{enabled});await refreshSettings();($('startup-offer') as HTMLDialogElement).close();if(!current)await invoke('dismiss_preview')}
  catch(error){$('startup-error').textContent=String(error)}
  finally{startupSaving=false;buttons.forEach(b=>b.disabled=false)}
}
$('startup-enable').onclick=()=>{void finishStartup(true)};
$('startup-later').onclick=()=>{void finishStartup(false)};
$('startup-offer').addEventListener('cancel',event=>{event.preventDefault();void finishStartup(false)});
function updateThemeButton(){const dark=theme.mode==='dark';commandIcon('theme-toggle',dark?'moon':'sun','Dark theme',`${dark?'Dark':'Light'} theme · Switch to ${dark?'light':'dark'}`);$('theme-toggle').setAttribute('aria-pressed',String(dark));}
updateThemeButton();
$<HTMLInputElement>('remember-sidebar').checked=sidebarUI.remember;
$('remember-sidebar').onchange=()=>{$('settings-error').textContent=sidebarUI.setRemember($<HTMLInputElement>('remember-sidebar').checked)?'':'Sidebar setting applied for this session; it could not be saved.'};
$('theme-toggle').onclick=()=>{const saved=theme.set(theme.mode==='light'?'dark':'light');updateThemeButton();message(saved?'':'Theme applied for this session. The preference could not be saved.');};
$('rail-toggle').onclick=()=>{if(sidebarUI.contentsVisible())sidebarUI.hide();else if(currentContents)sidebarUI.open('contents')};
$('find-toggle').onclick=()=>{void showFind()};
$('source').onclick=()=>{sourceMode=!sourceMode;if(sourceMode)showEditor();else showMarkdown()};
$('wrap').onclick=()=>{wrapped=!wrapped;editor?.wrap(wrapped);updateControls()};
$('zoom-in').onclick=()=>changeZoom(1);$('zoom-out').onclick=()=>changeZoom(-1);$('zoom-reset').onclick=()=>changeZoom(0,1);
$('zoom-value').onchange=()=>changeZoom(0,Number($<HTMLInputElement>('zoom-value').value)/100);
$('tree-view').onclick=()=>{treeMode=!treeMode;if(treeMode)void showTree();else void showEditor();updateControls()};
async function containingFolder(){if(!desktop||!current)return;try{await invoke('open_containing_folder',{id:current.id})}catch(error){message(String(error))}}
$('folder-view').onclick=()=>{void containingFolder()};
let externalOpening=false;
async function openExternal(choose:boolean){if(!desktop||!current||externalOpening)return;externalOpening=true;const request=current;for(const id of ['file-open','file-open-with'])$<HTMLButtonElement>(id).disabled=true;try{await invoke('open_external',{id:request.id,choose})}catch(error){if(current?.id===request.id)message(String(error))}finally{externalOpening=false;for(const id of ['file-open','file-open-with'])$<HTMLButtonElement>(id).disabled=false}}
$('file-open').onclick=()=>void openExternal(false);$('file-open-with').onclick=()=>void openExternal(true);
$('file-locks').onclick=()=>{const request=current,signal=previewAbort?.signal;if(!desktop||!request||!signal||document.querySelector('.lock-dialog'))return;void import('./lock-view').then(({lockView})=>{if(current?.id===request.id&&!signal.aborted&&!document.querySelector('.lock-dialog'))lockView(request.id,request.path,signal)})};
$('image-edit').onclick=()=>{const image=$('stage').querySelector<HTMLImageElement>('#preview-image');if(!image||!current||!previewAbort||editorOpening||document.querySelector('dialog[open]'))return;editorOpening=true;const request=current,signal=previewAbort.signal,name=info?.name??'Image';const open=async()=>{if(desktop){const {nativeImageEditor}=await import('./native-image-editor');if(!signal.aborted)await nativeImageEditor(image,request.id,signal);if(!signal.aborted&&current?.id===request.id)await openRequest({...request,editImage:false})}else{const {imageEditor}=await import('./image-editor');if(!signal.aborted)await imageEditor(image,name,request.id,signal,message)}};void open().catch(error=>{if(!signal.aborted)message(String(error))}).finally(()=>{editorOpening=false;if(imageControls&&current?.editImage&&current.id!==request.id)$('image-edit').click()})};
$('print').onclick=()=>{const request=current;void import('./print-preview').then(async({portraitPrint,printDocument})=>{const image=$('stage').querySelector<HTMLImageElement>('#preview-image');if(image)portraitPrint(image.src,info?.name??'Image',previewAbort?.signal);else{const printStage=pdfControls?await pdfControls.printPage():$('stage');if(current!==request)return;await printDocument(printStage,info?.name??'Preview',info&&['text','json'].includes(info.kind)||(info?.kind==='markdown'&&sourceMode)?sourceText:undefined)}}).catch(error=>message(String(error)))};
$('face').onclick=()=>{serif=!serif;updateControls();styleMarkdown()};
$('width').onclick=()=>{column=!column;updateControls();styleMarkdown()};
$('rotate').onclick=()=>{stopWheelZoom();rotation=(rotation+90)%360;imageControls?.rotate(rotation);extendedControls?.rotate?.(rotation)};$('fit').onclick=()=>{stopWheelZoom();zoom=imageControls?.fit()??extendedControls?.fit?.()??1;updateControls()};
let viewportRefit:{id:number;timer:ReturnType<typeof setTimeout>;frame:number}|null=null;
function cancelViewportRefit(){if(viewportRefit){clearTimeout(viewportRefit.timer);cancelAnimationFrame(viewportRefit.frame);viewportRefit=null}}
function queueViewportRefit(){const pending=viewportRefit;if(!pending)return;cancelAnimationFrame(pending.frame);pending.frame=requestAnimationFrame(()=>{pending.frame=requestAnimationFrame(()=>{if(viewportRefit!==pending||current?.id!==pending.id||previewAbort?.signal.aborted)return;stopWheelZoom();if(imageControls)zoom=imageControls.fit(true);else if(extendedControls?.fit)zoom=extendedControls.fit(true);else if(pdfControls){pdfControls.fit()}updateControls()})})}
function requestViewportRefit(){cancelViewportRefit();if(!current)return;viewportRefit={id:current.id,timer:setTimeout(cancelViewportRefit,1500),frame:0};queueViewportRefit()}
new ResizeObserver(queueViewportRefit).observe($('stage'));
async function toggleZen(){try{if(document.fullscreenElement){await document.exitFullscreen();$('app').classList.remove('zen-mode')}else if(desktop){$('app').classList.toggle('zen-mode',await invoke<boolean>('toggle_fullscreen'))}else{await $('app').requestFullscreen();$('app').classList.add('zen-mode')}requestViewportRefit()}catch(error){message(String(error))}}
$('fullscreen').onclick=()=>{void toggleZen()};
$('stage').addEventListener('dblclick',event=>{if(event.defaultPrevented||documentPreview(info?.kind)||window.getSelection()?.toString()||event.composedPath().some(node=>node instanceof Element&&node.matches('button,input,select,textarea,a,[contenteditable],.cm-editor,.textLayer,[role="tree"],[role="grid"],.media-controls,.model-stage,dialog')))return;event.preventDefault();void toggleZen()});
document.addEventListener('fullscreenchange',()=>{if(!desktop&&!document.fullscreenElement)$('app').classList.remove('zen-mode');requestViewportRefit()});
$('enable-space').onchange=async()=>{await invoke('set_listener_enabled',{enabled:$<HTMLInputElement>('enable-space').checked});await refreshSettings()};
$('autostart').onchange=async()=>{const control=$<HTMLInputElement>('autostart'),previous=settings.autostart;control.disabled=true;try{await invoke('set_autostart',{enabled:control.checked});await refreshSettings();$('settings-error').textContent=''}catch(error){control.checked=previous;$('settings-error').textContent=String(error);try{await refreshSettings()}catch{}}finally{control.disabled=false}};
$('quit-app').onclick=()=>{if(desktop)void invoke('quit_app')};
async function showFind(dock=false){
 if(document.querySelector('dialog[open]:not(.find-dialog)'))return;
 findDockRequested ||= dock;
 if(!previewReady&&previewAbort){findPending=true;return}
 if(findUI){findUI.open(findDockRequested);findDockRequested=false;return}if(findOpening||!previewAbort||!info||document.querySelector('dialog[open]'))return;
 const signal=previewAbort.signal;findOpening=true;
 try{
  const {findDialog,domFindTarget}=await import('./find-dialog');if(signal.aborted||document.querySelector('dialog[open]:not(.find-dialog)'))return;
  if(imagePreview(info?.kind)&&!imageFind){const image=$('stage').querySelector<HTMLImageElement>('#preview-image');if(image){const [{imageSearch},{nativePdfOcrCache}]=await Promise.all([import('./image-search'),import('./pdf-ocr-cache')]);if(signal.aborted)return;imageFind=imageSearch(image,signal,desktop&&current?nativePdfOcrCache(current.id,signal):undefined)}}
  const opened=findUI as ReturnType<typeof import('./find-dialog').findDialog>|null;if(opened){opened.open(findDockRequested);findDockRequested=false;return}
  let domRoot:HTMLElement|ShadowRoot|undefined,rendered:FindTarget|undefined,backend:FindTarget|undefined;
  const target:FindTarget={search(...args){const root=extendedControls?.findRoot??$('stage');if(root!==domRoot){domRoot=root;rendered=domFindTarget(root)}const next=imageFind??pdfControls?.find??editor?.search??rendered!;if(backend!==next)backend?.close?.();backend=next;backend.search(...args)},close(){backend?.close?.()}};
  findUI=findDialog(target,signal,icon,sidebarUI);findUI.open(findDockRequested);findDockRequested=false;
 }catch(error){if(!signal.aborted)message(`Find could not be opened: ${String(error)}`)}finally{if(previewAbort?.signal===signal)findOpening=false}
}
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!document.querySelector('dialog[open]:not(.find-dialog)')&&findUI?.dismiss()){event.preventDefault();event.stopPropagation();return}
 if((event.ctrlKey||event.metaKey)&&!event.altKey&&(event.code==='KeyF'||event.key.toLowerCase()==='f')){event.preventDefault();event.stopPropagation();if(!document.querySelector('dialog[open]')||document.querySelector('.find-dialog[open]'))void showFind()}
 else if(event.key==='F3'&&!event.ctrlKey&&!event.altKey&&!event.metaKey){if(document.querySelector('dialog[open]:not(.find-dialog)'))return;event.preventDefault();if(findUI)findUI.next(event.shiftKey);else void showFind()}
},{capture:true});
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented||document.querySelector('dialog[open]:not(.find-dialog)'))return;
  if(event.ctrlKey&&!event.altKey&&!event.metaKey&&event.key==='F1'){event.preventDefault();void togglePin(true);return}
  if(event.key==='Escape'&&(sidebarUI.dismiss()||toolbarUI.dismiss())){event.preventDefault();return}
  if(event.key==='Escape'){event.preventDefault();if(desktop)void invoke('dismiss_preview');return}
  const interactive=event.composedPath().some(target=>typing(target)||(target instanceof Element&&!!target.closest('[role="slider"],[role="tree"],[role="grid"],.model-stage,.document-sidebar,.find-panel')));
  const direction=siblingDirection(event,interactive,info?.kind);
  if(direction){event.preventDefault();void navigateFile(direction);return}
  if(event.ctrlKey&&['+','=','-','0'].includes(event.key)){event.preventDefault();if(event.key==='0')changeZoom(0,1);else changeZoom(event.key==='-'?-1:1);return}
  if(event.ctrlKey&&event.key.toLowerCase()==='p'){event.preventDefault();if(!$('print').hidden)$('print').click();return}
  if(event.ctrlKey&&event.key.toLowerCase()==='o'){event.preventDefault();void pickFile();return}
  if(typing(event.target))return;
  if(event.ctrlKey&&event.key.toLowerCase()==='o'){event.preventDefault();void pickFile()}
  else if(event.ctrlKey&&event.key.toLowerCase()==='u'&&info?.kind==='markdown'){event.preventDefault();$('source').click()}
  else if(event.key==='F11'){event.preventDefault();$('fullscreen').click()}
  else if(event.ctrlKey&&event.key.toLowerCase()==='p'){event.preventDefault();if(!$('print').hidden)$('print').click()}
  else if(event.key==='Enter'&&!event.altKey&&!event.ctrlKey&&!(event.target instanceof HTMLButtonElement)){event.preventDefault();void containingFolder()}
});
document.addEventListener('wheel',event=>{
  if(!info||document.querySelector('dialog[open]')||event.altKey||event.metaKey||event.shiftKey||!(event.target instanceof Element)||!event.target.closest('#stage')||(!event.ctrlKey&&!$('stage').classList.contains('pixel-image-stage')))return;
  if(extendedControls&&!extendedControls.zoom)return;
  if(!['text','json','markdown','image','pdf'].includes(info.kind)&&!extendedControls?.zoom)return;
  if(!event.deltaY)return;event.preventDefault();cancelViewportRefit();
  imageControls?.cancelPan();extendedControls?.cancelPan?.();
  wheelTarget=wheelZoom(wheelFrame?wheelTarget:zoom,event.deltaY,event.deltaMode,$('stage').clientHeight);
  wheelAnchor=wheelGesture.next(performance.now(),()=>imageControls?.anchor(event.clientX,event.clientY)??extendedControls?.anchor?.(event.clientX,event.clientY)??{x:event.clientX,y:event.clientY});
  if(!wheelFrame){wheelTime=0;queueZoomFrame(wheelEpoch)}
},{passive:false});
$('stage').addEventListener('image-pan-start',stopWheelZoom);
$('stage').addEventListener('preview-zoom-stop',stopWheelZoom);
let toolsOpen=false;new MutationObserver(()=>{const active=!!document.querySelector('dialog[open],[data-tool-open=true]');if(active!==toolsOpen){toolsOpen=active;if(desktop)void invoke('set_tool_interaction',{active})}}).observe(document.body,{attributes:true,childList:true,subtree:true,attributeFilter:['open','data-tool-open']});
emptyState();
void frame().then(()=>performance.mark('av-shell-ready'));
if(!desktop&&import.meta.env.DEV){window.addEventListener('allview-fixture',event=>{const file=(event as CustomEvent<File>).detail;void openRequest({id:(current?.id??0)+1,path:file.name},file)})}
async function initialize(){if(desktop){
  await listen('preferences-requested',showPreferences);
  await listen('startup-offer',()=>{void refreshSettings().then(showStartupOffer).catch(error=>message(String(error)))});
  await listen('find-requested',()=>{void showFind()});
  await listen<Request>('preview-request',event=>{void openRequest(event.payload)});
  await listen('preview-hidden',()=>{stopWheelZoom();imageControls?.cancelPan();extendedControls?.cancelPan?.();for(const media of document.querySelectorAll<HTMLMediaElement>('audio,video'))media.pause()});
  await listen<boolean>('listener-changed',event=>{settings.enabled=event.payload;updateListenerSetting()});
  await refreshSettings();const request=await invoke<Request|null>('current_request');if(request)void openRequest(request);showStartupOffer();
}}void initialize();
