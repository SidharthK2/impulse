// The web app and HTTP plumbing: static files with an SPA fallback, 404s for unknown API routes, and CORS.

use super::*;

pub(super) async fn not_found(method: Method, uri: Uri) -> ApiError {
    ExError::status(404, format!("no route {method} {}", uri.path())).into()
}

pub(super) async fn fallback(State(app): State<App>, method: Method, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return not_found(method, uri).await.into_response();
    }
    serve_static(app.web_dir.as_deref(), uri.path()).await
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" => "application/json",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "txt" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "webmanifest" => "application/manifest+json",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

pub(super) async fn serve_static(web_dir: Option<&std::path::Path>, path: &str) -> Response {
    let Some(root) = web_dir.filter(|d| d.is_dir()) else {
        return ([(header::CONTENT_TYPE, "text/plain")], "Impulse API is running. The web app isn't built: run `make web` (or `make dev` for the Vite dev server).")
            .into_response();
    };
    let Some(decoded) = percent_decode(path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let rel = PathBuf::from(decoded.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut file = root.join(&rel);
    if !file.is_file() {
        // A missing file (favicon.ico, an old asset) is a real 404 for crawlers and caches; any other path is an
        // app route, served by index.html (the SPA fallback). Market ids may contain dots, so only file types count.
        if rel.extension().and_then(|e| e.to_str()).is_some_and(|e| content_type(std::path::Path::new(&format!("x.{e}"))) != "application/octet-stream") {
            return StatusCode::NOT_FOUND.into_response();
        }
        file = root.join("index.html");
    }
    // Vite fingerprints everything under assets/, so it can be cached for good; index.html and the rest revalidate,
    // so a deploy shows up on the next load.
    let cache = if rel.starts_with("assets") { "public, max-age=31536000, immutable" } else { "no-cache" };
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, content_type(&file)), (header::CACHE_CONTROL, cache)], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// CORS for the API, as the TS server sends it.
pub(super) async fn cors(req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        let h = res.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET,POST,DELETE,OPTIONS"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type,authorization,x-admin-token"));
        return res;
    }
    let api = req.uri().path().starts_with("/api/");
    let mut res = next.run(req).await;
    if api {
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(root: &std::path::Path, path: &str) -> (StatusCode, String, String, String) {
        let res = serve_static(Some(root), path).await;
        let status = res.status();
        let h = |k| res.headers().get(k).map(|v: &HeaderValue| v.to_str().unwrap().to_string()).unwrap_or_default();
        let (ct, cc) = (h(header::CONTENT_TYPE), h(header::CACHE_CONTROL));
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, ct, cc, String::from_utf8_lossy(&body).into_owned())
    }

    #[tokio::test]
    async fn static_files_routes_and_missing_files() {
        let root = std::env::temp_dir().join(format!("impulse-static-{}", std::process::id()));
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<app>").unwrap();
        std::fs::write(root.join("robots.txt"), "User-agent: *").unwrap();
        std::fs::write(root.join("sitemap.xml"), "<urlset/>").unwrap();
        std::fs::write(root.join("assets/index-abc.js"), "js").unwrap();

        let (s, ct, cc, body) = get(&root, "/robots.txt").await;
        assert_eq!((s, ct.as_str(), cc.as_str(), body.as_str()), (StatusCode::OK, "text/plain; charset=utf-8", "no-cache", "User-agent: *"));
        assert_eq!(get(&root, "/sitemap.xml").await.1, "application/xml");
        let (s, _, cc, _) = get(&root, "/assets/index-abc.js").await;
        assert_eq!((s, cc.as_str()), (StatusCode::OK, "public, max-age=31536000, immutable"));
        // App routes, including market ids with dots, fall back to index.html; missing files are 404s.
        for route in ["/", "/trade/BTC-PERP", "/trade/A.B"] {
            let (s, ct, cc, body) = get(&root, route).await;
            assert_eq!((s, ct.as_str(), cc.as_str(), body.as_str()), (StatusCode::OK, "text/html; charset=utf-8", "no-cache", "<app>"), "{route}");
        }
        for missing in ["/favicon.ico", "/og.png", "/assets/old-123.js", "/nope.txt"] {
            assert_eq!(get(&root, missing).await.0, StatusCode::NOT_FOUND, "{missing}");
        }
    }
}
