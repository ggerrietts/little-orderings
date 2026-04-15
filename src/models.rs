use serde::{Deserialize, Serialize};

// ── Projects ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: i64,
    pub status: String,
    pub target_date: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// List view: project + aggregate counts from subqueries.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ProjectListItem {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub owner_id: i64,
    pub status: String,
    pub target_date: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub member_count: i64,
    pub open_task_count: i64,
}

/// Detail view: project + its milestones.
#[derive(Debug, Serialize)]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub project: Project,
    pub milestones: Vec<MilestoneSummary>,
}

/// Milestone row returned inside a project detail response.
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MilestoneSummary {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub target_date: Option<String>,
    pub due_date: Option<String>,
    pub sort_order: i64,
    pub task_count: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ProjectMember {
    pub user_id: i64,
    pub username: String,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub description: Option<String>,
    pub target_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddMemberRequest {
    pub user_id: i64,
    pub role: Option<String>,
}

// ── Milestones ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct CreateMilestoneRequest {
    pub name: String,
    pub description: Option<String>,
    pub target_date: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMilestoneRequest {
    pub name: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub target_date: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReorderMilestoneRequest {
    pub sort_order: i64,
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Task {
    pub id: i64,
    pub milestone_id: i64,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub sort_order: i64,
    pub created_by: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Assignee {
    pub user_id: i64,
    pub username: String,
}

/// Full task returned from all task endpoints — task fields + embedded assignees.
#[derive(Debug, Serialize)]
pub struct TaskWithAssignees {
    #[serde(flatten)]
    pub task: Task,
    pub assignees: Vec<Assignee>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AssignRequest {
    pub user_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct ReorderTaskRequest {
    pub milestone_id: i64,
    pub sort_order: i64,
}

// ── Users ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub email: String,
    #[serde(skip)]
    pub password_hash: String,
    pub created_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}
