import {readPreference} from './identity.ts';
export const sidebarPreferenceKey='allview.sidebar';
export type SidebarTab='contents'|'search'|'pages'|'info';
export interface SidebarPreference{remember:boolean;open:boolean;tab:SidebarTab}
export function decodeSidebarPreference(raw:string|null):SidebarPreference{
 const fallback:SidebarPreference={remember:true,open:false,tab:'contents'};
 try{const value=JSON.parse(raw??'null');if(!value||typeof value!=='object')return fallback;
  return {remember:typeof value.remember==='boolean'?value.remember:true,open:value.open===true,tab:['contents','search','pages','info'].includes(value.tab)?value.tab:'contents'};
 }catch{return fallback}
}
export function sidebarPreference(storage:Pick<Storage,'getItem'|'setItem'>){
 let value:SidebarPreference;try{value=decodeSidebarPreference(readPreference(storage,sidebarPreferenceKey))}catch{value=decodeSidebarPreference(null)}
 const save=()=>{try{storage.setItem(sidebarPreferenceKey,JSON.stringify(value));return true}catch{return false}};
 return {get value(){return {...value}},remember(enabled:boolean){value.remember=enabled;return save()},record(open:boolean,tab:string){if(!value.remember)return;if(!['contents','search','pages','info'].includes(tab))return;value={...value,open,tab:tab as SidebarTab};save()}};
}
