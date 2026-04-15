use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::collections::HashMap;

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{
        Assignee, AssignRequest, CreateTaskRequest, ReorderTaskRequest, Task, TaskWithAssignees,
        UpdateTaskRequest,
    },
    AppState,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async fn project_id_for_task(pool: &sqlx::SqlitePool, task_id: i64) -> Result<i64, AppError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT m.project_id FROM tasks t
         JOIN milestones m ON m.id = t.milestone_id
         WHERE t.id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await?;
    row.map(|(id,)| id).ok_or(AppError::NotFound)
}

async fn get_full_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<TaskWithAssignees, AppError> {
    let task: Task = sqlx::query_as(
        "SELECT id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE id = ?",
    )
    .bind(task_id)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound)?;

    let assignees: Vec<Assignee> = sqlx::query_as(
        "SELECT ta.user_id, u.username
         FROM task_assignments ta JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id = ?",
    )
    .bind(task_id)
    .fetch_all(pool)
    .await?;

    Ok(TaskWithAssignees { task, assignees })
}

// ── Handlers ──────────────────────────────────────────────────────────────────

pub async fn list_tasks(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id =
        crate::routes::milestones::project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let tasks: Vec<Task> = sqlx::query_as(
        "SELECT id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE milestone_id = ? ORDER BY sort_order, id",
    )
    .bind(milestone_id)
    .fetch_all(&state.pool)
    .await?;

    if tasks.is_empty() {
        return Ok(Json(Vec::<TaskWithAssignees>::new()));
    }

    // Batch-fetch all assignees for these tasks in one query to avoid N+1.
    let task_ids: Vec<i64> = tasks.iter().map(|t| t.id).collect();
    let placeholders = task_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT ta.task_id, ta.user_id, u.username
         FROM task_assignments ta JOIN users u ON u.id = ta.user_id
         WHERE ta.task_id IN ({})",
        placeholders
    );
    let mut q = sqlx::query_as::<_, (i64, i64, String)>(&sql);
    for id in &task_ids {
        q = q.bind(*id);
    }
    let raw: Vec<(i64, i64, String)> = q.fetch_all(&state.pool).await?;

    let mut assignee_map: HashMap<i64, Vec<Assignee>> = HashMap::new();
    for (task_id, user_id, username) in raw {
        assignee_map
            .entry(task_id)
            .or_default()
            .push(Assignee { user_id, username });
    }

    let result: Vec<TaskWithAssignees> = tasks
        .into_iter()
        .map(|task| {
            let assignees = assignee_map.remove(&task.id).unwrap_or_default();
            TaskWithAssignees { task, assignees }
        })
        .collect();

    Ok(Json(result))
}

pub async fn create_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(milestone_id): Path<i64>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id =
        crate::routes::milestones::project_id_for_milestone(&state.pool, milestone_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let priority = payload.priority.as_deref().unwrap_or("normal");

    let mut tx = state.pool.begin().await?;

    let (next_order,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE milestone_id = ?",
    )
    .bind(milestone_id)
    .fetch_one(&mut *tx)
    .await?;

    let result = sqlx::query(
        "INSERT INTO tasks (milestone_id, title, description, priority, due_date, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(milestone_id)
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(priority)
    .bind(&payload.due_date)
    .bind(next_order)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;

    let task_id = result.last_insert_rowid();
    tx.commit().await?;

    let task = get_full_task(&state.pool, task_id).await?;
    Ok((StatusCode::CREATED, Json(task)))
}

pub async fn update_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<UpdateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    sqlx::query(
        "UPDATE tasks
         SET title       = COALESCE(?, title),
             description = COALESCE(?, description),
             status      = COALESCE(?, status),
             priority    = COALESCE(?, priority),
             due_date    = COALESCE(?, due_date),
             updated_at  = CURRENT_TIMESTAMP
         WHERE id = ?",
    )
    .bind(&payload.title)
    .bind(&payload.description)
    .bind(&payload.status)
    .bind(&payload.priority)
    .bind(&payload.due_date)
    .bind(task_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}

pub async fn delete_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(task_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn assign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<AssignRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    // The assignee must also be a project member.
    crate::auth::require_member(&state.pool, project_id, payload.user_id)
        .await
        .map_err(|_| AppError::BadRequest("User is not a project member".to_string()))?;

    sqlx::query("INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)")
        .bind(task_id)
        .bind(payload.user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            if e.to_string().contains("UNIQUE constraint failed") {
                AppError::BadRequest("User already assigned".to_string())
            } else {
                AppError::from(e)
            }
        })?;

    Ok((StatusCode::CREATED, Json(get_full_task(&state.pool, task_id).await?)))
}

pub async fn unassign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((task_id, target_user_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?")
        .bind(task_id)
        .bind(target_user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn reorder_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<ReorderTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    // Capture the old milestone before we move the task.
    let (old_milestone_id,): (i64,) =
        sqlx::query_as("SELECT milestone_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_one(&state.pool)
            .await?;

    let new_milestone_id = payload.milestone_id;

    // Ensure the destination milestone belongs to the same project.
    let dest_project_id =
        crate::routes::milestones::project_id_for_milestone(&state.pool, new_milestone_id).await?;
    if dest_project_id != project_id {
        return Err(AppError::Forbidden);
    }

    let mut tx = state.pool.begin().await?;

    // --- Reorder the new milestone ---
    // Fetch task IDs in the destination milestone (excluding the moved task), in current order.
    let mut new_ids: Vec<i64> = sqlx::query_as(
        "SELECT id FROM tasks WHERE milestone_id = ? AND id != ? ORDER BY sort_order, id",
    )
    .bind(new_milestone_id)
    .bind(task_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    let pos = (payload.sort_order.max(0) as usize).min(new_ids.len());
    new_ids.insert(pos, task_id);

    // Move the task and assign its new sort_order.
    sqlx::query(
        "UPDATE tasks SET milestone_id = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?",
    )
    .bind(new_milestone_id)
    .bind(pos as i64)
    .bind(task_id)
    .execute(&mut *tx)
    .await?;

    // Renumber every task in the new milestone.
    for (i, id) in new_ids.iter().enumerate() {
        sqlx::query("UPDATE tasks SET sort_order = ? WHERE id = ?")
            .bind(i as i64)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    // --- If moved between milestones, renumber the old one too ---
    if old_milestone_id != new_milestone_id {
        let old_ids: Vec<(i64,)> = sqlx::query_as(
            "SELECT id FROM tasks WHERE milestone_id = ? ORDER BY sort_order, id",
        )
        .bind(old_milestone_id)
        .fetch_all(&mut *tx)
        .await?;

        for (i, (id,)) in old_ids.iter().enumerate() {
            sqlx::query("UPDATE tasks SET sort_order = ? WHERE id = ?")
                .bind(i as i64)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    }

    tx.commit().await?;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}
