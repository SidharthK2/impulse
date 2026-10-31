// Impulse paper exchange: MicroPerps with ADL as the only backstop, live.
//
//   PORT=8787  DATA_DIR=data  WEB_DIR=web/dist  ADMIN_TOKEN=impulse-admin
//   OFFLINE=1 (no network feeds)  BOTS=0 (no house bots)  TEST_CLOCK=1 (a clock only /api/test/* moves)
//   EXIT_WITH_STDIN=1 (exit when stdin closes: for test harnesses)  TIMER_SPEEDUP=N (clock, bots and walk N× faster: tests)

mod api;
mod book;
mod bots;
mod command;
mod exchange;
mod feeds;
mod intake;
mod logging;
mod persist;
mod rng;
mod sequencer;
mod store;
mod units;
mod views;
mod ws;

use api::App;
use logging::log;
use command::Command;
use intake::IntakeClock;
use std::path::PathBuf;
use std::time::Duration;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Run `f` against the core every `ms` (divided by TIMER_SPEEDUP, a test knob), starting after one period.
fn every(app: &App, ms: u64, f: impl Fn(&mut api::Core) + Send + 'static) {
    let speedup: u64 = env("TIMER_SPEEDUP").and_then(|s| s.parse().ok()).filter(|&n| n >= 1).unwrap_or(1);
    let ms = (ms / speedup).max(1);
    let app = app.clone();
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_millis(ms));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        iv.tick().await;
        loop {
            iv.tick().await;
            f(&mut app.lock());
        }
    });
}

fn log_err<T>(what: &str, r: Result<T, exchange::ExError>) {
    if let Err(e) = r {
        log(&format!("{what}: {}", e.message()));
    }
}

fn submit(app: &App, cmd: Command) {
    let kind = cmd.kind();
    log_err(kind, app.lock().submit(cmd));
}

/// `impulse-server export-json OUT_DIR`: write DATA_DIR's exchange (latest state, rebuilt read-only) as a legacy
/// JSON snapshot, OUT_DIR/snapshot.json, the format before the database. Starting a server on a DATA_DIR holding
/// only that file imports it.
fn export_json(data_dir: &std::path::Path, args: &[String]) -> ! {
    let Some(out) = args.first() else {
        eprintln!("usage: impulse-server export-json OUT_DIR");
        std::process::exit(2)
    };
    let result = store::Store::open_read_only(data_dir)
        .and_then(|s| sequencer::rebuild(&s, false, None))
        .and_then(|(x, _, _)| persist::save(std::path::Path::new(out), &persist::serialize(&x)).map_err(|e| e.to_string()));
    match result {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("export-json: {e}");
            std::process::exit(1)
        }
    }
}

