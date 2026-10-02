//! Generates the desktop app's TypeScript types from this crate's types, with ts-rs.
//!
//! The output is one file with no imports, committed at [`PATH`] (decision record 0022). It holds
//! the constants, the method maps (`ParallaxRequests` and `ParallaxNotifications`), and every type they
//! reach. The JSON-RPC envelope is not generated.
//!
//! After changing a type, run [`COMMAND`] and commit the result. A test in `cargo test` fails
//! while the committed file differs from what [`generate`] returns.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use ts_rs::{Config, TS, TypeVisitor};

use crate::framing::MAX_FRAME_BYTES;
use crate::jsonrpc::CODES;
use crate::methods::{self, NotificationMethod, RequestMethod};
use crate::{ErrorData, IncompatibleProtocolDetail, PROTOCOL_VERSION};

/// Where the generated file goes, relative to the repository root.
pub const PATH: &str = "apps/desktop/src/protocol/generated/protocol.ts";

/// The command that regenerates the file at [`PATH`].
pub const COMMAND: &str = "cargo run -p parallax-protocol --bin generate-typescript";

/// Generates the contents of the file at [`PATH`].
///
/// # Panics
///
/// If two different types would get the same TypeScript name.
#[must_use]
pub fn generate() -> String {
    let config = Config::default().with_large_int("number");
    let mut generator = Generator {
        config: &config,
        types: BTreeMap::new(),
        roots: Vec::new(),
        requests: String::new(),
        notifications: String::new(),
    };
    methods::visit(&mut generator);
    generator.root::<ErrorData>();
    generator.root::<IncompatibleProtocolDetail>();

    let mut declarations = String::new();
    let mut emitted = BTreeSet::new();
    for name in generator.roots.iter().chain(generator.types.keys()) {
        generator.emit(name, &mut emitted, &mut declarations);
    }

    let mut out = format!(
        "// Generated from crates/parallax-protocol by `{COMMAND}`. Do not edit.\n\
         //\n\
         // The messages of the protocol between clients and plxd (decision record 0007), without\n\
         // the JSON-RPC 2.0 envelope around them.\n\
         \n\
         /** The newest protocol version these types describe. */\n\
         export const PROTOCOL_VERSION = {PROTOCOL_VERSION};\n\
         \n\
         /** The largest frame either side sends or accepts: 8 MiB, not counting the line ending. */\n\
         export const MAX_FRAME_BYTES = {MAX_FRAME_BYTES};\n\
         \n\
         /** JSON-RPC error codes. A `ParallaxError`'s `data` is an `ErrorData`. */\n\
         export const ErrorCodes = {{\n"
    );
    for (name, code) in CODES {
        writeln!(out, "\t{name}: {code},").unwrap();
    }
    write!(
        out,
        "}} as const;\n\
         \n\
         /** Requests, which the client sends and plxd answers, by method. */\n\
         export type ParallaxRequests = {{\n{}}};\n\
         \n\
         /** Notifications, which get no response, by method. */\n\
         export type ParallaxNotifications = {{\n{}}};\n\
         \n\
         {}",
        generator.requests, generator.notifications, declarations
    )
    .unwrap();
    out.truncate(out.trim_end().len());
    out.push('\n');
    out
}

// ts-rs visits a type's dependencies in an order that changes from one build to the next, so the
// generator collects every declaration first. The output order then comes only from the method
// table and from type names: each root in table order, then the types it uses, depth first and
// in name order.
struct Generator<'a> {
    config: &'a Config,
    types: BTreeMap<String, Declaration>,
    roots: Vec<String>,
    requests: String,
    notifications: String,
}

struct Declaration {
    docs: Option<String>,
    code: String,
    dependencies: BTreeSet<String>,
}

impl Generator<'_> {
    fn root<T: TS + 'static + ?Sized>(&mut self) {
        self.visit::<T>();
        self.roots.push(T::ident(self.config));
    }

    fn emit(&self, name: &str, emitted: &mut BTreeSet<String>, out: &mut String) {
        let Some(declaration) = self.types.get(name) else {
            return;
        };
        if !emitted.insert(name.to_owned()) {
            return;
        }
        if let Some(docs) = &declaration.docs {
            out.push_str(docs);
        }
        writeln!(out, "export {}\n", tidy(&declaration.code)).unwrap();
        for dependency in &declaration.dependencies {
            self.emit(dependency, emitted, out);
        }
    }
}

impl TypeVisitor for Generator<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() {
            return;
        }
        let name = T::ident(self.config);
        let code = T::decl(self.config);
        if let Some(existing) = self.types.get(&name) {
            assert_eq!(
                existing.code, code,
                "two types would be named {name} in TypeScript"
            );
            return;
        }
        let dependencies = T::dependencies(self.config)
            .into_iter()
            .map(|dependency| dependency.ts_name)
            .filter(|dependency| *dependency != name)
            .collect();
        self.types.insert(
            name,
            Declaration {
                docs: T::docs(),
                code,
                dependencies,
            },
        );
        T::visit_dependencies(self);
    }
}

// ts-rs writes a declaration on one line, except that each documented field starts a new line
// with its doc comment. This indents those lines and drops trailing spaces. Only whitespace
// changes, so the TypeScript means the same.
fn tidy(declaration: &str) -> String {
    let mut out = String::new();
    for (index, line) in declaration.lines().enumerate() {
        if index > 0 {
            out.push_str("\n\t");
        }
        out.push_str(line.trim_end());
    }
    if out.contains('\n')
        && let Some(fields) = out.strip_suffix(" };")
    {
        out = format!("{fields}\n}};");
    }
    out
}

impl methods::Visitor for Generator<'_> {
    fn request<M: RequestMethod>(&mut self, docs: &[&str]) {
        self.root::<M::Params>();
        self.root::<M::Result>();
        write_docs(&mut self.requests, docs);
        writeln!(
            self.requests,
            "\t\"{}\": {{ params: {}, result: {} }},",
            M::NAME,
            M::Params::name(self.config),
            M::Result::name(self.config)
        )
        .unwrap();
    }

    fn notification<N: NotificationMethod>(&mut self, docs: &[&str]) {
        self.root::<N::Params>();
        write_docs(&mut self.notifications, docs);
        writeln!(
            self.notifications,
            "\t\"{}\": {},",
            N::NAME,
            N::Params::name(self.config)
        )
        .unwrap();
    }
}

fn write_docs(out: &mut String, docs: &[&str]) {
    out.push_str("\t/**\n");
    for line in docs {
        writeln!(out, "\t *{line}").unwrap();
    }
    out.push_str("\t */\n");
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::{COMMAND, PATH, generate};

    #[test]
    fn committed_typescript_is_current() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(PATH);
        let Ok(committed) = fs::read_to_string(&path) else {
            panic!("{PATH} is missing. Run `{COMMAND}` and commit the result.");
        };
        let generated = generate();
        if committed != generated {
            let line = committed
                .lines()
                .zip(generated.lines())
                .position(|(a, b)| a != b)
                .unwrap_or_else(|| committed.lines().count().min(generated.lines().count()));
            panic!(
                "{PATH} is stale: from line {} on, it differs from the TypeScript that the \
                 protocol types generate. Run `{COMMAND}` and commit the result.",
                line + 1
            );
        }
    }

    #[test]
    fn large_integers_are_numbers_and_fallback_variants_are_left_out() {
        let generated = generate();
        assert!(!generated.contains("bigint"));
        assert!(!generated.contains("\"unknown\""));
    }
}
