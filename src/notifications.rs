use crate::models::Tier;

pub fn tier_covers(watcher_tier: Tier, event_tier: Tier) -> bool {
    watcher_tier >= event_tier
}

use sqlx::SqlitePool;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

#[derive(Debug, sqlx::FromRow)]
struct Watcher {
    user_id: i64,
    tier: String,
}

#[derive(Debug, sqlx::FromRow)]
struct Subscription {
    id: i64,
    endpoint: String,
    p256dh_key: String,
    auth_key: String,
}

/// Notifies every eligible watcher of `project_id` (other than `actor_id`,
/// the user who made the change) that the project changed.
///
/// Must be called only after the triggering mutation's transaction commits —
/// a slow or failed push send must never roll back the actual data change.
/// Failures are logged and swallowed; there is no retry queue (spec §8).
///
/// Runs on a spawned task so the caller's response is never blocked on push
/// delivery: `IsahcWebPushClient` is built fresh per call with no configured
/// timeout, so a single unresponsive push endpoint must not stall the
/// user-facing request that triggered this notification.
pub async fn notify_watchers(pool: &SqlitePool, project_id: i64, event_tier: Tier, actor_id: i64) {
    let pool = pool.clone();
    tokio::spawn(async move {
        notify_watchers_inner(&pool, project_id, event_tier, actor_id).await;
    });
}

async fn notify_watchers_inner(pool: &SqlitePool, project_id: i64, event_tier: Tier, actor_id: i64) {
    let project_name: Option<(String,)> = match sqlx::query_as(
        "SELECT name FROM projects WHERE id = ?",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row,
        Err(e) => {
            tracing::warn!("failed to load project {project_id}: {e}");
            return;
        }
    };
    let Some((project_name,)) = project_name else {
        return;
    };

    let watchers: Vec<Watcher> = match sqlx::query_as(
        "SELECT user_id, tier FROM project_watches WHERE project_id = ? AND notified_at IS NULL",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("failed to load watchers for project {project_id}: {e}");
            return;
        }
    };

    for watcher in watchers {
        if watcher.user_id == actor_id {
            // The user who made the change doesn't need to be told about it —
            // and notifying them would consume their debounce slot, deafening
            // them to the next real change from someone else.
            continue;
        }
        let Some(tier) = Tier::from_str_opt(&watcher.tier) else {
            continue;
        };
        if !tier_covers(tier, event_tier) {
            continue;
        }
        notify_one_watcher(pool, project_id, watcher.user_id, &project_name).await;
    }
}

async fn notify_one_watcher(pool: &SqlitePool, project_id: i64, user_id: i64, project_name: &str) {
    let subscriptions: Vec<Subscription> = match sqlx::query_as(
        "SELECT id, endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("failed to load subscriptions for user {user_id}: {e}");
            return;
        }
    };

    if !subscriptions.is_empty() {
        send_to_subscriptions(pool, project_id, project_name, subscriptions).await;
    }

    if let Err(e) = sqlx::query(
        "UPDATE project_watches SET notified_at = CURRENT_TIMESTAMP
         WHERE project_id = ? AND user_id = ?",
    )
    .bind(project_id)
    .bind(user_id)
    .execute(pool)
    .await
    {
        tracing::warn!(
            "failed to mark project {project_id} watch notified for user {user_id}: {e}"
        );
    }
}

async fn send_to_subscriptions(
    pool: &SqlitePool,
    project_id: i64,
    project_name: &str,
    subscriptions: Vec<Subscription>,
) {
    let vapid_private_key = match std::env::var("VAPID_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => {
            tracing::warn!("VAPID_PRIVATE_KEY not set, skipping push send");
            return;
        }
    };

    let client = match IsahcWebPushClient::new() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("failed to build web push client: {e}");
            return;
        }
    };

    let payload = serde_json::json!({
        "title": "Little Orderings",
        "body": format!("{project_name} has updates"),
        "url": format!("/projects/{project_id}"),
    });
    let payload_bytes = match serde_json::to_vec(&payload) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("failed to serialize push payload: {e}");
            return;
        }
    };

    for sub in subscriptions {
        let subscription_info = SubscriptionInfo::new(
            sub.endpoint.clone(),
            sub.p256dh_key.clone(),
            sub.auth_key.clone(),
        );

        let sig_builder =
            match VapidSignatureBuilder::from_base64(&vapid_private_key, &subscription_info) {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("failed to build VAPID signature builder: {e}");
                    continue;
                }
            };
        let vapid_signature = match sig_builder.build() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!("failed to sign VAPID claims: {e}");
                continue;
            }
        };

        let mut builder = WebPushMessageBuilder::new(&subscription_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, &payload_bytes);
        builder.set_vapid_signature(vapid_signature);

        let message = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("failed to build push message: {e}");
                continue;
            }
        };

        match client.send(message).await {
            Ok(()) => {}
            Err(WebPushError::EndpointNotValid(_)) | Err(WebPushError::EndpointNotFound(_)) => {
                if let Err(e) = sqlx::query("DELETE FROM push_subscriptions WHERE id = ?")
                    .bind(sub.id)
                    .execute(pool)
                    .await
                {
                    tracing::warn!(
                        "failed to delete dead subscription {}: {e}",
                        sub.id
                    );
                }
            }
            Err(e) => {
                tracing::warn!("push send failed for subscription {}: {e}", sub.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broader_tier_covers_narrower_events() {
        assert!(tier_covers(Tier::All, Tier::TaskMilestones));
        assert!(tier_covers(Tier::All, Tier::Milestones));
        assert!(tier_covers(Tier::All, Tier::All));
        assert!(tier_covers(Tier::Milestones, Tier::TaskMilestones));
        assert!(tier_covers(Tier::Milestones, Tier::Milestones));
        assert!(tier_covers(Tier::TaskMilestones, Tier::TaskMilestones));
    }

    #[test]
    fn narrower_tier_does_not_cover_broader_events() {
        assert!(!tier_covers(Tier::TaskMilestones, Tier::Milestones));
        assert!(!tier_covers(Tier::TaskMilestones, Tier::All));
        assert!(!tier_covers(Tier::Milestones, Tier::All));
    }
}
