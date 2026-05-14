use argon2::{
    password_hash::SaltString,
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
};
use async_trait::async_trait;
use axum::{
    extract::{FromRef, FromRequestParts, Request, State},
    http::{header, request::Parts, HeaderMap},
    response::IntoResponse,
    Json,
};
use rand::rngs::OsRng;
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppError;
use crate::models::{LoginRequest, User};
use crate::AppState;

pub struct AuthUser(pub User);

#[async_trait]
impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let session_id = extract_session_cookie(&parts.headers).ok_or(AppError::Unauthorized)?;

        let user: Option<User> = sqlx::query_as(
            "SELECT u.id, u.username, u.email, u.password_hash, u.created_at \
             FROM users u \
             JOIN sessions s ON s.user_id = u.id \
             WHERE s.id = ? AND s.expires_at > datetime('now')",
        )
        .bind(&session_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(AppError::from)?;

        user.map(AuthUser).ok_or(AppError::Unauthorized)
    }
}

fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie_header = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix("session_id=") {
            return Some(value.to_string());
        }
    }
    None
}

pub async fn login(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<impl IntoResponse, AppError> {
    let user: Option<User> = sqlx::query_as(
        "SELECT id, username, email, password_hash, created_at FROM users WHERE username = ?",
    )
    .bind(&payload.username)
    .fetch_optional(&state.pool)
    .await?;

    let user = user.ok_or(AppError::Unauthorized)?;

    let parsed_hash = PasswordHash::new(&user.password_hash).map_err(|_| AppError::Unauthorized)?;
    Argon2::default()
        .verify_password(payload.password.as_bytes(), &parsed_hash)
        .map_err(|_| AppError::Unauthorized)?;

    let session_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+7 days'))",
    )
    .bind(&session_id)
    .bind(user.id)
    .execute(&state.pool)
    .await?;

    let secure = if cfg!(debug_assertions) { "" } else { "; Secure" };
    let cookie = format!(
        "session_id={}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800{}",
        session_id, secure
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        cookie
            .parse()
            .map_err(|_| AppError::Internal("Cookie header error".to_string()))?,
    );

    Ok((headers, Json(json!({ "user": user }))))
}

pub async fn logout(
    State(state): State<AppState>,
    req: Request,
) -> Result<impl IntoResponse, AppError> {
    if let Some(session_id) = extract_session_cookie(req.headers()) {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(&session_id)
            .execute(&state.pool)
            .await?;
    }

    let clear_cookie = "session_id=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    let mut headers = HeaderMap::new();
    headers.insert(
        header::SET_COOKIE,
        clear_cookie
            .parse()
            .map_err(|_| AppError::Internal("Cookie header error".to_string()))?,
    );

    Ok((headers, Json(json!({ "message": "logged out" }))))
}

pub async fn me(AuthUser(user): AuthUser) -> Result<impl IntoResponse, AppError> {
    Ok(Json(user))
}

// ── User management ───────────────────────────────────────────────────────────

pub async fn create_user(
    pool: &SqlitePool,
    username: &str,
    email: &str,
    password: &str,
) -> Result<User, AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| AppError::Internal("Password hashing failed".to_string()))?
        .to_string();

    let result = sqlx::query(
        "INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)",
    )
    .bind(username)
    .bind(email)
    .bind(&hash)
    .execute(pool)
    .await
    .map_err(|e| {
        if e.to_string().contains("UNIQUE constraint failed") {
            AppError::BadRequest("Username or email already taken".to_string())
        } else {
            AppError::from(e)
        }
    })?;

    let user: User = sqlx::query_as(
        "SELECT id, username, email, password_hash, created_at FROM users WHERE id = ?",
    )
    .bind(result.last_insert_rowid())
    .fetch_one(pool)
    .await?;

    Ok(user)
}

pub async fn list_users(pool: &SqlitePool) -> Result<Vec<User>, AppError> {
    sqlx::query_as(
        "SELECT id, username, email, password_hash, created_at FROM users ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::from)
}

pub async fn delete_user(pool: &SqlitePool, username: &str) -> Result<(), AppError> {
    let result = sqlx::query("DELETE FROM users WHERE username = ?")
        .bind(username)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

pub async fn set_user_password(
    pool: &SqlitePool,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|_| AppError::Internal("Password hashing failed".to_string()))?
        .to_string();

    let result = sqlx::query("UPDATE users SET password_hash = ? WHERE username = ?")
        .bind(&hash)
        .bind(username)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(())
}

/// Seeds an admin user on first boot if ADMIN_PASSWORD is set and no users exist yet.
pub async fn seed_admin(pool: &SqlitePool) {
    let password = match std::env::var("ADMIN_PASSWORD") {
        Ok(p) => p,
        Err(_) => return,
    };
    let username = std::env::var("ADMIN_USER").unwrap_or_else(|_| "admin".to_string());
    let email = std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@localhost".to_string());

    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
        .unwrap_or((0,));
    if count.0 > 0 {
        return;
    }

    match create_user(pool, &username, &email, &password).await {
        Ok(_) => tracing::info!("Admin user '{}' seeded", username),
        Err(e) => tracing::warn!("Failed to seed admin user: {}", e),
    }
}

// ── Authorization helpers ─────────────────────────────────────────────────────

/// Returns the user's role in the project, or **404** if not a member.
///
/// Deliberately returns 404 rather than 403 to avoid leaking whether a
/// project exists to users who are not members (security through obscurity).
/// Callers that need to distinguish "not a member" from "not found" must do
/// so at a higher level.
pub async fn require_member(
    pool: &SqlitePool,
    project_id: i64,
    user_id: i64,
) -> Result<String, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(AppError::from)?;
    row.map(|(r,)| r).ok_or(AppError::NotFound)
}

/// Errors with 404 if not a member, 403 if a member but not a writer (owner or member role).
///
/// Viewers are read-only: they pass `require_member` but are rejected here.
pub async fn require_writer(
    pool: &SqlitePool,
    project_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let role = require_member(pool, project_id, user_id).await?;
    if role == "viewer" {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

/// Errors with 404 if not a member, 403 if a member but not owner.
pub async fn require_owner(
    pool: &SqlitePool,
    project_id: i64,
    user_id: i64,
) -> Result<(), AppError> {
    let role = require_member(pool, project_id, user_id).await?;
    if role != "owner" {
        return Err(AppError::Forbidden);
    }
    Ok(())
}

pub fn cleanup_sessions(pool: SqlitePool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let _ = sqlx::query("DELETE FROM sessions WHERE expires_at <= datetime('now')")
                .execute(&pool)
                .await;
        }
    });
}
