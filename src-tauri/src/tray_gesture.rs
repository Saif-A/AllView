//! Distinguish a single capture click from double-click folder access in bounded state.
#[derive(Default)]pub struct TrayGesture{generation:u64,pending:Option<(u64,u64)>,suppress_until:u64}
impl TrayGesture{
 pub fn released(&mut self,now:u64,interval:u64)->Option<(u64,u64)>{
  if now<self.suppress_until{self.suppress_until=0;return None}self.generation=self.generation.wrapping_add(1);let deadline=now.saturating_add(interval);self.pending=Some((self.generation,deadline));Some((self.generation,deadline))
 }
 pub fn double_clicked(&mut self,now:u64,interval:u64){self.cancel();self.suppress_until=now.saturating_add(interval);}
 pub fn cancel(&mut self){self.generation=self.generation.wrapping_add(1);self.pending=None;}
 pub fn pending(&self)->Option<(u64,u64)>{self.pending}
 pub fn is_current(&self,generation:u64)->bool{self.generation==generation}
 pub fn take(&mut self,generation:u64,now:u64)->bool{if self.pending.is_some_and(|(g,deadline)|g==generation&&now>=deadline){self.pending=None;true}else{false}}
}
#[cfg(test)]mod tests{
 use super::*;
 #[test]fn single_click_runs_once_only_after_the_system_interval(){let mut g=TrayGesture::default();let (token,deadline)=g.released(100,500).unwrap();assert_eq!(deadline,600);assert!(!g.take(token,599));assert!(g.take(token,600));assert!(!g.take(token,601));assert!(g.is_current(token));g.double_clicked(610,500);assert!(!g.is_current(token),"a queued capture must be invalidated before main-thread execution");}
 #[test]fn double_click_cancels_capture_and_ignores_only_the_following_mouse_up(){let mut g=TrayGesture::default();let (token,_)=g.released(100,500).unwrap();g.double_clicked(250,500);assert!(g.released(260,500).is_none());assert!(!g.take(token,600));let (next,_)=g.released(400,500).unwrap();assert!(g.take(next,900));}
 #[test]fn menu_or_a_new_gesture_cancels_obsolete_work(){let mut g=TrayGesture::default();let (old,_)=g.released(1,500).unwrap();g.cancel();assert!(!g.take(old,900));let (old,_)=g.released(1000,500).unwrap();let (next,_)=g.released(1100,500).unwrap();assert!(!g.take(old,1600));assert!(g.take(next,1600));}
}
