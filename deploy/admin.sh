#!/usr/bin/env bash
#
# Administrative CLI for the little-orderings production deployment.
# Runs from your local machine; drives the server over SSH. Does not use
# `docker context` — docker-compose.prod.yml bind-mounts ./Caddyfile, and
# bind-mount sources are resolved by whichever engine runs the command, so
# `docker compose` has to actually execute on the server, not just target it.
#
# Usage:
#   deploy/admin.sh sync
#   deploy/admin.sh restart
#   deploy/admin.sh add-user <username> <email> <password>
#   deploy/admin.sh set-password <username> <new-password>
#
# Env vars (all optional, defaults shown):
#   DEPLOY_HOST   todo.gerrietts.net   Server hostname
#   DEPLOY_USER   deploy               SSH user (created by provision-server.sh)
#   REMOTE_DIR    little-orderings     Deploy directory, relative to DEPLOY_USER's home
#
# User management runs against the `app` service, not `init-user` — `init-user`
# has a fixed `entrypoint: sh -c "..."` that ignores any command `docker
# compose run` appends, so `docker compose run --rm init-user ./little-orderings
# user create ...` (as documented in the README) silently no-ops instead of
# creating the named user. `app` has no entrypoint override, so the command
# passed to `run` actually executes.

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-todo.gerrietts.net}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REMOTE_DIR="${REMOTE_DIR:-little-orderings}"
TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args...]

Commands:
  sync                                  Copy docker-compose.prod.yml, Caddyfile, and
                                         .env.example to the server
  push-env                              Push deploy/prod.env (gitignored, local-only) to
                                         the server as .env — kept separate from sync
                                         since overwriting secrets is a bigger deal than
                                         overwriting the compose file
  restart                               Pull the latest image and (re)start the stack
  add-user <username> <email> <password>
                                         Create a user
  set-password <username> <new-password>
                                         Change a user's password

Env vars: DEPLOY_HOST (${DEPLOY_HOST}), DEPLOY_USER (${DEPLOY_USER}), REMOTE_DIR (${REMOTE_DIR})
EOF
}

remote_user_cmd() {
  local sub="$1"; shift
  local q_args=()
  for a in "$@"; do
    q_args+=("$(printf '%q' "$a")")
  done
  # shellcheck disable=SC2029  # intentional: expand locally, quote each arg individually
  ssh "${TARGET}" "cd ${REMOTE_DIR} && docker compose -f docker-compose.yml run --rm app ./little-orderings user ${sub} ${q_args[*]}"
}

cmd_sync() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  ssh "${TARGET}" "mkdir -p ${REMOTE_DIR}"
  scp "${repo_root}/docker-compose.prod.yml" "${TARGET}:${REMOTE_DIR}/docker-compose.yml"
  scp "${repo_root}/Caddyfile" "${TARGET}:${REMOTE_DIR}/Caddyfile"
  scp "${repo_root}/.env.example" "${TARGET}:${REMOTE_DIR}/.env.example"
  if ! ssh "${TARGET}" "test -f ${REMOTE_DIR}/.env"; then
    echo "NOTE: ${REMOTE_DIR}/.env does not exist on the server yet." >&2
    echo "      cp .env.example to .env there, fill in real values, chmod 600." >&2
  fi
}

cmd_push_env() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ ! -f "${repo_root}/deploy/prod.env" ]]; then
    echo "deploy/prod.env not found. Bootstrap it once, then fill in new keys:" >&2
    echo "  scp ${TARGET}:${REMOTE_DIR}/.env deploy/prod.env" >&2
    exit 1
  fi
  scp "${repo_root}/deploy/prod.env" "${TARGET}:${REMOTE_DIR}/.env"
  ssh "${TARGET}" "chmod 600 ${REMOTE_DIR}/.env"
}

cmd_restart() {
  ssh "${TARGET}" "cd ${REMOTE_DIR} && docker compose -f docker-compose.yml pull && docker compose -f docker-compose.yml up -d"
}

cmd_add_user() {
  [[ $# -eq 3 ]] || { echo "Usage: $(basename "$0") add-user <username> <email> <password>" >&2; exit 1; }
  remote_user_cmd create "$@"
}

cmd_set_password() {
  [[ $# -eq 2 ]] || { echo "Usage: $(basename "$0") set-password <username> <new-password>" >&2; exit 1; }
  remote_user_cmd set-password "$@"
}

case "${1:-}" in
  sync) cmd_sync ;;
  push-env) cmd_push_env ;;
  restart|start) cmd_restart ;;
  add-user) shift; cmd_add_user "$@" ;;
  set-password) shift; cmd_set_password "$@" ;;
  *) usage; exit 1 ;;
esac
