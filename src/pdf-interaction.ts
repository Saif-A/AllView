/** One page per wheel gesture, with no trailing queue from a trackpad burst. */
export function createPageWheel(){let amount=0,last=-Infinity,seen=-Infinity,direction=0;return {reset(){amount=0;last=seen=-Infinity;direction=0},step(delta:number,mode:number,height:number,now:number):-1|0|1{
 if(!Number.isFinite(delta)||!Number.isFinite(now)||!delta||mode<0||mode>2)return 0;if(now-seen>400)amount=0;seen=now;const sign=Math.sign(delta);if(sign!==direction){amount=0;direction=sign}
 if(now-last<280)return 0;amount+=delta*(mode===1?16:mode===2?Math.max(1,height):1);if(Math.abs(amount)<60)return 0;amount=0;last=now;return sign as -1|1;
 }};}
