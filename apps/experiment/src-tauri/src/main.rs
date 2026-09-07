#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--self-test") {
        if let Err(error) = reconnect_experiment_lib::portable_self_test() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    reconnect_experiment_lib::run()
}
