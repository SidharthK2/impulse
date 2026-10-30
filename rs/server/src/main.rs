// Impulse paper exchange: MicroPerps with ADL as the only backstop, live.
//
//   PORT=8787  DATA_DIR=rs/data  WEB_DIR=web/dist  ADMIN_TOKEN=impulse-admin
//   OFFLINE=1 (no network feeds)  BOTS=0 (no house bots)  TEST_CLOCK=1 (a clock only /api/test/* moves)

mod api;
mod book;
mod bots;
mod exchange;
mod feeds;
mod persist;
mod rng;
mod units;
mod views;
mod ws;

use api::{log, App};
use exchange::{wall_ms, Exchange};
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
    let clock = api::test_clock(test_clock);

    let snap = match persist::load(&data_dir, clock) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let fresh = snap.is_none();
    let x = match snap {
        Some((mut x, saved_at)) => {
            let down = saved_at.map_or(0, |t| wall_ms() - t);
            x.resume_after(down);
            log(&format!(
                "restored snapshot: {} markets, {} accounts, engine t={}s; paused for {}s of downtime",
                x.markets.len(),
                x.accounts.len(),
                x.state.time,
                (down + 500) / 1000
            ));
            x
        }
        None => Exchange::new(clock),
    };
    let app = App::new(api::new_core(x, bots), admin_token.clone(), Some(web_dir), test_clock);
    if fresh {
        log(&format!("fresh exchange; listing default markets{}…", if offline { " (offline)" } else { "" }));
        feeds::list_defaults(&app, offline).await;
        log(&format!("listed {}", app.lock().x.markets.keys().cloned().collect::<Vec<_>>().join(", ")));
    }
    {
        let mut core = app.lock();
        if let Err(e) = core.x.clock() {
            log(&format!("clock: {}", e.message()));
        }
        let api::Core { x, bots, .. } = &mut *core;
        if let Some(b) = bots {
            b.ensure_accounts(x);
        }
    }

    // The core's clocks: engine time, bots, the offline walk, websocket pushes, snapshots.
    every(&app, 2000, |c| {
        if let Err(e) = c.x.clock() {
            log(&format!("clock: {}", e.message()));
        }
    });
    if bots {
        every(&app, 1000, |c| {
            let api::Core { x, bots, .. } = c;
            if let Some(b) = bots.as_mut().filter(|b| b.enabled) {
                b.requote_some(x, 3);
            }
        });
        every(&app, 2500, |c| {
            let api::Core { x, bots, .. } = c;
            if let Some(b) = bots.as_mut().filter(|b| b.enabled) {
                b.noise(x, log);
            }
        });
    }
    let warn = feeds::Warn::default();
    {
        let warn = warn.clone();
        every(&app, 2000, move |c| feeds::step_sim(&mut c.x, &mut c.sim, &warn, offline));
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
