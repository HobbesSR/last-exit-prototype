//! The network edge's command line (#1095, docs/24.5, docs/27).

use std::path::PathBuf;
use std::process::ExitCode;

use last_exit_edge::{Config, run};

const USAGE: &str =
    "usage: last-exit-edge --link HOST:PORT [--port UDP_PORT] [--cert PEM --key PEM]";

fn parse(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut link = None;
    let mut port = 4433u16;
    let mut cert = None;
    let mut key = None;
    let mut args = args;
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--link" => link = Some(value()?),
            "--port" => {
                port = value()?
                    .parse()
                    .map_err(|_| "--port is not a UDP port".to_string())?
            }
            "--cert" => cert = Some(PathBuf::from(value()?)),
            "--key" => key = Some(PathBuf::from(value()?)),
            _ => return Err(format!("unknown argument {flag}")),
        }
    }
    let mut config = Config::new(link.ok_or("--link is required")?);
    config.port = port;
    config.identity = match (cert, key) {
        (Some(cert), Some(key)) => Some((cert, key)),
        (None, None) => None,
        _ => return Err("--cert and --key go together".to_string()),
    };
    Ok(config)
}

#[tokio::main]
async fn main() -> ExitCode {
    let config = match parse(std::env::args().skip(1)) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("last-exit-edge: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match run(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("last-exit-edge: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parses_the_flags() {
        let config = parse(args(&["--link", "127.0.0.1:9", "--port", "0"])).unwrap();
        assert_eq!((config.link.as_str(), config.port), ("127.0.0.1:9", 0));
        assert!(config.identity.is_none());
        assert!(parse(args(&["--port", "1"])).is_err());
        assert!(parse(args(&["--link", "a:1", "--cert", "c"])).is_err());
        assert!(parse(args(&["--link", "a:1", "--bogus"])).is_err());
    }
}
