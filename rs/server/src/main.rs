// Impulse paper exchange: MicroPerps with ADL as the only backstop, live.
//
//   PORT=8787  DATA_DIR=rs/data  WEB_DIR=web/dist  ADMIN_TOKEN=impulse-admin
//   OFFLINE=1 (no network feeds)  BOTS=0 (no house bots)  TEST_CLOCK=1 (a clock only /api/test/* moves)
//   EXIT_WITH_STDIN=1 (exit when stdin closes: for test harnesses)

mod api;
mod book;
mod bots;
mod command;
mod exchange;
mod feeds;
mod intake;
mod persist;
mod rng;
mod units;
mod views;
mod ws;

use api::{log, App};
use command::Command;
use exchange::Exchange;
use intake::{wall_ms, IntakeClock};
use std::path::PathBuf;
use std::time::Duration;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Run `f` against the core every `ms`, starting after one period.
fn every(app: &App, ms: u64, f: impl Fn(&mut api::Core) + Send + 'static) {
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

fn save(app: &App, dir: &std::path::Path) -> Option<u64> {
    let (text, version) = {
        let core = app.lock();
        (persist::serialize(&core.x), core.x.version)
    };
    match persist::save(dir, &text) {
        Ok(()) => Some(version),
        Err(e) => {
            log(&format!("snapshot failed: {e}"));
            None
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let port: u16 = env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8787);
    let data_dir = env("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| here.join("../data"));
    let web_dir = env("WEB_DIR").map(PathBuf::from).unwrap_or_else(|| here.join("../../web/dist"));
    let admin_token = env("ADMIN_TOKEN").unwrap_or_else(|| "impulse-admin".into());
    let offline = env("OFFLINE").as_deref() == Some("1");
    let bots = env("BOTS").as_deref() != Some("0");
    let test_clock = env("TEST_CLOCK").as_deref() == Some("1");
    let clock = IntakeClock::new(test_clock);
    if env("EXIT_WITH_STDIN").as_deref() == Some("1") {
        // Test harnesses: exit when the parent closes our stdin (or dies), so no server outlives its tests.
        std::thread::spawn(|| {
            let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
            std::process::exit(0);
        });
    }

    let snap = match persist::load(&data_dir) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let fresh = snap.is_none();
    let (x, down) = match snap {
        Some((x, saved_at)) => (x, saved_at.map_or(0, |t| wall_ms() - t)),
        None => (Exchange::new(0), 0),
    };
    let app = App::new(api::new_core(x, bots, clock), admin_token.clone(), Some(web_dir), test_clock);
    if fresh {
        submit(&app, Command::Genesis);
        log(&format!("fresh exchange; listing default markets{}…", if offline { " (offline)" } else { "" }));
        feeds::list_defaults(&app, offline).await;
        log(&format!("listed {}", app.lock().x.markets.keys().cloned().collect::<Vec<_>>().join(", ")));
    } else {
        submit(&app, Command::Resume { down_ms: down });
        let core = app.lock();
        log(&format!(
            "restored snapshot: {} markets, {} accounts, engine t={}s; paused for {}s of downtime",
            core.x.markets.len(),
            core.x.accounts.len(),
            core.x.state.time,
            (down + 500) / 1000
        ));
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
    {
        let app = app.clone();
        let dir = data_dir.clone();
        tokio::spawn(async move {
            let mut saved: Option<u64> = None;
            let mut iv = tokio::time::interval(Duration::from_secs(15));
            iv.tick().await;
            loop {
                iv.tick().await;
                if saved != Some(app.lock().x.version) {
                    saved = save(&app, &dir).or(saved);
                }
            }
        });
    }

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
            log("shutting down, saving snapshot");
            save(&app, &data_dir);
            std::process::exit(0);
        }
    };
    tokio::spawn(shutdown);
    if let Err(e) = axum::serve(listener, api::router(app)).await {
        eprintln!("server error: {e}");
    }
}
