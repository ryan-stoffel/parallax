use std::io::{self, Write as _};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use clap::{Args, Parser, Subcommand, ValueEnum};
use parallax_protocol::{CONNECT_PORT, RunId};
use plxd::attach::{
    self, DEFAULT_CONNECT_TIMEOUT, EXIT_UNAVAILABLE, MAX_CONNECT_TIMEOUT, Options, report,
};
use plxd::launch_agent::LaunchAgent;
use plxd::logging::{self, DEFAULT_LOG_LEVEL, LOG_LEVEL_ENV, LogFilter};
use plxd::paths::{DATA_DIR_ENV, DataDir};
use plxd::server::{self, Config, EXIT_ALREADY_RUNNING, Server, Shutdown, StartError};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use plxd::service::{self, DEFAULT_LABEL, SERVICE_LABEL_ENV};
use tracing::{error, info, warn};

#[derive(Debug, Parser)]
#[command(name = "plxd", version = plxd::version(), about = "The Parallax host daemon.")]
#[command(arg_required_else_help = true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the editor on this user's socket or pipe until SIGTERM or SIGINT (Ctrl-C or
    /// Ctrl-Break on Windows).
    Serve(ServeArgs),
    /// Connect stdin and stdout to plxd's socket or pipe, starting plxd if it isn't running.
    Attach(AttachArgs),
    /// Connect stdin and stdout to another device's plxd over Tailscale, for Parallax Connect.
    Dial(DialArgs),
    /// Turn Parallax Connect on or off. A running plxd follows within 10 seconds.
    Connect(ConnectArgs),
    /// Manage the per-user service that keeps plxd running: a `LaunchAgent` on macOS, a systemd
    /// user unit on Linux.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Service(ServiceArgs),
    /// Serve a thread's Parallax tools over MCP on stdin and stdout. plxd
    /// starts it.
    #[command(hide = true)]
    Mcp(McpArgs),
    /// Sign in to an ACP agent with one of its own sign-in methods. The app's sign-in terminal
    /// runs it.
    #[command(hide = true)]
    AcpLogin(AcpLoginArgs),
}

#[derive(Debug, Args)]
struct AcpLoginArgs {
    /// The agent's sign-in method, from its `initialize` answer
    #[arg(long, value_name = "ID")]
    method: String,

    /// The agent's command and its arguments
    #[arg(last = true, required = true, value_name = "COMMAND")]
    command: Vec<std::ffi::OsString>,
}

#[derive(Debug, Args)]
struct McpArgs {
    /// The data folder [default: ~/.parallax]
    #[arg(long, value_name = "DIR", env = DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,

    /// The thread whose Parallax tools to serve, a Project's coordinator included: the caller of
    /// every tool (0041)
    #[arg(long, value_name = "RUN_ID")]
    thread: RunId,
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// The data folder [default: ~/.parallax]
    #[arg(long, value_name = "DIR", env = DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,

    /// off, error, warn, info, debug, or trace, or a list such as plxd=debug,warn
    #[arg(long, value_name = "LEVEL", env = LOG_LEVEL_ENV, default_value = DEFAULT_LOG_LEVEL)]
    log_level: LogFilter,
}

#[derive(Debug, Args)]
struct AttachArgs {
    /// The data folder [default: ~/.parallax]
    #[arg(long, value_name = "DIR", env = DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,

    /// How long to wait for plxd to accept a connection, including starting it [default: 10]
    #[arg(long, value_name = "SECONDS", value_parser = parse_seconds)]
    connect_timeout: Option<Duration>,
}

#[derive(Debug, Args)]
struct DialArgs {
    /// The device's Tailscale IP, with port 7340 unless one is given, such as `100.87.92.42` or
    /// `[fd7a:115c:a1e0::1]:7340`
    #[arg(value_name = "ADDR", value_parser = parse_dial_address)]
    address: SocketAddr,
}

/// `dial`'s address: an IP and port, or an IP, in brackets or not, with [`CONNECT_PORT`].
fn parse_dial_address(text: &str) -> Result<SocketAddr, String> {
    if let Ok(address) = text.parse::<SocketAddr>() {
        return Ok(address);
    }
    let bare = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(text);
    bare.parse::<IpAddr>()
        .map(|ip| SocketAddr::new(ip, CONNECT_PORT))
        .map_err(|_| format!("{text:?} is not an IP address, or an IP address and port"))
}

