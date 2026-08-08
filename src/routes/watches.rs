use axum::{extract::{Path, State}, http::StatusCode, response::IntoResponse, Json};

use crate::{auth::AuthUser, error::AppError, models::SetWatchRequest, AppState};

pub async fn set_watch(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<SetWatchRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    sqlx::query(
        "INSERT INTO project_watches (project_id, user_id, tier) VALUES (?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET tier = excluded.tier",
    )
    .bind(project_id)
    .bind(user.id)
    .bind(payload.tier.as_str())
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_watch(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    sqlx::query("DELETE FROM project_watches WHERE project_id = ? AND user_id = ?")
        .bind(project_id)
        .bind(user.id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}
