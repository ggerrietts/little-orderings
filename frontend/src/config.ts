// Non-secret — sent in the clear on every push subscription request, and
// safe to commit. Generate a real keypair with `cargo run -- vapid generate`
// (see src/main.rs); this placeholder must be replaced with that command's
// VAPID_PUBLIC_KEY output, and the matching VAPID_PRIVATE_KEY must be set in
// the server's .env (see .env.example) — they are two halves of one keypair.
export const VAPID_PUBLIC_KEY = 'BFWHpGYKzdBAnzVvm6QhguKTruC9Iqt4FDLB1IrzTIiIILuPGZ0UM94pV3zMOAhzLlB0GsUIscR83DytcbM4erM'
