//! Health readiness probe endpoint.

use axum::{
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HealthResponse {
    pub status: &'static str,
}

/// GET /healthz
/// Returns HTTP 200 OK {"status": "ok"} without leaking system paths or credentials.
pub async fn healthz_handler() -> impl IntoResponse {
    Json(HealthResponse { status: "ok" })
}

/// Constructs the healthz router
pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new().route("/healthz", get(healthz_handler))
}
