import { VAPID_PUBLIC_KEY } from './config'

// frontend/src/config.ts ships a placeholder VAPID_PUBLIC_KEY until a real
// keypair is generated (see docs/deployment-brief.md §9) and the value is
// substituted by hand. The placeholder happens to be valid-looking base64,
// so nothing else fails if it's never replaced — PushManager.subscribe()
// would just silently produce a malformed key at runtime instead of
// erroring anywhere visible in CI or a build.
//
// This assertion is intentionally a pre-deploy gate: it FAILS until a human
// generates a real key with `cargo run -- vapid generate` and pastes the
// public half in here, mirroring how .env.example's SESSION_SECRET is left
// empty for the analogous backend secret. Unlike SESSION_SECRET, this value
// is compiled into the frontend bundle rather than read from the runtime
// environment, so an empty/placeholder value can't be caught by an
// env-var-presence check — a failing test is the safety net instead. A
// green test suite with the placeholder still in place is the bug this
// guards against; do not "fix" this by weakening the assertion.
test('VAPID_PUBLIC_KEY placeholder has been replaced with a real key', () => {
  expect(VAPID_PUBLIC_KEY).not.toBe('REPLACE_WITH_GENERATED_VAPID_PUBLIC_KEY')
})