#[derive(Debug, Args)]
struct ConnectArgs {
    /// Whether plxd listens for this user's other devices on its Tailscale address
    #[arg(value_enum)]
    state: OnOff,

    /// The data folder [default: ~/.parallax]
    #[arg(long, value_name = "DIR", env = DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum OnOff {
    On,
    Off,
}

fn parse_seconds(text: &str) -> Result<Duration, String> {
    text.parse::<f64>()
        .ok()
        .filter(|seconds| *seconds > 0.0)
        .and_then(|seconds| Duration::try_from_secs_f64(seconds).ok())
        .filter(|duration| *duration <= MAX_CONNECT_TIMEOUT)
        .ok_or_else(|| {
            format!(
                "{text:?} is not a number of seconds greater than 0 and at most {}",
                MAX_CONNECT_TIMEOUT.as_secs()
            )
        })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Args)]
struct ServiceArgs {
    #[command(subcommand)]
    command: ServiceCommand,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Subcommand)]
enum ServiceCommand {
    /// Install or update the service, then start or restart it.
    Install(InstallOptions),
    /// Stop the service if it is running, and remove it.
    Uninstall(ServiceOptions),
    /// Report whether the service is installed, loaded, and running.
    Status(ServiceOptions),
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Args)]
struct ServiceOptions {
    /// The data folder [default: ~/.parallax]
    #[arg(long, value_name = "DIR", env = DATA_DIR_ENV)]
    data_dir: Option<PathBuf>,

    /// Override the service's label. For tests: a real install never needs this.
    #[arg(long, value_name = "LABEL", env = SERVICE_LABEL_ENV, default_value = DEFAULT_LABEL, hide = true)]
    label: String,
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[derive(Debug, Args)]
struct InstallOptions {
    #[command(flatten)]
    service: ServiceOptions,

