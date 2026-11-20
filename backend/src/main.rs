use std::error::Error;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use backend::config::Config;
use backend::db::init_db;
use backend::routes::create_router;
use backend::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    // Initialize tracing with environment filter
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // Load and validate configuration
    let config = Config::from_env()?;
    config.ensure_directories()?;

    info!(
        host = %config.host,
        port = %config.port,
        data_dir = %config.data_dir.display(),
        "Starting LabNotes server"
    );

    // Initialize database pool and apply migrations
    let db = init_db(&config.database_url).await?;

    // Read reset credentials from the terminal without echoing them or accepting argv secrets.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--set-admin-password" || arg == "set-admin-password") {
        if args.len() != 2 {
            return Err("Usage: backend --set-admin-password (enter the password at the hidden prompt)".into());
        }
        let new_password = rpassword::prompt_password("New admin password: ")?;
        let confirmation = rpassword::prompt_password("Confirm password: ")?;
        if new_password != confirmation {
            return Err("Passwords do not match".into());
        }
        backend::auth::reset_admin_password(&db, &config.admin_username, &new_password).await?;
        info!("Admin password successfully updated via CLI");
        return Ok(());
    }

    // Automatic bootstrap if database has no admin and ADMIN_PASSWORD is set in environment
    if let Some(ref password) = config.admin_password {
        backend::auth::bootstrap_admin(&db, &config.admin_username, password).await?;
    }

    // Assemble application state and router
    let state = AppState::new(db, config.clone());
    let app = create_router(state).layer(tower_http::trace::TraceLayer::new_for_http());

    // Bind TCP listener
    let addr = config.socket_addr()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    info!("Server listening on http://{}", addr);

    // Run Axum server
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;

    Ok(())
}
