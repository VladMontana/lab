# ==============================================================================
# Stage 1: Build Frontend Single Page Application (SPA)
# ==============================================================================
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend

# Install dependencies leveraging Docker layer cache
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copy frontend source files and compile production bundle
COPY frontend/ ./
RUN npm run build

# ==============================================================================
# Stage 2: Build Rust Backend Release Binary
# ==============================================================================
FROM rust:1-slim-bookworm AS backend-builder
WORKDIR /app/backend

# Pre-compile external dependencies with dummy stubs for caching
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir -p src && \
    echo "pub fn dummy() {}" > src/lib.rs && \
    echo "fn main() {}" > src/main.rs && \
    cargo build --release --bin backend && \
    rm -rf src

# Copy embedded SQL migrations and real source code
COPY backend/migrations ./migrations
COPY backend/src ./src

# Compile the final release binary (migrations embedded at compile time)
RUN touch src/lib.rs src/main.rs && \
    cargo build --release --bin backend

# ==============================================================================
# Stage 3: Minimal Unprivileged Production Runtime
# ==============================================================================
FROM debian:bookworm-slim AS runtime

# Install CA certificates and curl for health checks; clean apt lists
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Create unprivileged system user and group (UID/GID 10001)
RUN groupadd -g 10001 appgroup && \
    useradd -u 10001 -g appgroup -s /sbin/nologin -M appuser

WORKDIR /app

# Prepare directories with unprivileged ownership
RUN mkdir -p /app/data /app/frontend && \
    chown -R 10001:10001 /app && \
    chmod 0755 /app/data

# Copy compiled backend release binary and create friendly symlink
COPY --from=backend-builder --chown=10001:10001 /app/backend/target/release/backend /app/labnotes
RUN ln -s /app/labnotes /app/backend && \
    chmod 0755 /app/labnotes

# Copy compiled frontend assets from Stage 1
COPY --from=frontend-builder --chown=10001:10001 /app/frontend/dist /app/frontend/dist

# Switch to unprivileged execution user
USER 10001:10001

# Default environment configuration
ENV APP_HOST=0.0.0.0 \
    APP_PORT=8080 \
    DATA_DIR=/app/data \
    DATABASE_URL=sqlite:///app/data/labnotes.sqlite?mode=rwc \
    FRONTEND_DIST_DIR=/app/frontend/dist

EXPOSE 8080
VOLUME ["/app/data"]

# Native container healthcheck
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:8080/healthz || exit 1

CMD ["/app/labnotes"]
