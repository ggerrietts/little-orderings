use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{CreatePushSubscriptionRequest, DeletePushSubscriptionRequest},
    AppState,
};

pub async fn create_subscription(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<CreatePushSubscriptionRequest>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query(
        "INSERT INTO push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           p256dh_key = excluded.p256dh_key,
           auth_key = excluded.auth_key",
    )
    .bind(user.id)
    .bind(&payload.endpoint)
    .bind(&payload.p256dh_key)
    .bind(&payload.auth_key)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::CREATED)
}

pub async fn delete_subscription(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<DeletePushSubscriptionRequest>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
        .bind(user.id)
        .bind(&payload.endpoint)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
