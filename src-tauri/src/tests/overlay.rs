use super::*;

#[test]
fn overlay_position_is_clamped_inside_the_monitor_work_area() {
    assert_eq!(
        clamp_to_monitor(900, 700, 100, 50, 800, 600, 360, 154),
        (540, 496)
    );
    assert_eq!(
        clamp_to_monitor(-500, -200, 100, 50, 800, 600, 360, 154),
        (100, 50)
    );
}

#[test]
fn overlay_timer_columns_expand_right_without_growing_beyond_two_rows() {
    assert_eq!(overlay_timer_window_size(0, 1920.0, 1000.0), (360.0, 154.0));
    assert_eq!(overlay_timer_window_size(1, 1920.0, 1000.0), (360.0, 534.0));
    assert_eq!(overlay_timer_window_size(2, 1920.0, 1000.0), (360.0, 906.0));
    assert_eq!(overlay_timer_window_size(3, 1920.0, 1000.0), (732.0, 906.0));
    assert_eq!(overlay_timer_window_size(20, 500.0, 1000.0), (500.0, 906.0));
}
