//! The network edge (#1095, docs/24.5, docs/27). A placeholder that proves the build: it prints its
//! name and version and exits.

fn banner() -> String {
    format!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}

fn main() {
    println!("{}", banner());
}

#[cfg(test)]
mod tests {
    #[test]
    fn banner_names_the_binary() {
        assert!(super::banner().starts_with("last-exit-edge "));
    }
}
