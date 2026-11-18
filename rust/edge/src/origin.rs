//! The `Origin` check: the same rule `server/websocket.js` applies, with Node's HTTP port standing in for the
//! page's port (docs/24.5 "The client stream").

/// Splits `host[:port]`, where an IPv6 host is bracketed and stays so. `None` when it is not well formed.
fn split_host_port(text: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = if text.starts_with('[') {
        let end = text.find(']')?;
        let rest = &text[end + 1..];
        let port = if rest.is_empty() {
            None
        } else {
            Some(rest.strip_prefix(':')?)
        };
        (&text[..=end], port)
    } else {
        match text.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (text, None),
        }
    };
    if host.is_empty() || (!host.starts_with('[') && host.contains(['[', ']', ':'])) {
        return None;
    }
    let port = match port {
        None => None,
        Some(digits) => Some(digits.parse::<u16>().ok()?),
    };
    Some((host, port))
}

/// Whether a session request may open: no `Origin` is allowed; otherwise its host must be the request
/// authority's host and its port `http_port`, where a missing port means 80 for http and 443 for https.
pub fn allowed(origin: Option<&str>, authority: &str, http_port: u16) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let default_port = match scheme.to_ascii_lowercase().as_str() {
        "http" => 80,
        "https" => 443,
        _ => return false,
    };
    let host_port = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host_port.contains('@') {
        return false;
    }
    let (Some((host, port)), Some((authority_host, _))) =
        (split_host_port(host_port), split_host_port(authority))
    else {
        return false;
    };
    host.eq_ignore_ascii_case(authority_host) && port.unwrap_or(default_port) == http_port
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn missing_origin_is_allowed() {
        assert!(allowed(None, "example.com:4433", 3000));
    }

    #[test]
    fn same_host_and_http_port_is_allowed() {
        assert!(allowed(
            Some("http://example.com:3000"),
            "example.com:4433",
            3000
        ));
        assert!(allowed(
            Some("http://EXAMPLE.com:3000/"),
            "example.com:4433",
            3000
        ));
    }

    #[test]
    fn other_host_or_port_is_refused() {
        assert!(!allowed(
            Some("http://example.com:3001"),
            "example.com:4433",
            3000
        ));
        assert!(!allowed(
            Some("http://evil.test:3000"),
            "example.com:4433",
            3000
        ));
        assert!(!allowed(
            Some("http://example.com:4433"),
            "example.com:4433",
            3000
        ));
        assert!(!allowed(Some("null"), "example.com:4433", 3000));
        assert!(!allowed(
            Some("ftp://example.com:3000"),
            "example.com:4433",
            3000
        ));
        assert!(!allowed(
            Some("http://a@example.com:3000"),
            "example.com:4433",
            3000
        ));
    }

    #[test]
    fn a_missing_origin_port_is_the_scheme_default() {
        assert!(allowed(Some("http://example.com"), "example.com:4433", 80));
        assert!(allowed(
            Some("https://example.com"),
            "example.com:4433",
            443
        ));
        assert!(!allowed(
            Some("https://example.com"),
            "example.com:4433",
            80
        ));
        assert!(!allowed(
            Some("http://example.com"),
            "example.com:4433",
            3000
        ));
    }

    #[test]
    fn ipv6_authorities_keep_their_brackets() {
        assert!(allowed(Some("http://[::1]:3000"), "[::1]:4433", 3000));
        assert!(allowed(Some("http://[::1]"), "[::1]:4433", 80));
        assert!(!allowed(Some("http://[::2]:3000"), "[::1]:4433", 3000));
        assert!(!allowed(Some("http://[::1:3000"), "[::1]:4433", 3000));
        assert!(!allowed(Some("http://::1:3000"), "[::1]:4433", 3000));
    }
}
