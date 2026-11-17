/** Normalize mouse/trackpad input into bounded notches without queuing work. */
export function createMediaWheel() {
  let remainder=0,last=0,previous='';
  return {
    reset(){remainder=0;last=0;previous=''},
    steps(target:'seek'|'volume',delta:number,mode:number,now:number){
      if(!Number.isFinite(delta)||delta===0||!Number.isFinite(now)||![0,1,2].includes(mode))return 0;
      const units=-delta/(mode===1?3:mode===2?1:100);
      if(target!==previous||now-last>=400||Math.sign(units)!==Math.sign(remainder))remainder=0;
      previous=target;last=now;remainder+=Math.max(-4,Math.min(4,units));
      const steps=Math.trunc(remainder+Math.sign(remainder)*1e-9);remainder-=steps;if(Math.abs(remainder)<1e-9)remainder=0;return steps||0;
    }
  };
}