/// `impulse-server replay [--full] [--until SEQ]`: rebuild DATA_DIR's exchange from its database (read-only) and
/// print {seq, hash, replayed, ms}. From the latest snapshot by default; `--full` replays the whole journal.
fn replay(data_dir: &std::path::Path, args: &[String]) -> ! {
    let full = args.iter().any(|a| a == "--full");
    let until = args.iter().position(|a| a == "--until").and_then(|i| args.get(i + 1)).and_then(|s| s.parse().ok());
    match sequencer::replay_report(data_dir, full, until) {
        Ok(report) => {
            println!("{report}");
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("replay: {e}");
            std::process::exit(1)
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let port: u16 = env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8787);
    let data_dir = env("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| here.join("../../data"));
    let web_dir = env("WEB_DIR").map(PathBuf::from).unwrap_or_else(|| here.join("../../web/dist"));
    let admin_token = env("ADMIN_TOKEN").unwrap_or_else(|| "impulse-admin".into());
    let offline = env("OFFLINE").as_deref() == Some("1");
    let bots = env("BOTS").as_deref() != Some("0");
    let test_clock = env("TEST_CLOCK").as_deref() == Some("1");
    let clock = IntakeClock::new(test_clock);
    let cli_data_dir = || env("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| here.join("../../data"));
    match args.first().map(String::as_str) {
        Some("replay") => replay(&cli_data_dir(), &args[1..]),
        Some("export-json") => export_json(&cli_data_dir(), &args[1..]),
        _ => {}
    }
    if env("EXIT_WITH_STDIN").as_deref() == Some("1") {
        // Test harnesses: exit when the parent closes our stdin (or dies), so no server outlives its tests.
        std::thread::spawn(|| {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            std::process::exit(0);
        });
    }

    let store = match store::Store::open(&data_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot open the database in {}: {e}", data_dir.display());
            std::process::exit(1);
        }
    };
    log(&format!("database {}", store.path.display()));
    let mut core = sequencer::Core::new(bots, clock, Some(store));
    let recovery = match core.recover(&data_dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("recovery failed: {e}");
            std::process::exit(1);
        }
    };
    if let (IntakeClock::Manual(t), sequencer::Recovery::Restored { .. }) = (&mut core.clock, &recovery) {
        *t = (*t).max(core.x.now); // the test clock never runs behind the journal
    }
    let last_ts = core.x.now;
    let app = App::new(core, admin_token.clone(), Some(web_dir), test_clock);
    match recovery {
        sequencer::Recovery::Fresh => {
            submit(&app, Command::Genesis);
            log(&format!("fresh exchange; listing default markets{}…", if offline { " (offline)" } else { "" }));
            feeds::list_defaults(&app, offline).await;
            log(&format!("listed {}", app.lock().x.markets.keys().cloned().collect::<Vec<_>>().join(", ")));
        }
        sequencer::Recovery::Restored { replayed, imported } => {
            let down = app.lock().clock.now() - last_ts;
            if down > 0 {
                submit(&app, Command::Resume { down_ms: down });
            }
            let core = app.lock();
            log(&format!(
                "recovered {}: seq {}, {replayed} commands replayed; {} markets, {} accounts, engine t={}s; paused for {}s of downtime",
                if imported { "from the legacy JSON snapshot" } else { "from the database" },
                core.seq,
                core.x.markets.len(),
                core.x.accounts.len(),
                core.x.state.time,
                (down.max(0) + 500) / 1000
            ));
        }
    }
    submit(&app, Command::Clock);
    if bots {
        let setup = bots::Bots::setup(&app.lock().x);
        for cmd in setup {
            submit(&app, cmd);
        }
    }

    // The clients that run on timers: the clock, the bots, the offline walk. Each submits commands.
    every(&app, 2000, |c| log_err("clock", c.submit(Command::Clock)));
    if bots {
        every(&app, 1000, |c| {
            if !c.x.bots_enabled {
                return;
            }
            let Some(b) = c.bots.as_mut() else { return };
            for cmd in b.next_quotes(&c.x, 3) {
                log_err("bots", c.submit(cmd));
            }
        });
        every(&app, 2500, |c| {
            if !c.x.bots_enabled {
                return;
            }
            let Some(b) = c.bots.as_mut() else { return };
            let (cmds, note) = b.noise(&c.x);
            if let Some(note) = note {
                log(&note);
            }
            for cmd in cmds {
                let _ = c.submit(cmd); // a refused bot order (balance, liquidity) is part of the noise
            }
        });
    }
    let warn = feeds::Warn::default();
    {
        let warn = warn.clone();
        every(&app, 2000, move |c| feeds::step_sim(c, &warn, offline));
    }
    if !offline {
        feeds::start(&app, &warn);
    }
    every(&app, 500, ws::Hub::tick);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cannot listen on :{port}: {e}");
            std::process::exit(1);
        }
    };
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    log(&format!(
        "Impulse listening on http://localhost:{bound}  (admin token: {})",
        if admin_token == "impulse-admin" { "impulse-admin, the default" } else { "from ADMIN_TOKEN" }
    ));

    let shutdown = {
        let app = app.clone();
        async move {
            let ctrl_c = tokio::signal::ctrl_c();
            #[cfg(unix)]
            let term = async {
                if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                    s.recv().await;
                }
            };
            #[cfg(not(unix))]
            let term = std::future::pending::<()>();
            tokio::select! {
                _ = ctrl_c => {}
                _ = term => {}
            }
            log("shutting down, saving a snapshot");
            app.lock().snapshot();
            std::process::exit(0);
        }
    };
    tokio::spawn(shutdown);
    if let Err(e) = axum::serve(listener, api::router(app)).await {
        eprintln!("server error: {e}");
    }
}
