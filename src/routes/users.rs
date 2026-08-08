use axum::{extract::State, response::IntoResponse, Json};

use crate::{auth::AuthUser, error::AppError, AppState};

pub async fn list_users(
    AuthUser(_user): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    Ok(Json(crate::auth::list_users(&state.pool).await?))
}
