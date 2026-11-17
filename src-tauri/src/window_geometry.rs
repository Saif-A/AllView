/// Logical client size. Extra height includes the title, docked toolbar and renderer controls.
pub fn fit(width:f64,height:f64,work_width:f64,work_height:f64,extra_height:f64)->Result<(f64,f64),String>{
    if ![width,height,work_width,work_height,extra_height].iter().all(|n|n.is_finite()) || width<0.0 || height<0.0 || width>1_000_000.0 || height>1_000_000.0 || extra_height<0.0 || extra_height>200.0 || work_width<=0.0 || work_height<=0.0 {
        return Err("Invalid preview dimensions.".into())
    }
    let max_w=(work_width-32.0).max(1.0).min(1440.0);
    let max_h=(work_height-32.0).max(1.0).min(1100.0);
    if width==0.0 && height==0.0{return Ok((960.0_f64.min(max_w),720.0_f64.min(max_h)))}
    if width==0.0 || height==0.0{return Err("Incomplete preview dimensions.".into())}
    let padding=16.0;
    let scale=((max_w-padding).max(1.0)/width).min((max_h-padding-extra_height).max(1.0)/height).min(1.0);
    Ok(((width*scale+padding).max(260.0).min(max_w),(height*scale+padding+extra_height).max(180.0).min(max_h)))
}
#[cfg(test)] mod tests {
    use super::fit;
    #[test] fn portrait_and_landscape_keep_intrinsic_ratio_inside_work_area(){
        for (w,h) in [(1200.0,1800.0),(2400.0,900.0),(800.0,800.0)]{
            let (x,y)=fit(w,h,1920.0,1040.0,0.0).unwrap();
            assert!(x<=1888.0 && y<=1008.0);assert!(((x-16.0)/(y-16.0)-w/h).abs()<0.001);
        }
    }
    #[test] fn small_work_areas_and_video_controls_are_bounded(){
        let (x,y)=fit(1920.0,1080.0,800.0,600.0,88.0).unwrap();assert!(x<=768.0 && y<=568.0);assert!(((x-16.0)/(y-104.0)-16.0/9.0).abs()<0.001);
        assert_eq!(fit(0.0,0.0,640.0,480.0,0.0).unwrap(),(608.0,448.0));
        assert_eq!(fit(20.0,20.0,1920.0,1080.0,0.0).unwrap(),(260.0,180.0));
    }
    #[test] fn malformed_dimensions_are_rejected(){for (w,h) in [(f64::NAN,2.0),(2.0,f64::INFINITY),(-1.0,2.0),(1_000_001.0,1.0),(0.0,100.0)]{assert!(fit(w,h,1920.0,1080.0,0.0).is_err())}}
}
