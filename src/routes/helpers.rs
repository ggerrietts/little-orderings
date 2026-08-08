use crate::error::AppError;

pub async fn project_id_for_milestone(
    pool: &sqlx::SqlitePool,
    milestone_id: i64,
) -> Result<i64, AppError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT project_id FROM milestones WHERE id = ?")
            .bind(milestone_id)
            .fetch_optional(pool)
            .await?;
    row.map(|(id,)| id).ok_or(AppError::NotFound)
}

pub async fn project_id_for_task(
    pool: &sqlx::SqlitePool,
    task_id: i64,
) -> Result<i64, AppError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT project_id FROM tasks WHERE id = ?")
            .bind(task_id)
            .fetch_optional(pool)
            .await?;
    row.map(|(id,)| id).ok_or(AppError::NotFound)
}
