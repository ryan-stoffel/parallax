//! Writes the desktop app's TypeScript types, generated from the protocol types, to
//! `parallax_protocol::typescript::PATH` in the repository.

use std::path::Path;
use std::process::ExitCode;
use std::{fs, io};

use parallax_protocol::typescript;

fn main() -> ExitCode {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(typescript::PATH);
    match write(&path) {
        Ok(()) => {
            println!("Wrote {}", typescript::PATH);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("Could not write {}: {error}", path.display());
            ExitCode::FAILURE
        }
    }
}

fn write(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, typescript::generate())
}
