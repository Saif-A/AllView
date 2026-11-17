export interface SheetOptions {paperWidth:number;paperHeight:number;width:number;height:number;margin:number;gap:number;copies:number}
export interface Placement {x:number;y:number;width:number;height:number}
export function portraitSheets(o:SheetOptions):Placement[][] {
  for(const value of Object.values(o))if(!Number.isFinite(value)||value<0)throw new Error('Enter valid non-negative dimensions.');
  if(o.width<5||o.height<5||o.paperWidth<20||o.paperHeight<20||o.copies<1||o.copies>100||!Number.isInteger(o.copies))throw new Error('Use portrait sizes of at least 5 mm and between 1 and 100 copies.');
  const columns=Math.floor((o.paperWidth-2*o.margin+o.gap)/(o.width+o.gap));const rows=Math.floor((o.paperHeight-2*o.margin+o.gap)/(o.height+o.gap));
  if(columns<1||rows<1)throw new Error('This portrait does not fit the selected paper and margins.');
  const perPage=columns*rows;if(Math.ceil(o.copies/perPage)>20)throw new Error('Use at most 20 sheets per print layout.');const pages:Placement[][]=[];
  for(let index=0;index<o.copies;index++){const page=Math.floor(index/perPage),position=index%perPage;pages[page]??=[];pages[page].push({x:o.margin+(position%columns)*(o.width+o.gap),y:o.margin+Math.floor(position/columns)*(o.height+o.gap),width:o.width,height:o.height})}return pages;
}
