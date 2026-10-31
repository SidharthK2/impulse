// The server's log: one timestamped line on stdout per event.

/// One timestamped line on stdout. Write errors are ignored: a closed pipe must not take the server down.
pub fn log(s: &str) {
    use std::io::Write;
    let t = crate::feeds::iso_utc(crate::intake::wall_ms());
    let _ = writeln!(std::io::stdout(), "[{}] {s}", &t[11..19]);
}
