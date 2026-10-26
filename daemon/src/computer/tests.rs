use super::blocked;

#[test]
fn terminals_parallax_and_the_keychain_are_blocked() {
    assert_eq!(blocked("com.apple.Terminal"), Some("a terminal"));
    assert_eq!(blocked("com.mitchellh.ghostty"), Some("a terminal"));
    assert_eq!(
        blocked("dev.parallax.desktop.nightly"),
        Some("Parallax itself")
    );
    assert_eq!(blocked("com.apple.keychainaccess"), Some("the keychain"));
    assert_eq!(blocked("com.apple.ScriptEditor2"), Some("a script runner"));
    assert_eq!(blocked("com.apple.Notes"), None);
}
