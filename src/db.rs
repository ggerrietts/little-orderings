use sqlx::{sqlite::SqliteConnectOptions, SqlitePool};
use std::str::FromStr;

pub async fn init() -> SqlitePool {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");

    let options = SqliteConnectOptions::from_str(&database_url)
        .expect("Invalid DATABASE_URL")
        .create_if_missing(true)
        .pragma("foreign_keys", "ON");

    let pool = SqlitePool::connect_with(options)
        .await
        .expect("Failed to connect to database");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    pool
}
