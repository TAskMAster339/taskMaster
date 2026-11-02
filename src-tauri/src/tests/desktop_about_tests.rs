use super::*;
#[test]
fn about_links_allow_only_exact_public_addresses() {
    for url in [
        "https://taskmaster339.github.io/",
        "https://github.com/TAskMAster339/taskMaster",
    ] {
        assert!(validate_about_url(url).is_ok());
    }
    for url in [
        "https://evil.example/",
        "file:///C:/Windows",
        "javascript:alert(1)",
        "https://taskmaster339.github.io/?token=secret",
        "https://github.com/TAskMAster339/taskMaster/other",
    ] {
        assert!(validate_about_url(url).is_err(), "{url}");
    }
}