    /// Stop a plxd already serving the data folder outside the service, and hand it over to the
    /// service, instead of refusing.
    #[arg(long)]
    replace: bool,
}

fn main() -> ExitCode {
    // Before anything else, so the version is the one this process started as (see `version`).
    plxd::version();
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => serve(&args),
        Command::Attach(args) => attach(&args),
        Command::Dial(args) => dial(&args),
        Command::Connect(args) => connect(&args),
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        Command::Service(args) => service_command(args.command),
        Command::Mcp(args) => mcp(&args),
        Command::AcpLogin(args) => {
            let (program, rest) = args.command.split_first().expect("clap requires a command");
            match plxd::backend::acp::authenticate(program, rest, &args.method) {
                Ok(()) => {
                    println!("Signed in.");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("plxd acp-login: {error}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}

/// Runs `mcp` and exits with `std::process::exit`, for the same reason as [`attach`].
fn mcp(args: &McpArgs) -> ! {
    let report = |message: &dyn std::fmt::Display| {
        let _ = writeln!(io::stderr(), "plxd mcp: {message}");
    };
    let dir = DataDir::resolve(args.data_dir.as_deref());
    let (socket, data_dir) = match dir.and_then(|dir| Ok((dir.socket_path()?, dir))) {
        Ok((socket, dir)) => (socket.path, dir),
        Err(error) => {
            report(&format!("could not find plxd's socket: {error}"));
            std::process::exit(EXIT_UNAVAILABLE.into());
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            report(&format!("could not start the runtime: {error}"));
            std::process::exit(1);
        }
    };
    let (stdin, stdout) = (tokio::io::stdin(), tokio::io::stdout());
    let binding = plxd::mcp::thread::Binding {
        plxd: plxd::peer::Plxd::local(socket),
        run: args.thread,
        temp: data_dir.temp_dir(),
        data_dir,
    };
    let served = runtime.block_on(plxd::mcp::thread::run(&binding, stdin, stdout));
    if let Err(error) = served {
        report(&error);
        std::process::exit(1);
    }
    std::process::exit(0)
}

/// Runs `attach` and exits, with `std::process::exit`: the thread that reads stdin blocks until
/// input arrives, and would keep the runtime from shutting down (0007).
fn attach(args: &AttachArgs) -> ! {
    #[cfg(windows)]
    plxd::windows::stop_inheriting_handles();
    let data_dir = match DataDir::resolve(args.data_dir.as_deref()) {
        Ok(data_dir) => data_dir,
        Err(error) => unavailable(&format!("could not find the data folder: {error}")),
    };
    let program = match std::env::current_exe() {
        Ok(program) => program,
        Err(error) => unavailable(&format!("could not find plxd's own executable: {error}")),
    };
    let options = Options {
        program,
        connect_timeout: args.connect_timeout.unwrap_or(DEFAULT_CONNECT_TIMEOUT),
        launch_agent: LaunchAgent::installed_for(&data_dir),
    };
    let runtime = || match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => failed(&format!("could not start the runtime: {error}")),
    };
    // On Unix, starting plxd happens here, before the runtime exists (0023). Windows' pipe
    // client needs the runtime to connect.
    #[cfg(windows)]
    let runtime = runtime();
    #[cfg(windows)]
    let entered = runtime.enter();
    let stream = match attach::connect(&data_dir, &options) {
        Ok(stream) => stream,
        Err(error) => unavailable(&error),
    };
    #[cfg(windows)]
    drop(entered);
    #[cfg(unix)]
    let runtime = runtime();
    let code = runtime.block_on(async {
        let bridged = async {
            #[cfg(unix)]
            let stream = match stream
                .set_nonblocking(true)
                .and_then(|()| tokio::net::UnixStream::from_std(stream))
            {
                Ok(stream) => stream,
                Err(error) => failed(&format!("could not use the connection: {error}")),
            };
            match attach::bridge(tokio::io::stdin(), tokio::io::stdout(), stream).await {
                Ok(()) => 0,
                Err(error) => {
                    report(format_args!("the connection failed: {error}"));
                    1
                }
            }
        };
        // Handling SIGHUP, rather than leaving its default, also overrides an ignored SIGHUP
        // inherited from a parent such as nohup, so a dropped SSH session always ends attach.
        // On Windows, the session's end closes stdin and stdout, or kills attach with its job.
        #[cfg(unix)]
        {
            use tokio::signal::unix::{SignalKind, signal};

            let mut hangup = match signal(SignalKind::hangup()) {
                Ok(hangup) => hangup,
                Err(error) => failed(&format!("could not catch SIGHUP: {error}")),
            };
            tokio::select! {
                code = bridged => code,
                _ = hangup.recv() => 0,
            }
        }
        #[cfg(windows)]
        bridged.await
    });
    std::process::exit(code)
}

/// How long `dial` waits for the device to accept the connection.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs `dial` and exits with `std::process::exit`, for the same reason as [`attach`].
fn dial(args: &DialArgs) -> ! {
    let report = |message: &dyn std::fmt::Display| {
        let _ = writeln!(io::stderr(), "plxd dial: {message}");
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            report(&format!("could not start the runtime: {error}"));
            std::process::exit(1);
        }
    };
    let address = args.address;
    let code = runtime.block_on(async {
        let connecting = tokio::net::TcpStream::connect(address);
        let stream = match tokio::time::timeout(DIAL_TIMEOUT, connecting).await {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                report(&format!("could not connect to {address}: {error}"));
                return EXIT_UNAVAILABLE.into();
            }
            Err(_) => {
                report(&format!(
                    "nothing accepted a connection at {address} within {DIAL_TIMEOUT:?}"
                ));
                return EXIT_UNAVAILABLE.into();
            }
        };
        let _ = stream.set_nodelay(true);
        match attach::bridge_socket(tokio::io::stdin(), tokio::io::stdout(), stream).await {
            Ok(()) => 0,
            Err(error) => {
                report(&format!("the connection failed: {error}"));
                1
            }
        }
    });
    std::process::exit(code)
}

/// Stores the `connect` setting in the data folder's store, for an install script (0056).
fn connect(args: &ConnectArgs) -> ExitCode {
    let data_dir = match DataDir::resolve(args.data_dir.as_deref()) {
        Ok(data_dir) => data_dir,
        Err(error) => return fail(&format!("could not find the data folder: {error}")),
    };
    if let Err(error) = server::prepare_data_dir(data_dir.root()) {
        return fail(&error.to_string());
    }
    let on = args.state == OnOff::On;
    let stored =
        parallax_store::Store::open(data_dir.store_file()).and_then(|store| store.set_connect(on));
    if let Err(error) = stored {
        return fail(&format!("could not change the setting: {error}"));
    }
    println!("Parallax Connect is {}.", if on { "on" } else { "off" });
    ExitCode::SUCCESS
}

fn unavailable(message: &dyn std::fmt::Display) -> ! {
    report(message);
    std::process::exit(EXIT_UNAVAILABLE.into())
}

fn failed(message: &str) -> ! {
    report(message);
    std::process::exit(1)
}

fn serve(args: &ServeArgs) -> ExitCode {
    // So agent CLIs don't inherit the log, or whatever else started `serve` (0023).
    #[cfg(windows)]
    plxd::windows::stop_inheriting_handles();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => return fail(&format!("could not start the runtime: {error}")),
    };
    runtime.block_on(async {
        // Signals are caught before the socket exists, so a SIGTERM during startup still ends
        // in a clean shutdown.
        let shutdown = Shutdown::new();
        if let Err(error) = catch_signals(shutdown.clone()) {
            return fail(&format!("could not catch signals: {error}"));
        }
        let data_dir = match DataDir::resolve(args.data_dir.as_deref()) {
            Ok(data_dir) => data_dir,
            Err(error) => return fail(&format!("could not find the data folder: {error}")),
        };
        if let Err(error) = server::prepare_data_dir(data_dir.root()) {
            return fail(&error.to_string());
        }
        if let Err(error) = logging::init(&data_dir.log_file(), &args.log_level) {
            return fail(&format!(
                "could not log to {}: {error}",
                data_dir.log_file().display()
            ));
        }
        info!(log_level = %args.log_level, "starting");
        // Every path plxd uses is absolute by now. Leaving the directory it was started in
        // keeps a folder, or the volume it is on, from staying busy for as long as plxd runs.
        if let Err(error) = std::env::set_current_dir("/") {
            warn!(%error, "could not change to the root folder");
        }
        let server = match Server::start(Config::new(data_dir)) {
            Ok(server) => server,
            Err(error @ StartError::AlreadyRunning { .. }) => {
                warn!(%error, "not starting");
                eprintln!("plxd: {error}");
                return ExitCode::from(EXIT_ALREADY_RUNNING);
            }
            Err(error) => {
                error!(%error, "could not start");
                return fail(&error.to_string());
            }
        };
        match server.run(shutdown).await {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                error!(%error, "stopped with an error");
                fail(&error.to_string())
            }
        }
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn service_command(command: ServiceCommand) -> ExitCode {
    match command {
        ServiceCommand::Install(options) => service_install(&options),
        ServiceCommand::Uninstall(options) => service_uninstall(&options),
        ServiceCommand::Status(options) => service_status(&options),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn service_install(options: &InstallOptions) -> ExitCode {
    let InstallOptions {
        service: options,
        replace,
    } = options;
    let data_dir = match resolve_data_dir(options) {
        Ok(data_dir) => data_dir,
        Err(code) => return code,
    };
    match service::install(&options.label, &data_dir, *replace) {
        Ok(service::InstallOutcome::Installed) => {
            println!("installed and started {}", options.label);
            ExitCode::SUCCESS
        }
        Ok(service::InstallOutcome::Reinstalled) => {
            println!("updated and restarted {}", options.label);
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error.to_string()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn service_uninstall(options: &ServiceOptions) -> ExitCode {
    match service::uninstall(&options.label) {
        Ok(service::UninstallOutcome::Removed) => {
            println!("uninstalled {}", options.label);
            ExitCode::SUCCESS
        }
        Ok(service::UninstallOutcome::NotInstalled) => {
            println!("{} was not installed", options.label);
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error.to_string()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn service_status(options: &ServiceOptions) -> ExitCode {
    let data_dir = match resolve_data_dir(options) {
        Ok(data_dir) => data_dir,
        Err(code) => return code,
    };
    match service::status(&options.label, &data_dir) {
        Ok(status) => {
            println!("label: {}", status.label);
            println!("file: {}", status.path.display());
            println!("installed: {}", status.installed);
            println!("loaded: {}", status.state.loaded());
            println!("running: {}", status.state.running());
            println!(
                "pid: {}",
                status
                    .state
                    .pid()
                    .map_or_else(|| "-".to_owned(), |pid| pid.to_string())
            );
            println!("answers initialize: {}", status.answers_initialize);
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error.to_string()),
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn resolve_data_dir(options: &ServiceOptions) -> Result<DataDir, ExitCode> {
    DataDir::resolve(options.data_dir.as_deref())
        .map_err(|error| fail(&format!("could not find the data folder: {error}")))
}

#[cfg(unix)]
fn catch_signals(shutdown: Shutdown) -> io::Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::spawn(async move {
        loop {
            let name = tokio::select! {
                _ = terminate.recv() => "SIGTERM",
                _ = interrupt.recv() => "SIGINT",
            };
            info!(signal = name, "received a signal to stop");
            shutdown.trigger();
        }
    });
    Ok(())
}

/// Windows' equivalents of SIGTERM and SIGINT (0023). A detached `serve` has no console, so
/// only a `serve` run in one receives them.
#[cfg(windows)]
fn catch_signals(shutdown: Shutdown) -> io::Result<()> {
    use tokio::signal::windows::{ctrl_break, ctrl_c, ctrl_close, ctrl_logoff, ctrl_shutdown};

    let mut c = ctrl_c()?;
    let mut r#break = ctrl_break()?;
    let mut close = ctrl_close()?;
    let mut logoff = ctrl_logoff()?;
    let mut shutdown_event = ctrl_shutdown()?;
    tokio::spawn(async move {
        loop {
            let name = tokio::select! {
                _ = c.recv() => "Ctrl-C",
                _ = r#break.recv() => "Ctrl-Break",
                _ = close.recv() => "console close",
                _ = logoff.recv() => "logoff",
                _ = shutdown_event.recv() => "shutdown",
            };
            info!(signal = name, "received a signal to stop");
            shutdown.trigger();
        }
    });
    Ok(())
}

fn fail(message: &str) -> ExitCode {
    eprintln!("plxd: {message}");
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use clap::{CommandFactory, Parser};

    use super::{AttachArgs, Cli, Command, OnOff};

    #[test]
    fn the_command_line_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn version_is_wired_to_plxds_own_version() {
        // daemon/tests/cli.rs checks what `plxd --version` actually prints; this just checks
        // the command is wired to `plxd::version` (0006, #44), not a hardcoded string.
        assert_eq!(Cli::command().get_version(), Some(plxd::version()));
    }

    #[test]
    fn serve_takes_a_data_folder_and_a_log_level() {
        let cli = Cli::try_parse_from([
            "plxd",
            "serve",
            "--data-dir",
            "/tmp/d",
            "--log-level",
            "plxd=debug,warn",
        ])
        .unwrap();
        let Command::Serve(args) = cli.command else {
            panic!("expected serve, got {:?}", cli.command);
        };
        assert_eq!(
            args.data_dir.as_deref(),
            Some(std::path::Path::new("/tmp/d"))
        );
        assert_eq!(args.log_level.to_string(), "plxd=debug,warn");
    }

    #[test]
    fn unknown_levels_and_arguments_are_rejected() {
        assert!(Cli::try_parse_from(["plxd", "serve", "--log-level", "loud"]).is_err());
        assert!(Cli::try_parse_from(["plxd", "--bogus"]).is_err());
        assert!(Cli::try_parse_from(["plxd", "serve", "extra"]).is_err());
    }

    fn attach_args(args: &[&str]) -> Result<AttachArgs, clap::Error> {
        let cli = Cli::try_parse_from(["plxd", "attach"].iter().chain(args))?;
        let Command::Attach(args) = cli.command else {
            panic!("expected attach, got {:?}", cli.command);
        };
        Ok(args)
    }

    #[test]
    fn attach_takes_a_data_folder_and_a_timeout_in_seconds() {
        let args = attach_args(&["--data-dir", "/tmp/d", "--connect-timeout", "2.5"]).unwrap();
        assert_eq!(
            args.data_dir.as_deref(),
            Some(std::path::Path::new("/tmp/d"))
        );
        assert_eq!(args.connect_timeout, Some(Duration::from_millis(2500)));
        assert_eq!(attach_args(&[]).unwrap().connect_timeout, None);
        let longest = attach_args(&["--connect-timeout", "86400"]).unwrap();
        assert_eq!(longest.connect_timeout, Some(Duration::from_hours(24)));
    }

    #[test]
    fn attach_refuses_a_timeout_that_is_not_positive_and_extra_arguments() {
        for bad in ["0", "-1", "soon", "NaN", "inf", "1e19", "86401"] {
            assert!(attach_args(&["--connect-timeout", bad]).is_err(), "{bad}");
        }
        assert!(attach_args(&["extra"]).is_err());
    }

    #[test]
    fn dial_takes_an_ip_with_the_connect_port_unless_one_is_given() {
        let address = |text: &str| {
            let cli = Cli::try_parse_from(["plxd", "dial", text])?;
            let Command::Dial(args) = cli.command else {
                panic!("expected dial, got {:?}", cli.command);
            };
            Ok::<_, clap::Error>(args.address.to_string())
        };
        assert_eq!(address("100.87.92.42").unwrap(), "100.87.92.42:7340");
        assert_eq!(address("100.87.92.42:9").unwrap(), "100.87.92.42:9");
        assert_eq!(address("fd7a::1").unwrap(), "[fd7a::1]:7340");
        assert_eq!(address("[fd7a::1]").unwrap(), "[fd7a::1]:7340");
        assert_eq!(address("[fd7a::1]:9").unwrap(), "[fd7a::1]:9");
        for bad in ["macbook", "100.87.92.42:x", ""] {
            assert!(address(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn connect_takes_on_or_off_and_a_data_folder() {
        let cli = Cli::try_parse_from(["plxd", "connect", "on", "--data-dir", "/tmp/d"]).unwrap();
        let Command::Connect(args) = cli.command else {
            panic!("expected connect, got {:?}", cli.command);
        };
        assert_eq!(args.state, OnOff::On);
        assert_eq!(
            args.data_dir.as_deref(),
            Some(std::path::Path::new("/tmp/d"))
        );
        assert!(Cli::try_parse_from(["plxd", "connect", "maybe"]).is_err());
        assert!(Cli::try_parse_from(["plxd", "connect"]).is_err());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn service_install_takes_a_data_folder_a_label_and_replace() {
        let cli = Cli::try_parse_from([
            "plxd",
            "service",
            "install",
            "--data-dir",
            "/tmp/d",
            "--label",
            "io.example.test",
            "--replace",
        ])
        .unwrap();
        let Command::Service(service) = cli.command else {
            panic!("expected service, got {:?}", cli.command);
        };
        let super::ServiceCommand::Install(options) = service.command else {
            panic!("expected install, got {:?}", service.command);
        };
        assert_eq!(
            options.service.data_dir.as_deref(),
            Some(std::path::Path::new("/tmp/d"))
        );
        assert_eq!(options.service.label, "io.example.test");
        assert!(options.replace);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn service_status_defaults_to_the_parallax_label_with_no_data_dir_override() {
        let cli = Cli::try_parse_from(["plxd", "service", "status"]).unwrap();
        let Command::Service(service) = cli.command else {
            panic!("expected service, got {:?}", cli.command);
        };
        let super::ServiceCommand::Status(options) = service.command else {
            panic!("expected status, got {:?}", service.command);
        };
        assert_eq!(options.label, super::DEFAULT_LABEL);
        assert_eq!(options.data_dir, None);
    }

    #[test]
    fn mcp_needs_a_thread_as_a_uuidv7() {
        let thread = "01a0d390-2c3d-7e4f-9a0b-1c2d3e4f5a6b";
        let cli = Cli::try_parse_from(["plxd", "mcp", "--thread", thread]).unwrap();
        let Command::Mcp(args) = cli.command else {
            panic!("expected mcp, got {:?}", cli.command);
        };
        assert_eq!(args.thread.to_string(), thread);
        assert!(Cli::try_parse_from(["plxd", "mcp"]).is_err());
        assert!(Cli::try_parse_from(["plxd", "mcp", "--thread", "not-an-id"]).is_err());
        assert!(
            Cli::try_parse_from([
                "plxd",
                "mcp",
                "--project",
                thread,
                "--coordinator-thread",
                thread
            ])
            .is_err(),
            "the project-bound server is gone (PLX-380)"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn service_uninstall_parses_with_no_options() {
        let cli = Cli::try_parse_from(["plxd", "service", "uninstall"]).unwrap();
        let Command::Service(service) = cli.command else {
            panic!("expected service, got {:?}", cli.command);
        };
        assert!(matches!(
            service.command,
            super::ServiceCommand::Uninstall(_)
        ));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn service_without_a_subcommand_is_a_usage_error() {
        assert!(Cli::try_parse_from(["plxd", "service"]).is_err());
    }
}
