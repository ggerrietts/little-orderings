use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use sqlx::QueryBuilder;
use std::collections::HashMap;

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{
        Assignee, AssignRequest, CreateTaskRequest, Patch, ReorderTaskRequest, Task,
        TaskWithAssignees, UpdateTaskRequest,
    },
    AppState,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

use crate::routes::helpers::{project_id_for_milestone, project_id_for_task};

async fn get_full_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<TaskWithAssignees, AppError> {
    let task: Task = sqlx::query_as(
        "SELECT id, project_id, milestone_id, title, description, status, priority,
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
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let tasks: Vec<Task> = sqlx::query_as(
        "SELECT id, project_id, milestone_id, title, description, status, priority,
                due_date, sort_order, created_by, created_at, updated_at
         FROM tasks WHERE project_id = ? ORDER BY sort_order, id",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    // Early return required: IN () with an empty list is invalid SQL, so the
    // batch assignee fetch below must not be reached when there are no tasks.
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
    Path(project_id): Path<i64>,
    Json(payload): Json<CreateTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    // If a milestone was specified, it must belong to this project.
    if let Some(milestone_id) = payload.milestone_id {
        let milestone_project_id =
            project_id_for_milestone(&state.pool, milestone_id).await?;
        if milestone_project_id != project_id {
            return Err(AppError::BadRequest(
                "Milestone does not belong to this project".to_string(),
            ));
        }
    }

    let priority = payload.priority.as_ref().map(|p| p.as_str()).unwrap_or("normal");

    let mut tx = state.pool.begin().await?;

    let (next_order,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM tasks WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await?;

    let result = sqlx::query(
        "INSERT INTO tasks (project_id, milestone_id, title, description, priority, due_date, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(payload.milestone_id)
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

    crate::notifications::notify_watchers(
        &state.pool,
        project_id,
        crate::models::Tier::TaskMilestones,
        user.id,
    )
    .await;

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
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    if let Patch::Value(milestone_id) = &payload.milestone_id {
        let milestone_project_id =
            project_id_for_milestone(&state.pool, *milestone_id).await?;
        if milestone_project_id != project_id {
            return Err(AppError::BadRequest(
                "Milestone does not belong to this project".to_string(),
            ));
        }
    }

    let (old_status,): (String,) = sqlx::query_as("SELECT status FROM tasks WHERE id = ?")
        .bind(task_id)
        .fetch_one(&state.pool)
        .await?;

    let mut qb = QueryBuilder::<sqlx::Sqlite>::new(
        "UPDATE tasks SET updated_at = CURRENT_TIMESTAMP",
    );
    if let Some(ref v) = payload.title {
        qb.push(", title = ").push_bind(v);
    }
    match &payload.description {
        Patch::Value(v) => { qb.push(", description = ").push_bind(v); }
        Patch::Null => { qb.push(", description = NULL"); }
        Patch::Missing => {}
    }
    if let Some(ref v) = payload.status {
        qb.push(", status = ").push_bind(v.as_str());
    }
    if let Some(ref v) = payload.priority {
        qb.push(", priority = ").push_bind(v.as_str());
    }
    match &payload.due_date {
        Patch::Value(v) => { qb.push(", due_date = ").push_bind(v); }
        Patch::Null => { qb.push(", due_date = NULL"); }
        Patch::Missing => {}
    }
    match &payload.milestone_id {
        Patch::Value(v) => { qb.push(", milestone_id = ").push_bind(v); }
        Patch::Null => { qb.push(", milestone_id = NULL"); }
        Patch::Missing => {}
    }
    qb.push(" WHERE id = ").push_bind(task_id);
    qb.build().execute(&state.pool).await?;

    let became_done = old_status != "done"
        && matches!(payload.status, Some(crate::models::TaskStatus::Done));
    let event_tier = if became_done {
        crate::models::Tier::TaskMilestones
    } else {
        crate::models::Tier::All
    };
    crate::notifications::notify_watchers(&state.pool, project_id, event_tier, user.id).await;

    Ok(Json(get_full_task(&state.pool, task_id).await?))
}

pub async fn delete_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    sqlx::query("DELETE FROM tasks WHERE id = ?")
        .bind(task_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All, user.id).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn assign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<AssignRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

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

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All, user.id).await;

    Ok((StatusCode::CREATED, Json(get_full_task(&state.pool, task_id).await?)))
}

pub async fn unassign_user(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((task_id, target_user_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    // Intentionally idempotent: unassigning a user who was never assigned
    // returns 204 rather than 404, matching REST convention for DELETE.
    sqlx::query("DELETE FROM task_assignments WHERE task_id = ? AND user_id = ?")
        .bind(task_id)
        .bind(target_user_id)
        .execute(&state.pool)
        .await?;

    crate::notifications::notify_watchers(&state.pool, project_id, crate::models::Tier::All, user.id).await;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn reorder_task(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(task_id): Path<i64>,
    Json(payload): Json<ReorderTaskRequest>,
) -> Result<impl IntoResponse, AppError> {
    let project_id = project_id_for_task(&state.pool, task_id).await?;
    crate::auth::require_writer(&state.pool, project_id, user.id).await?;

    let mut tx = state.pool.begin().await?;

    // The sibling set this reorder operates on, ordered by current
    // sort_order, INCLUDING the moved task's own row (its current
    // sort_order is one of the "slots" we redistribute below).
    //
    // Flat mode (scoped=false) scopes to the whole project. Scoped mode
    // (scoped=true) scopes to every task sharing this task's own current
    // milestone_id (including NULL, for the "No milestone" section) —
    // trusted because grouped-mode drags only ever happen within one
    // milestone section's own drag-and-drop zone; a task can't be dropped
    // into a different section's zone, since milestone reassignment only
    // happens through the detail modal, never through this endpoint.
    let siblings: Vec<(i64, i64)> = if payload.scoped {
        let (milestone_id,): (Option<i64>,) =
            sqlx::query_as("SELECT milestone_id FROM tasks WHERE id = ?")
                .bind(task_id)
                .fetch_one(&mut *tx)
                .await?;
        match milestone_id {
            Some(mid) => {
                sqlx::query_as(
                    "SELECT id, sort_order FROM tasks
                     WHERE project_id = ? AND milestone_id = ? ORDER BY sort_order, id",
                )
                .bind(project_id)
                .bind(mid)
                .fetch_all(&mut *tx)
                .await?
            }
            None => {
                sqlx::query_as(
                    "SELECT id, sort_order FROM tasks
                     WHERE project_id = ? AND milestone_id IS NULL ORDER BY sort_order, id",
                )
                .bind(project_id)
                .fetch_all(&mut *tx)
                .await?
            }
        }
    } else {
        sqlx::query_as(
            "SELECT id, sort_order FROM tasks WHERE project_id = ? ORDER BY sort_order, id",
        )
        .bind(project_id)
        .fetch_all(&mut *tx)
        .await?
    };

    let slots: Vec<i64> = siblings.iter().map(|(_, so)| *so).collect();
    let mut ids: Vec<i64> = siblings
        .iter()
        .map(|(id, _)| *id)
        .filter(|id| *id != task_id)
        .collect();

    let pos = (payload.sort_order.max(0) as usize).min(ids.len());
    ids.insert(pos, task_id);

    // Reassign the SAME set of slot values to the new order — not a fresh
    // 0..N. This is what keeps every task outside this scope completely
    // undisturbed, both in stored value and in order relative to anything
    // else in the project.
    for (slot, id) in slots.iter().zip(ids.iter()) {
        sqlx::query("UPDATE tasks SET sort_order = ? WHERE id = ?")
            .bind(slot)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;

    // Return every task whose sort_order may have changed, not just the
    // moved one, so the frontend can update them all in local state
    // without a refetch (matches how reorder_milestone already returns
    // every milestone in the project after a move).
    let mut affected: Vec<TaskWithAssignees> = Vec::with_capacity(ids.len());
    for id in &ids {
        affected.push(get_full_task(&state.pool, *id).await?);
    }
    Ok(Json(affected))
}
