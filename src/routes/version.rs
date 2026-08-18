use axum::Json;

use crate::models::VersionResponse;

fn resolve_version(git_sha: Option<String>) -> String {
    git_sha.unwrap_or_else(|| "dev".to_string())
}

pub async fn get_version() -> Json<VersionResponse> {
    Json(VersionResponse {
        version: resolve_version(std::env::var("GIT_SHA").ok()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_version_returns_the_env_value_when_set() {
        assert_eq!(resolve_version(Some("abc123".to_string())), "abc123");
    }

    #[test]
    fn resolve_version_falls_back_to_dev_when_unset() {
        assert_eq!(resolve_version(None), "dev");
    }
}
