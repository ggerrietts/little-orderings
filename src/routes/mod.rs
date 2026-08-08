pub mod helpers;
pub mod milestones;
pub mod projects;
pub mod push_subscriptions;
pub mod tasks;
pub mod users;
pub mod watches;

use axum::{
    routing::{delete, get, patch, post, put},
    Router,
};

use crate::auth;
use crate::AppState;

pub fn api_router() -> Router<AppState> {
    Router::new()
        // Auth
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/users", get(users::list_users))
        // Push subscriptions
        .route(
            "/push-subscriptions",
            post(push_subscriptions::create_subscription).delete(push_subscriptions::delete_subscription),
        )
        // Projects
        .route(
            "/projects",
            get(projects::list_projects).post(projects::create_project),
        )
        .route(
            "/projects/:id",
            get(projects::get_project)
                .patch(projects::update_project)
                .delete(projects::archive_project),
        )
        .route(
            "/projects/:id/members",
            get(projects::list_members).post(projects::add_member),
        )
        .route(
            "/projects/:id/members/:user_id",
            patch(projects::update_member_role).delete(projects::remove_member),
        )
        .route(
            "/projects/:id/watch",
            put(watches::set_watch).delete(watches::delete_watch),
        )
        // Milestones
        .route(
            "/projects/:id/milestones",
            get(milestones::list_milestones).post(milestones::create_milestone),
        )
        .route(
            "/milestones/:id",
            patch(milestones::update_milestone).delete(milestones::delete_milestone),
        )
        .route("/milestones/:id/reorder", patch(milestones::reorder_milestone))
        // Tasks
        .route(
            "/projects/:id/tasks",
            get(tasks::list_tasks).post(tasks::create_task),
        )
        .route(
            "/tasks/:id",
            patch(tasks::update_task).delete(tasks::delete_task),
        )
        .route("/tasks/:id/assign", post(tasks::assign_user))
        .route("/tasks/:id/assign/:user_id", delete(tasks::unassign_user))
        .route("/tasks/:id/reorder", patch(tasks::reorder_task))
}
