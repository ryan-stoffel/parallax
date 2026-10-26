use super::read_file;

#[test]
fn parallax_json_takes_t3_json_s_shape_and_reports_a_bad_file() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("parallax.json");
    assert_eq!(read_file(&file), Ok(Vec::new()));

    std::fs::write(
        &file,
        r#"{
          "$schema": "https://t3.codes/schema/t3.json",
          "iconPath": "logo.svg",
          "scripts": [
            {"name": "Setup", "command": "pnpm install", "icon": "configure",
             "runOnWorktreeCreate": true, "async": false},
            {"name": "Clean", "command": "rm -rf dist", "runOnSettle": true,
             "previewUrl": "http://localhost:3000"}
          ]
        }"#,
    )
    .unwrap();
    let scripts = read_file(&file).unwrap();
    assert_eq!(scripts[0].id, "setup");
    assert!(scripts[0].run_on_worktree_create);
    assert_eq!(scripts[0].run_async, Some(false));
    assert!(scripts[1].run_on_settle);

    std::fs::write(&file, r#"{"scripts": [{"name": "No command"}]}"#).unwrap();
    assert!(read_file(&file).unwrap_err().starts_with("parallax.json: "));
}
