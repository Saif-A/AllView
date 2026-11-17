export type Point={x:number;y:number};
export type Shape={tool:string;from:Point;to:Point;points:Point[];colour:string;fill:string;filled:boolean;stroke:number;font:number;text:string;step:number};
export const MAX_SHAPES=300,MAX_POINTS=10000;
export function bounds(s:Shape){const points=s.tool==='pen'||s.tool==='freeArrow'?s.points:[s.from,s.to];let x=Infinity,y=Infinity,r=-Infinity,b=-Infinity;for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);r=Math.max(r,p.x);b=Math.max(b,p.y)}return {x,y,w:Math.max(1,r-x),h:Math.max(1,b-y)}}
export function moveShape(s:Shape,dx:number,dy:number){s.from={x:s.from.x+dx,y:s.from.y+dy};s.to={x:s.to.x+dx,y:s.to.y+dy};s.points=s.points.map(p=>({x:p.x+dx,y:p.y+dy}))}
export function resizeShape(s:Shape,to:Point){const b=bounds(s),w=Math.max(2,to.x-b.x),h=Math.max(2,to.y-b.y),map=(p:Point)=>({x:b.x+(p.x-b.x)*w/b.w,y:b.y+(p.y-b.y)*h/b.h});s.from=map(s.from);s.to=map(s.to);s.points=s.points.map(map)}
export function hitShape(s:Shape,p:Point,t=5){const b=bounds(s);return p.x>=b.x-t&&p.x<=b.x+b.w+t&&p.y>=b.y-t&&p.y<=b.y+b.h+t}
export function angleSnap(a:Point,b:Point){const l=Math.hypot(b.x-a.x,b.y-a.y),r=Math.round(Math.atan2(b.y-a.y,b.x-a.x)/(Math.PI/4))*Math.PI/4;return {x:a.x+Math.cos(r)*l,y:a.y+Math.sin(r)*l}}
