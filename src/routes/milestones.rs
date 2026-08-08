use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use sqlx::QueryBuilder;

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{CreateMilestoneRequest, MilestoneSummary, Patch, ReorderMilestoneRequest, UpdateMilestoneRequest},
    AppState,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

use crate::routes::helpers::project_id_for_milestone;

async fn fetch_milestone(
    pool: &sqlx::SqlitePool,
    milestone_id: i64,
) -> Result<MilestoneSummary, AppError> {
    sqlx::query_as(
        "SELECT m.id, m.name, m.description, m.status, m.target_date, m.due_date, m.sort_order,
                (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) as task_count
         FROM milestones m WHERE m.id = ?",
    )
    .bind(milestone_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn list_milestones(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let milestones: Vec<MilestoneSummary> = sqlx::query_as(
        "SELECT m.id, m.name, m.description, m.status, m.target_date, m.due_date, m.sort_order,
                (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) as task_count
         FROM milestones m
         WHERE m.project_id = ?
         ORDER BY m.sort_order, m.id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(milestones))
}

pub async fn create_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<CreateMilestoneRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut tx = state.pool.begin().await?;

    let (next_order,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM milestones WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;

    let result = sqlx::query(
        "INSERT INTO milestones (project_id, name, description, target_date, due_date, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(&payload.target_date)
    .bind(&payload.due_date)
    .bind(next_order)
    .execute(&mut *tx)
    .await?;

    let milestone_id = result.last_insert_rowid();
    tx.commit().await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::Milestones,
        user.id,
    )
    .await;

    let milestone = fetch_milestone(&state.pool, milestone_id).await?;
    Ok((StatusCode::CREATED, Json(milestone)))
}

pub async fn update_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
    Json(payload): Json<UpdateMilestoneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
        "UPDATE milestones SET updated_at = CURRENT_TIMESTAMP",
    );
    if let Some(ref v) = payload.name {
        qb.push(", name = ").push_bind(v);
    }
    match &payload.description {
        Patch::Value(v) => { qb.push(", description = ").push_bind(v); }
        Patch::Null => { qb.push(", description = NULL"); }
        Patch::Missing => {}
    }
    if let Some(ref v) = payload.status {
        qb.push(", status = ").push_bind(v.as_str());
    }
    match &payload.target_date {
        Patch::Value(v) => { qb.push(", target_date = ").push_bind(v); }
        Patch::Null => { qb.push(", target_date = NULL"); }
        Patch::Missing => {}
    }
    match &payload.due_date {
        Patch::Value(v) => { qb.push(", due_date = ").push_bind(v); }
        Patch::Null => { qb.push(", due_date = NULL"); }
        Patch::Missing => {}
    }
    qb.push(" WHERE id = ").push_bind(milestone_id);
    qb.build().execute(&state.pool).await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::Milestones,
        user.id,
    )
    .await;

    Ok(Json(fetch_milestone(&state.pool, milestone_id).await?))
}

pub async fn delete_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM milestones WHERE id = ?")
        .bind(milestone_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::Milestones,
        user.id,
    )
    .await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn reorder_milestone(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
    Json(payload): Json<ReorderMilestoneRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut tx = state.pool.begin().await?;

    // Fetch all milestone IDs in this project (except the one being moved), in current order.
    let mut ids: Vec<i64> = sqlx::query_as(
        "SELECT id FROM milestones WHERE project_id = ? AND id != ? ORDER BY sort_order, id",
    )
    .bind(project_id)
    .bind(milestone_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    // Splice in the moved milestone at the requested position.
    let pos = (payload.sort_order.max(0) as usize).min(ids.len());
    ids.insert(pos, milestone_id);

    // Renumber all milestones in the project contiguously.
    for (i, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE milestones SET sort_order = ? WHERE id = ?")
            .bind(i as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // Return the full refreshed list so the frontend can update in one round-trip.
    let milestones: Vec<MilestoneSummary> = sqlx::query_as(
        "SELECT m.id, m.name, m.description, m.status, m.target_date, m.due_date, m.sort_order,
                (SELECT COUNT(*) FROM tasks WHERE milestone_id = m.id) as task_count
         FROM milestones m WHERE m.project_id = ? ORDER BY m.sort_order, m.id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(milestones))
}
