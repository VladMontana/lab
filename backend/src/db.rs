use crate::error::AppError;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;
use tracing::info;

pub type DbPool = SqlitePool;

/// Ensures the directory for the SQLite database file exists.
fn ensure_database_dir(database_url: &str) -> Result<(), AppError> {
    let clean = database_url
        .strip_prefix("sqlite://")
        .or_else(|| database_url.strip_prefix("sqlite:"))
        .unwrap_or(database_url);

    if clean == ":memory:" || clean.starts_with("file::memory:") || clean.is_empty() {
        return Ok(());
    }

    let file_path = clean.split('?').next().unwrap_or(clean);
    let path = Path::new(file_path);
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(AppError::Io)?;
        }
    }
    Ok(())
}

/// Initializes the SQLite connection pool with production PRAGMAs:
/// - WAL journal mode
/// - busy_timeout = 5000ms
/// - foreign_keys = ON
/// - synchronous = NORMAL
/// - Max connections: 10
///
/// Automatically executes SQLx migrations from ./migrations.
pub async fn init_db(database_url: &str) -> Result<DbPool, AppError> {
    ensure_database_dir(database_url)?;

    let connect_options = SqliteConnectOptions::from_str(database_url)
        .map_err(|e| AppError::Config(format!("Invalid DATABASE_URL '{database_url}': {e}")))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(5000))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .connect_with(connect_options)
        .await
        .map_err(AppError::Database)?;

    run_migrations(&pool).await?;

    info!("Database initialized and migrations applied successfully");
    Ok(pool)
}

/// Executes all pending migrations embedded via sqlx::migrate!
pub async fn run_migrations(pool: &DbPool) -> Result<(), AppError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to run database migrations: {e}")))?;
    Ok(())
}

/// Helper for initializing an isolated in-memory test database with migrations applied.
pub async fn init_test_db() -> Result<DbPool, AppError> {
    let connect_options = SqliteConnectOptions::from_str("sqlite::memory:")
        .map_err(|e| AppError::Config(e.to_string()))?
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(connect_options)
        .await
        .map_err(AppError::Database)?;

    run_migrations(&pool).await?;

    Ok(pool)
}
