use super::*;
#[test]
fn startup_command_quotes_paths_with_spaces() {
    assert_eq!(
        startup_command(std::path::Path::new(
            r"C:\Program Files\taskMaster\taskmaster.exe"
        )),
        r#""C:\Program Files\taskMaster\taskmaster.exe""#
    );
}
