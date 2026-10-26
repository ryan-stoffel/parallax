use super::FakeBackend;
use crate::backend::process::{Environment, Launcher};
use crate::paths::DataDir;

/// A release build must refuse to start when [`super::SCRIPT_ENV`] names a script, rather than
/// run whatever shell program the script compiles to.
#[cfg(not(feature = "fake-backend"))]
#[test]
fn a_build_without_the_feature_refuses_a_script() {
    let launcher = Launcher::new(
        DataDir::new("/tmp/plxd-fake-data").unwrap(),
        Environment::empty(),
    );
    let script = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/backend/fake/fixtures/hang.json"
    );
    assert!(FakeBackend::from_script_path(Some(script.as_ref()), &launcher).is_err());
    assert!(
        FakeBackend::from_script_path(None, &launcher)
            .unwrap()
            .is_none()
    );
}
