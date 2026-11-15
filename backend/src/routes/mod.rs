//! Router assembly for LabNotes API.

pub mod admin_auth;
pub mod admin_pages;
pub mod admin_subjects;
pub mod healthz;
pub mod media;
pub mod public;
pub mod spa;

use crate::AppState;
use axum::Router;

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .merge(healthz::router())
        .merge(admin_auth::router())
        .merge(admin_subjects::router())
        .merge(admin_pages::router())
        .merge(media::router())
        .merge(public::router())
        .fallback(spa::spa_fallback_handler)
        .with_state(state)
}
