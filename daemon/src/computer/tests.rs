use super::{
    App, Info, always_allowed, blocked, find, line, parse_apps, parse_key, save_allowed, shown,
};

const LSAPPINFO: &str = r#" 1) "loginwindow" ASN:0x0-0x2002:
    bundleID="com.apple.loginwindow"
    pid = 429 token=[sess=100020 pid=429] type="UIElement" flavor=3
 2) "universalaccessd" ASN:0x0-0xa00a:
    bundleID=[ NULL ]
    pid = 648 token=[sess=100020 pid=648] !signalled type="BackgroundOnly" flavor=3
 3) "Notes" ASN:0x0-0x1d01d:
    bundleID="com.apple.Notes"
    bundle path="/System/Applications/Notes.app"
    pid = 812 token=[sess=100020 pid=812] type="Foreground" flavor=3 Version="4.11"
 4) "Parallax (Nightly)" ASN:0x0-0x80080:
    bundleID="dev.parallax.desktop.nightly"
    pid = 3781 token=[sess=100020 pid=3781] type="Foreground" flavor=3
"#;

#[test]
fn only_dock_apps_are_listed_with_their_bundle_ids() {
    let apps = parse_apps(LSAPPINFO);
    let notes = App {
        name: "Notes".to_owned(),
        bundle_id: "com.apple.Notes".to_owned(),
        pid: 812,
    };
    assert_eq!(apps.len(), 2);
    assert_eq!(apps[0], notes);
    assert_eq!(find(&apps, "notes"), Some(&notes));
    assert_eq!(find(&apps, "com.apple.notes"), Some(&notes));
    assert_eq!(find(&apps, "Notes.app"), Some(&notes));
    assert_eq!(find(&apps, "Mail"), None);
}

#[test]
fn terminals_parallax_and_the_keychain_are_blocked() {
    assert_eq!(blocked("com.apple.Terminal"), Some("a terminal"));
    assert_eq!(blocked("com.mitchellh.ghostty"), Some("a terminal"));
    assert_eq!(
        blocked("dev.parallax.desktop.nightly"),
        Some("Parallax itself")
    );
    assert_eq!(blocked("com.apple.keychainaccess"), Some("the keychain"));
    assert_eq!(blocked("com.apple.Notes"), None);
}

#[test]
fn keys_parse_in_xdotool_style_with_modifiers() {
    assert_eq!(parse_key("Return"), Ok((36, 0)));
    assert_eq!(parse_key("super+c"), Ok((8, 0x10_0000)));
    assert_eq!(parse_key("cmd+shift+4"), Ok((21, 0x10_0000 | 0x2_0000)));
    assert_eq!(
        parse_key("ctrl+alt+Page_Down"),
        Ok((121, 0x4_0000 | 0x8_0000))
    );
    assert_eq!(parse_key("F5"), Ok((96, 0)));
    assert_eq!(parse_key("cmd++"), Ok((24, 0x10_0000)));
    assert!(parse_key("hyper+x").unwrap_err().contains("modifier"));
    assert!(parse_key("cmd+").is_err());
    assert!(parse_key("Launchpad").unwrap_err().contains("key name"));
}

#[test]
fn a_line_names_the_element_its_value_its_state_and_its_other_actions() {
    let field = Info {
        role: "AXTextField".to_owned(),
        kind: "search text field".to_owned(),
        placeholder: "Search".to_owned(),
        focused: true,
        actions: vec!["AXPress".to_owned(), "AXShowMenu".to_owned()],
        ..Info::default()
    };
    assert_eq!(
        line(3, 2, &field),
        "    3 search text field, placeholder: \"Search\" (focused). Secondary actions: ShowMenu"
    );
    let note = Info {
        role: "AXTextArea".to_owned(),
        value: "Groceries\nmilk \"oat\"".to_owned(),
        enabled: false,
        ..Info::default()
    };
    assert_eq!(
        line(0, 0, &note),
        "0 TextArea, value: \"Groceries\\nmilk \\\"oat\\\"\" (disabled)"
    );
}

#[test]
fn empty_containers_are_left_out_of_the_tree() {
    let group = Info {
        role: "AXGroup".to_owned(),
        actions: vec!["AXShowMenu".to_owned()],
        ..Info::default()
    };
    assert!(!shown(&group));
    assert!(shown(&Info {
        title: "Sidebar".to_owned(),
        ..group.clone()
    }));
    assert!(shown(&Info {
        role: "AXButton".to_owned(),
        ..Info::default()
    }));
}

#[test]
fn always_allowed_apps_save_sorted_without_repeats() {
    let dir = tempfile::tempdir().unwrap();
    assert!(always_allowed(dir.path()).is_empty());
    let apps = ["Xcode", "notes", "Notes"].map(str::to_owned).to_vec();
    assert_eq!(save_allowed(dir.path(), apps).unwrap(), ["notes", "Xcode"]);
    assert_eq!(always_allowed(dir.path()), ["notes", "Xcode"]);
}
