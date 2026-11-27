//! The network edge's command line (#1095, docs/24.5, docs/27).

use std::path::PathBuf;
use std::process::ExitCode;

use last_exit_edge::{Config, run};

const USAGE: &str = "usage: last-exit-edge --link HOST:PORT [--bind IP] [--lan] [--port UDP_PORT] [--ws-port TCP_PORT] [--cert PEM --key PEM]";

fn parse(args: impl Iterator<Item = String>) -> Result<Config, String> {
    let mut link = None;
    let mut bind = std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
    let mut port = 4433u16;
    let mut ws_port = 4434u16;
    let mut cert = None;
    let mut key = None;
    let mut args = args;
    while let Some(flag) = args.next() {
        let mut value = || args.next().ok_or(format!("{flag} needs a value"));
        match flag.as_str() {
            "--link" => link = Some(value()?),
            "--bind" => {
                bind = value()?
                    .parse()
                    .map_err(|_| "--bind is not an IP address".to_string())?
            }
            "--lan" => bind = std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED),
            "--port" => {
                port = value()?
                    .parse()
                    .map_err(|_| "--port is not a UDP port".to_string())?
            }
            "--ws-port" => {
                ws_port = value()?
                    .parse()
                    .map_err(|_| "--ws-port is not a TCP port".to_string())?
            }
            "--cert" => cert = Some(PathBuf::from(value()?)),
            "--key" => key = Some(PathBuf::from(value()?)),
            _ => return Err(format!("unknown argument {flag}")),
        }
    }
    let mut config = Config::new(link.ok_or("--link is required")?);
    config.bind = bind;
    config.port = port;
    config.ws_port = ws_port;
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
        use std::net::{IpAddr, Ipv4Addr};
        let config = parse(args(&[
            "--link",
            "127.0.0.1:9",
            "--port",
            "0",
            "--ws-port",
            "0",
        ]))
        .unwrap();
        assert_eq!(
            (
                config.link.as_str(),
                config.bind,
                config.port,
                config.ws_port
            ),
            ("127.0.0.1:9", IpAddr::V4(Ipv4Addr::LOCALHOST), 0, 0)
        );
        assert!(config.identity.is_none());
        assert_eq!(
            parse(args(&["--link", "127.0.0.1:9", "--lan"]))
                .unwrap()
                .bind,
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        );
        assert_eq!(
            parse(args(&["--link", "127.0.0.1:9", "--bind", "::1"]))
                .unwrap()
                .bind,
            "::1".parse::<IpAddr>().unwrap()
        );
        assert!(parse(args(&["--port", "1"])).is_err());
        assert!(parse(args(&["--link", "a:1", "--bind", "not-an-ip"])).is_err());
        assert!(parse(args(&["--link", "a:1", "--cert", "c"])).is_err());
        assert!(parse(args(&["--link", "a:1", "--bogus"])).is_err());
    }
}
