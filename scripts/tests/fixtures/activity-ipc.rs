//! Explicit local IPC fixture. The harness validates the dev PID before calling it.
use std::io::{BufRead, BufReader, Write};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let mut socket = uds_windows::UnixStream::connect(&args[1]).unwrap();
    writeln!(socket, "{}", args[2]).unwrap();
    socket.flush().unwrap();
    let mut response = String::new();
    BufReader::new(socket).read_line(&mut response).unwrap();
    print!("{response}");
}
