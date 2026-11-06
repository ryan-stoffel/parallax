use parallax_protocol::{DevicePlatform, DeviceStreamKind};

use super::upstream_path;

#[test]
fn streams_open_only_the_hubs_stream_routes_with_the_device_encoded() {
    let path = |platform, kind| upstream_path(platform, kind, "EC87/../x?y");
    assert_eq!(
        path(DevicePlatform::Ios, DeviceStreamKind::Video),
        "/serve-sim/helper/EC87%2F..%2Fx%3Fy/stream.avcc"
    );
    assert_eq!(
        path(DevicePlatform::Ios, DeviceStreamKind::Control),
        "/serve-sim/helper/EC87%2F..%2Fx%3Fy/ws"
    );
    assert_eq!(
        path(DevicePlatform::Android, DeviceStreamKind::Video),
        path(DevicePlatform::Android, DeviceStreamKind::Control)
    );
    assert_eq!(
        upstream_path(
            DevicePlatform::Android,
            DeviceStreamKind::Control,
            "emulator-5554"
        ),
        "/vendor/serve-emu/ws?device=emulator-5554&frame-meta=1"
    );
}
