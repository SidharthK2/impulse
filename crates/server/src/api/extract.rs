// Request plumbing: the error type and the extractors for the signed-in user, the admin token and JSON bodies.

use super::*;
use serde::de::DeserializeOwned;

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
        let account = key.and_then(|k| app.lock().core.x.account_by_key(k).map(|a| a.id.clone()));
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

/// A JSON body, deserialized into the handler's request type. An empty body (or JSON that isn't an object) reads as
/// `{}`, so a request with no required fields needs none. Field errors are 400s naming the field when serde does.
pub struct Body<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for Body<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, _: &S) -> Result<Self, ApiError> {
        let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024).await.map_err(|_| ExError::status(413, "body too large"))?;
        let value = match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ Value::Object(_)) => v,
            Ok(_) => Value::Object(Map::new()),
            Err(_) if bytes.is_empty() => Value::Object(Map::new()),
            Err(_) => return Err(ExError::bad("body must be JSON").into()),
        };
        serde_json::from_value(value).map(Body).map_err(|e| field_error(&e).into())
    }
}

/// "missing field `market`" → "market is required"; anything else as serde says it, without a position.
fn field_error(e: &serde_json::Error) -> ExError {
    let text = e.to_string();
    let text = text.split(" at line ").next().unwrap_or(&text);
    match text.strip_prefix("missing field `").and_then(|t| t.strip_suffix('`')) {
        Some(field) => ExError::bad(format!("{field} is required")),
        None => ExError::bad(format!("invalid request: {text}")),
    }
}

/// Lenient request fields: numbers as JSON numbers or numeric strings, and null or "" as absent.
pub(super) mod field {
    use serde::de::Error;
    use serde::{Deserialize, Deserializer};
    use serde_json::Value;

    /// An optional number.
    pub fn num<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(None),
            Value::Number(n) => Ok(n.as_f64()),
            Value::String(s) if s.trim().is_empty() => Ok(None),
            Value::String(s) => s.trim().parse().map(Some).map_err(|_| D::Error::custom(format!("expected a number, got \"{s}\""))),
            other => Err(D::Error::custom(format!("expected a number, got {other}"))),
        }
    }

    /// An optional exact decimal; "" is absent.
    pub fn dec<'de, D: Deserializer<'de>>(d: D) -> Result<Option<crate::money::Dec>, D::Error> {
        match Value::deserialize(d)? {
            Value::Null => Ok(None),
            Value::String(s) if s.is_empty() => Ok(None),
            v => crate::money::Dec::deserialize(v).map(Some).map_err(D::Error::custom),
        }
    }

    /// An optional string; "" is absent.
    pub fn text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
        Ok(Option::<String>::deserialize(d)?.filter(|s| !s.is_empty()))
    }
}
