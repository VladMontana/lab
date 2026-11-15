pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod models;
pub mod routes;
pub mod storage;

pub use config::Config;
pub use db::{init_db, init_test_db, DbPool};
pub use error::{AppError, AppResult};

#[derive(Clone)]
pub struct AppState {
    pub db: db::DbPool,
    pub config: config::Config,
    pub rate_limiter: auth::LoginRateLimiter,
}

impl AppState {
    pub fn new(db: db::DbPool, config: config::Config) -> Self {
        Self {
            db,
            config,
            rate_limiter: auth::LoginRateLimiter::new(),
        }
    }
}
