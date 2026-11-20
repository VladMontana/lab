use rand::distributions::Alphanumeric;
use rand::Rng;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("Invalid HOST '{0}': {1}")]
    InvalidHost(String, String),

    #[error("Invalid PORT '{0}': {1}")]
    InvalidPort(String, String),

    #[error("Invalid DATABASE_URL: {0}")]
    InvalidDatabaseUrl(String),

    #[error("Invalid ADMIN_PASSWORD: {0}")]
    InvalidAdminPassword(String),

    #[error("Invalid SESSION_SECRET: {0}")]
    InvalidSessionSecret(String),

    #[error("Invalid number for {0} ('{1}'): {2}")]
    InvalidNumber(&'static str, String, String),

    #[error("Invalid TRUSTED_PROXY_IPS entry '{0}': {1}")]
    InvalidTrustedProxyIp(String, String),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub database_url: String,
    pub data_dir: PathBuf,
    pub cookie_secure: bool,
    pub admin_username: String,
    pub admin_password: Option<String>,
    pub session_secret: String,
    pub max_image_bytes: usize,
    pub max_attachment_bytes: usize,
    pub trusted_proxy_ips: Vec<IpAddr>,
}

impl Config {
    /// Loads configuration from environment variables with sensible production defaults.
    pub fn from_env() -> Result<Self, ConfigError> {
        let _ = dotenvy::dotenv();

        let host = std::env::var("APP_HOST")
            .or_else(|_| std::env::var("HOST"))
            .unwrap_or_else(|_| "127.0.0.1".to_string());

        if host != "localhost" {
            if let Err(e) = IpAddr::from_str(&host) {
                return Err(ConfigError::InvalidHost(host, e.to_string()));
            }
        }

        let port_raw = std::env::var("APP_PORT").or_else(|_| std::env::var("PORT"));
        let port = match port_raw {
            Ok(val) => val
                .parse::<u16>()
                .map_err(|e| ConfigError::InvalidPort(val, e.to_string()))?,
            Err(_) => 8080,
        };

        let base_url = std::env::var("APP_BASE_URL")
            .or_else(|_| std::env::var("BASE_URL"))
            .unwrap_or_else(|_| format!("http://localhost:{port}"));

        let database_url = std::env::var("DATABASE_URL")
            .unwrap_or_else(|_| "sqlite://./data/labnotes.db".to_string());

        if !database_url.starts_with("sqlite:") {
            return Err(ConfigError::InvalidDatabaseUrl(
                "DATABASE_URL must begin with 'sqlite:'".to_string(),
            ));
        }

        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));

        let cookie_secure = std::env::var("COOKIE_SECURE")
            .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
            .unwrap_or(false);

        let admin_username =
            std::env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".to_string());

        let admin_password = match std::env::var("ADMIN_PASSWORD") {
            Ok(val) if !val.trim().is_empty() => {
                if val.len() < 8 {
                    return Err(ConfigError::InvalidAdminPassword(
                        "ADMIN_PASSWORD must be at least 8 characters long".to_string(),
                    ));
                }
                Some(val)
            }
            _ => None,
        };

        let session_secret = match std::env::var("SESSION_SECRET") {
            Ok(val) if !val.trim().is_empty() => {
                if val.len() < 16 {
                    return Err(ConfigError::InvalidSessionSecret(
                        "SESSION_SECRET must be at least 16 characters long".to_string(),
                    ));
                }
                val
            }
            _ => {
                let generated: String = rand::thread_rng()
                    .sample_iter(&Alphanumeric)
                    .take(32)
                    .map(char::from)
                    .collect();
                tracing::warn!("SESSION_SECRET not set; generated ephemeral development secret");
                generated
            }
        };

        let max_image_bytes = match std::env::var("MAX_IMAGE_BYTES") {
            Ok(val) => val
                .parse::<usize>()
                .map_err(|e| ConfigError::InvalidNumber("MAX_IMAGE_BYTES", val, e.to_string()))?,
            Err(_) => 10 * 1024 * 1024, // 10 MiB default
        };

        let max_attachment_bytes = match std::env::var("MAX_ATTACHMENT_BYTES") {
            Ok(val) => val.parse::<usize>().map_err(|e| {
                ConfigError::InvalidNumber("MAX_ATTACHMENT_BYTES", val, e.to_string())
            })?,
            Err(_) => 50 * 1024 * 1024, // 50 MiB default
        };

        let trusted_proxy_ips = match std::env::var("TRUSTED_PROXY_IPS") {
            Ok(value) if !value.trim().is_empty() => value
                .split(',')
                .map(|entry| {
                    let entry = entry.trim();
                    IpAddr::from_str(entry).map_err(|e| {
                        ConfigError::InvalidTrustedProxyIp(entry.to_string(), e.to_string())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?,
            _ => Vec::new(),
        };

        Ok(Self {
            host,
            port,
            base_url,
            database_url,
            data_dir,
            cookie_secure,
            admin_username,
            admin_password,
            session_secret,
            max_image_bytes,
            max_attachment_bytes,
            trusted_proxy_ips,
        })
    }

    /// Returns the path for uploaded media files.
    pub fn media_dir(&self) -> PathBuf {
        self.data_dir.join("media")
    }

    /// Returns the path for temporary upload files.
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    /// Resolves the socket address to bind the Axum TCP listener.
    pub fn socket_addr(&self) -> Result<SocketAddr, ConfigError> {
        let ip = if self.host == "localhost" {
            IpAddr::from([127, 0, 0, 1])
        } else {
            IpAddr::from_str(&self.host)
                .map_err(|e| ConfigError::InvalidHost(self.host.clone(), e.to_string()))?
        };
        Ok(SocketAddr::new(ip, self.port))
    }

    /// Ensures required storage directories exist on disk.
    pub fn ensure_directories(&self) -> Result<(), std::io::Error> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(self.media_dir())?;
        std::fs::create_dir_all(self.tmp_dir())?;
        Ok(())
    }
}
