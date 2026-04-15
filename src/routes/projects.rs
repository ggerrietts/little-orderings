use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::{
    auth::AuthUser,
    error::AppError,
    models::{
        AddMemberRequest, CreateProjectRequest, MilestoneSummary, Project, ProjectDetail,
        ProjectListItem, ProjectMember, UpdateProjectRequest,
    },
    AppState,
};

pub async fn list_projects(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    let projects: Vec<ProjectListItem> = sqlx::query_as(
        "SELECT p.id, p.name, p.description, p.owner_id, p.status, p.target_date,
                p.created_at, p.updated_at,
                (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count,
                (SELECT COUNT(*) FROM tasks t
                 JOIN milestones m ON t.milestone_id = m.id
                 WHERE m.project_id = p.id
                   AND t.status NOT IN ('done', 'cancelled')) as open_task_count
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ?
         ORDER BY p.created_at DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(projects))
}

pub async fn create_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Json(payload): Json<CreateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    let result = sqlx::query(
        "INSERT INTO projects (name, description, owner_id, target_date) VALUES (?, ?, ?, ?)",
    )
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(user.id)
    .bind(&payload.target_date)
    .execute(&state.pool)
    .await?;

    let project_id = result.last_insert_rowid();

    sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')",
    )
    .bind(project_id)
    .bind(user.id)
    .execute(&state.pool)
    .await?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, description, owner_id, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_one(&state.pool)
    .await?;

    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn get_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, description, owner_id, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or(AppError::NotFound)?;

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

    Ok(Json(ProjectDetail { project, milestones }))
}

pub async fn update_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<UpdateProjectRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    // COALESCE: if caller omits a field (None → SQL NULL), keep the existing value.
    sqlx::query(
        "UPDATE projects
         SET name        = COALESCE(?, name),
             description = COALESCE(?, description),
             target_date = COALESCE(?, target_date),
             status      = COALESCE(?, status),
             updated_at  = CURRENT_TIMESTAMP
         WHERE id = ?",
    )
    .bind(&payload.name)
    .bind(&payload.description)
    .bind(&payload.target_date)
    .bind(&payload.status)
    .bind(project_id)
    .execute(&state.pool)
    .await?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, description, owner_id, status, target_date, created_at, updated_at
         FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(project))
}

pub async fn archive_project(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_owner(&state.pool, project_id, user.id).await?;

    sqlx::query(
        "UPDATE projects SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
    .bind(project_id)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_members(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_member(&state.pool, project_id, user.id).await?;

    let members: Vec<ProjectMember> = sqlx::query_as(
        "SELECT pm.user_id, u.username, u.email, pm.role
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY pm.role DESC, u.username",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(members))
}

pub async fn add_member(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path(project_id): Path<i64>,
    Json(payload): Json<AddMemberRequest>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_owner(&state.pool, project_id, user.id).await?;

    let role = payload.role.as_deref().unwrap_or("member");

    sqlx::query(
        "INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)",
    )
    .bind(project_id)
    .bind(payload.user_id)
    .bind(role)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        let msg = e.to_string();
        if msg.contains("UNIQUE constraint failed") {
            AppError::BadRequest("User is already a member".to_string())
        } else if msg.contains("FOREIGN KEY constraint failed") {
            AppError::NotFound
        } else {
            AppError::from(e)
        }
    })?;

    Ok(StatusCode::CREATED)
}

pub async fn remove_member(
    AuthUser(user): AuthUser,
    State(state): State<AppState>,
    Path((project_id, member_user_id)): Path<(i64, i64)>,
) -> Result<impl IntoResponse, AppError> {
    crate::auth::require_owner(&state.pool, project_id, user.id).await?;

    // Fetch the role of the member being removed.
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(member_user_id)
    .fetch_optional(&state.pool)
    .await?;

    let role = row.ok_or(AppError::NotFound)?.0;

    // Prevent removing the last owner.
    if role == "owner" {
        let (other_owners,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM project_members
             WHERE project_id = ? AND role = 'owner' AND user_id != ?",
        )
        .bind(project_id)
        .bind(member_user_id)
        .fetch_one(&state.pool)
        .await?;

        if other_owners == 0 {
            return Err(AppError::Forbidden);
        }
    }

    sqlx::query("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
        .bind(project_id)
        .bind(member_user_id)
        .execute(&state.pool)
        .await?;

    Ok(StatusCode::NO_CONTENT)
}

