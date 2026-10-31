// Request plumbing: the error type and the extractors for the signed-in user, the admin token and JSON bodies.

use super::*;

pub struct ApiError(ExError);

impl From<ExError> for ApiError {
    fn from(e: ExError) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self.0 {
            ExError::Http(s, m) => (StatusCode::from_u16(s).unwrap_or(StatusCode::BAD_REQUEST), m),
            ExError::Internal(m) => {
                log(&format!("500: {m}"));
                (StatusCode::INTERNAL_SERVER_ERROR, m)
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

/// The signed-in account.
pub struct User(pub String);

impl FromRequestParts<App> for User {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        let key = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).filter(|k| !k.is_empty());
        let account = key.and_then(|k| app.lock().x.account_by_key(k).map(|a| a.id.clone()));
        account.map(User).ok_or_else(|| ExError::status(401, "sign in first (missing or unknown API key)").into())
    }
}

pub struct Admin;

impl FromRequestParts<App> for Admin {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        match parts.headers.get("x-admin-token") {
            Some(t) if t.as_bytes() == app.admin_token.as_bytes() => Ok(Admin),
            _ => Err(ExError::status(403, "admin token required").into()),
        }
    }
}

/// A JSON object body with the TS server's loose field rules: anything that isn't an object reads as `{}`.
pub struct Body(pub(super) Map<String, Value>);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = ApiError;
    async fn from_request(req: Request, _: &S) -> Result<Self, ApiError> {
        if req.method() == Method::GET || req.method() == Method::HEAD {
            return Ok(Body(Map::new()));
        }
        let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024).await.map_err(|_| ExError::status(413, "body too large"))?;
        if bytes.is_empty() {
            return Ok(Body(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(m)) => Ok(Body(m)),
            Ok(_) => Ok(Body(Map::new())),
            Err(_) => Err(ExError::bad("body must be JSON").into()),
        }
    }
}

/// JS Number(v).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

impl Body {
    /// A required string field; numbers are accepted and read as their decimal text.
    pub(super) fn str(&self, name: &str) -> Result<String, ExError> {
        match self.0.get(name) {
            Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
            Some(Value::Number(n)) => Ok(n.as_i64().map_or_else(|| n.as_f64().unwrap_or(0.0).to_string(), |i| i.to_string())),
            _ => Err(ExError::bad(format!("{name} is required"))),
        }
    }

    /// A string field, if present and non-empty.
    pub(super) fn opt_str(&self, name: &str) -> Option<String> {
        match self.0.get(name) {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    }

    /// undefined, null and "" are absent; anything else goes through Number().
    pub(super) fn num(&self, name: &str) -> Option<f64> {
        match self.0.get(name) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(v) => Some(js_number(v)),
        }
    }

    /// JS truthiness.
    pub(super) fn truthy(&self, name: &str) -> bool {
        match self.0.get(name) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }

    /// A truthy field as a number (`b.x && Number(b.x)`).
    pub(super) fn truthy_num(&self, name: &str) -> Option<f64> {
        self.truthy(name).then(|| js_number(&self.0[name]))
    }
}
