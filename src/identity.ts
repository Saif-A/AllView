// Read old preferences once, without overwriting a choice made under the new name.
type PreferenceStorage=Pick<Storage,'getItem'|'setItem'>&Partial<Pick<Storage,'removeItem'>>;
const legacyKeys:Record<string,string>={'allview.theme':'quickview.theme','allview.sidebar':'quickview.sidebar'};
export function readPreference(storage:PreferenceStorage,key:string):string|null{
 const current=storage.getItem(key);if(current!==null)return current;
 const legacy=legacyKeys[key];if(!legacy)return null;
 const value=storage.getItem(legacy);if(value===null)return null;
 try{storage.setItem(key,value);storage.removeItem?.(legacy)}catch{/* Retain the readable value if storage is unavailable. */}
 return value;
}
