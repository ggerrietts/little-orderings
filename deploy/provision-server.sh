#!/usr/bin/env bash
#
# One-time provisioning for the little-orderings deployment host.
# Run as root on a fresh Ubuntu 24.04 server. Idempotent — safe to re-run.
#
# Usage:
#   DATA_ROOT=/mnt/HC_Volume_106548799 ./provision-server.sh
#
# Env vars (all optional, defaults shown):
#   DATA_ROOT      /mnt/HC_Volume_106548799   Attached volume to store app + Caddy data on
#   DEPLOY_USER    deploy                     Non-root user created for `docker context` access
#   APP_UID        10001                      Must match the `app` user's uid in the Dockerfile
#   APP_NAME       little-orderings           Subdirectory name under DATA_ROOT
#   SWAP_SIZE_GB   2                          Swapfile size; cold Rust builds can OOM on 4GB RAM

set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/mnt/HC_Volume_106548799}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_UID="${APP_UID:-10001}"
APP_NAME="${APP_NAME:-little-orderings}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

echo "==> Updating apt and installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw

echo "==> Installing Docker Engine + Compose plugin"
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "    docker already installed, skipping"
fi

echo "==> Creating deploy user '${DEPLOY_USER}'"
if ! id -u "${DEPLOY_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${DEPLOY_USER}"
fi
usermod -aG docker "${DEPLOY_USER}"

echo "==> Authorizing deploy user for the same SSH key root uses"
# Membership in the `docker` group is root-equivalent (unrestricted access to the
# Docker socket) — this user is a deploy identity, not a low-privilege one.
mkdir -p "/home/${DEPLOY_USER}/.ssh"
if [[ -f /root/.ssh/authorized_keys ]]; then
  cp /root/.ssh/authorized_keys "/home/${DEPLOY_USER}/.ssh/authorized_keys"
else
  echo "    WARNING: /root/.ssh/authorized_keys not found — add a key for ${DEPLOY_USER} manually." >&2
fi
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
chmod 700 "/home/${DEPLOY_USER}/.ssh"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys" 2>/dev/null || true

echo "==> Configuring host firewall (defense-in-depth behind the Hetzner Cloud Firewall)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Preparing data directories on ${DATA_ROOT}"
if ! mountpoint -q "${DATA_ROOT}"; then
  echo "    WARNING: ${DATA_ROOT} is not a mount point — confirm the volume is attached" >&2
  echo "    and formatted before deploying, or data will land on the small root disk." >&2
fi
APP_DATA_DIR="${DATA_ROOT}/${APP_NAME}/app-data"
CADDY_DATA_DIR="${DATA_ROOT}/${APP_NAME}/caddy-data"
CADDY_CONFIG_DIR="${DATA_ROOT}/${APP_NAME}/caddy-config"
mkdir -p "${APP_DATA_DIR}" "${CADDY_DATA_DIR}" "${CADDY_CONFIG_DIR}"
# The app container runs as a fixed non-root uid (see Dockerfile); Caddy's official
# image runs as root, so its two directories don't need a chown.
chown -R "${APP_UID}:${APP_UID}" "${APP_DATA_DIR}"

echo "==> Setting up ${SWAP_SIZE_GB}GB swap (cold Rust builds can OOM on this box's RAM)"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  echo "    swapfile already active, skipping"
fi

cat <<EOF

==> Done.

Data directories (bind-mount targets for docker-compose.prod.yml):
  App data:     ${APP_DATA_DIR}
  Caddy data:    ${CADDY_DATA_DIR}
  Caddy config:  ${CADDY_CONFIG_DIR}

From your local machine:
  docker context create ${APP_NAME} --docker "host=ssh://${DEPLOY_USER}@todo.gerrietts.net"
  docker context use ${APP_NAME}

Then, from the repo root, with a real .env in place (see .env.example):
  DATA_ROOT=${DATA_ROOT} docker compose -f docker-compose.prod.yml up -d --build
EOF
