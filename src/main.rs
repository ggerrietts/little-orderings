mod auth;
mod db;
mod error;
mod models;
mod notifications;
mod routes;

use axum::{
    http::{header, HeaderValue, Method},
    routing::get,
    Router,
};
use clap::{Parser, Subcommand};
use sqlx::SqlitePool;
use tower_http::{
    cors::CorsLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
}

async fn health() -> &'static str {
    "ok"
}

#[derive(Parser)]
#[command(name = "plan-g", about = "Self-hosted task management")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start the web server
    Serve,
    /// Manage users
    User {
        #[command(subcommand)]
        action: UserAction,
    },
}

#[derive(Subcommand)]
enum UserAction {
    /// Create a new user
    Create {
        username: String,
        email: String,
        password: String,
    },
    /// List all users
    List,
    /// Delete a user by username
    Delete { username: String },
    /// Change a user's password
    #[command(name = "set-password")]
    SetPassword {
        username: String,
        password: String,
    },
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let cli = Cli::parse();
    match cli.command {
        Command::Serve => serve().await,
        Command::User { action } => user_cmd(action).await,
    }
}

async fn serve() {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "little_orderings=debug,tower_http=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let pool = db::init().await;
    auth::cleanup_sessions(pool.clone());

    let state = AppState { pool };

    let allowed_origin = std::env::var("ALLOWED_ORIGIN")
        .unwrap_or_else(|_| "http://localhost:5173".to_string());
    let cors = CorsLayer::new()
        .allow_origin(
            allowed_origin
                .parse::<HeaderValue>()
                .expect("Invalid ALLOWED_ORIGIN"),
        )
        .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
        .allow_headers([header::CONTENT_TYPE, header::COOKIE])
        .allow_credentials(true);

    let dist_dir = std::env::var("FRONTEND_DIST").unwrap_or_else(|_| "frontend/dist".to_string());
    let spa_fallback = ServeFile::new(format!("{}/index.html", dist_dir));
    let static_files = ServeDir::new(&dist_dir).not_found_service(spa_fallback);

    let app = Router::new()
        .route("/health", get(health))
        .nest("/api", routes::api_router())
        .fallback_service(static_files)
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let listener = tokio::net::TcpListener::bind(format!("{}:{}", host, port))
        .await
        .unwrap();
    tracing::info!("listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received, draining in-flight requests");
}

async fn user_cmd(action: UserAction) {
    let pool = db::init().await;
    match action {
        UserAction::Create { username, email, password } => {
            match auth::create_user(&pool, &username, &email, &password).await {
                Ok(u) => println!("Created user: {} (id={})", u.username, u.id),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        UserAction::List => {
            match auth::list_users(&pool).await {
                Ok(users) if users.is_empty() => println!("No users."),
                Ok(users) => {
                    println!("{:<5} {:<20} {}", "ID", "Username", "Email");
                    for u in users {
                        println!("{:<5} {:<20} {}", u.id, u.username, u.email);
                    }
                }
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        UserAction::Delete { username } => {
            match auth::delete_user(&pool, &username).await {
                Ok(_) => println!("Deleted user: {username}"),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
        UserAction::SetPassword { username, password } => {
            match auth::set_user_password(&pool, &username, &password).await {
                Ok(_) => println!("Password updated for: {username}"),
                Err(e) => {
                    eprintln!("Error: {e}");
                    std::process::exit(1);
                }
            }
        }
    }
}
