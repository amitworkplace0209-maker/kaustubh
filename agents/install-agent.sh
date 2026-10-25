#!/usr/bin/env bash
# KDS VM monitoring agent — installer / uninstaller.
#
# Installs ONE stdlib-only Python agent on a KDS VM:
#   * dedicated unprivileged service user `kds-agent`
#   * /opt/kds-agent/kds_vm_agent.py       (root-owned, read-only)
#   * /etc/kds/kds-agent.json              (0640 root:kds-agent, no secrets)
#   * /etc/kds/agent-token                 (0640 root:kds-agent, secret)
#   * /etc/kds/mongo-uri                   (optional, 0640 root:kds-agent)
#   * /etc/sudoers.d/kds-agent             (ONE exact systemctl restart rule)
#   * kds-agent.service + kds-agent.timer  (one heartbeat per minute)
#
# Run as root ON the target VM. Nothing is written outside the paths above.
# Re-running is safe: the unit files are replaced, the config is preserved
# unless --force is given, and the token is rewritten only when supplied.
#
# Examples
#   # VM1 (backend host). The API is expected on the private address only.
#   sudo bash ./install-agent.sh --vm-id vm1 \
#     --api-url http://10.1.1.133:8000 \
#     --token-file /root/vm1-agent-token
#
#   # VM2 (MongoDB host) with an authenticated ping (URI file already exists).
#   sudo bash ./install-agent.sh --vm-id vm2 \
#     --api-url http://10.1.1.133:8000 \
#     --token-file /root/vm2-agent-token \
#     --mongo-uri-file /root/mongo-monitor-uri
#
#   # Install but do not enable the timer yet.
#   sudo bash ./install-agent.sh --vm-id vm2 --api-url http://10.1.1.133:8000 \
#     --token-stdin --no-start < /root/vm2-agent-token
#
#   # Rollback (keeps the token/config unless --purge is also given).
#   sudo bash ./install-agent.sh --uninstall
#   sudo bash ./install-agent.sh --uninstall --purge
#
# The token is never echoed, never placed in argv and never logged.
set -euo pipefail
umask 027

AGENT_USER="kds-agent"
AGENT_DIR="/opt/kds-agent"
AGENT_BIN="${AGENT_DIR}/kds_vm_agent.py"
CONF_DIR="/etc/kds"
CONF_FILE="${CONF_DIR}/kds-agent.json"
TOKEN_FILE="${CONF_DIR}/agent-token"
MONGO_URI_FILE="${CONF_DIR}/mongo-uri"
STATE_DIR="/var/lib/kds-agent"
SUDOERS_FILE="/etc/sudoers.d/kds-agent"
UNIT_DIR="/etc/systemd/system"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_HEALTH_PATH="/health"

VM_ID=""
API_URL=""
HEALTH_URL=""
TOKEN_SRC=""
TOKEN_STDIN=0
MONGO_URI_SRC=""
BACKUP_DIR=""
BACKUP_GLOB=""
START=1
FORCE=0
UNINSTALL=0
PURGE=0

usage() {
  cat <<'USAGE'
Usage: install-agent.sh --vm-id vm1|vm2 --api-url URL (--token-file PATH | --token-stdin)
                        [--health-url URL] [--mongo-uri-file PATH]
                        [--backup-dir PATH --backup-glob GLOB]
                        [--no-start] [--force]

       install-agent.sh --uninstall [--purge]

  --vm-id vm1|vm2      Which host this is. vm1 allows only `kds-backend`
                       restarts, vm2 only `mongod`. Required for install.
  --api-url URL        KDS backend base URL reachable from this VM.
                       vm1: http://10.1.1.133:8000
                       vm2: http://10.1.1.133:8000 (private subnet)
  --token-file PATH    File containing this VM's agent token. The value is
                       copied to /etc/kds/agent-token and never printed.
  --token-stdin        Read the token from stdin instead of a file.
  --health-url URL     Override the backend health URL (default: API_URL/health).
  --mongo-uri-file P   vm2 only: a MongoDB URI for a read-only monitor user.
                       Enables the authenticated ping. The value is copied to
                       /etc/kds/mongo-uri and never printed. Omit to leave the
                       ping unconfigured (the UI shows it as not configured).
  --backup-dir PATH    vm2 only: directory holding real backup files. Omit
                       unless backups actually exist; the UI then reports
                       NOT_CONFIGURED rather than inventing a backup.
  --backup-glob GLOB   Filename pattern inside --backup-dir (default: *).
  --no-start           Install everything but leave the timer disabled.
  --force              Replace an existing /etc/kds/kds-agent.json (a
                       timestamped backup is written first).
  --uninstall          Stop and remove units, sudoers rule and timer. Config,
                       token and state are kept.
  --purge              With --uninstall: also remove config, token, state,
                       agent code and the kds-agent user.

Run as root. Install the backend API first on vm1, otherwise the agent cannot
deliver heartbeats and the UI correctly shows the VM as DISCONNECTED.
USAGE
  exit "${1:-0}"
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

while (($#)); do
  case "$1" in
    --vm-id) [ $# -ge 2 ] || die "--vm-id needs a value"; VM_ID="$2"; shift 2 ;;
    --api-url) [ $# -ge 2 ] || die "--api-url needs a value"; API_URL="$2"; shift 2 ;;
    --health-url) [ $# -ge 2 ] || die "--health-url needs a value"; HEALTH_URL="$2"; shift 2 ;;
    --token-file) [ $# -ge 2 ] || die "--token-file needs a value"; TOKEN_SRC="$2"; shift 2 ;;
    --token-stdin) TOKEN_STDIN=1; shift ;;
    --mongo-uri-file) [ $# -ge 2 ] || die "--mongo-uri-file needs a value"; MONGO_URI_SRC="$2"; shift 2 ;;
    --backup-dir) [ $# -ge 2 ] || die "--backup-dir needs a value"; BACKUP_DIR="$2"; shift 2 ;;
    --backup-glob) [ $# -ge 2 ] || die "--backup-glob needs a value"; BACKUP_GLOB="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (use --help)" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || die "run as root (sudo $0 ...)"

# ---------------------------------------------------------------------------
# uninstall / rollback
# ---------------------------------------------------------------------------
if [[ ${UNINSTALL} -eq 1 ]]; then
  step "Stopping timer and service"
  systemctl disable --now kds-agent.timer 2>/dev/null || true
  systemctl stop kds-agent.service 2>/dev/null || true
  rm -f "${UNIT_DIR}/kds-agent.timer" "${UNIT_DIR}/kds-agent.service"
  systemctl daemon-reload
  systemctl reset-failed kds-agent.service 2>/dev/null || true
  rm -f "${SUDOERS_FILE}"
  if command -v visudo >/dev/null 2>&1; then visudo -c >/dev/null; fi
  info "units, timer and sudoers rule removed"

  if [[ ${PURGE} -eq 1 ]]; then
    rm -f "${CONF_FILE}" "${TOKEN_FILE}" "${MONGO_URI_FILE}"
    rm -rf "${AGENT_DIR}" "${STATE_DIR}"
    if getent passwd "${AGENT_USER}" >/dev/null 2>&1; then
      userdel "${AGENT_USER}" 2>/dev/null || true
      info "service user ${AGENT_USER} removed"
    fi
    rmdir "${CONF_DIR}" 2>/dev/null || true
    info "config, token, state and agent code purged"
  else
    info "kept ${CONF_FILE}, ${TOKEN_FILE} and ${STATE_DIR} (use --purge to remove)"
  fi
  printf '\nUninstall complete. The API may show this VM as DISCONNECTED.\n'
  exit 0
fi

# ---------------------------------------------------------------------------
# preflight (no changes before every check passes)
# ---------------------------------------------------------------------------
step "Preflight"
[[ "${VM_ID}" == "vm1" || "${VM_ID}" == "vm2" ]] || die "--vm-id must be vm1 or vm2"
[[ -n "${API_URL}" ]] || die "--api-url is required (e.g. http://10.1.1.133:8000)"
[[ "${API_URL}" =~ ^https?://[A-Za-z0-9._~:/@%+=-]+$ ]] || die "--api-url must be a plain http(s) URL"
API_URL="${API_URL%/}"
if [[ -z "${HEALTH_URL}" ]]; then
  HEALTH_URL="${API_URL}${DEFAULT_HEALTH_PATH}"
fi
[[ "${HEALTH_URL}" =~ ^https?://[A-Za-z0-9._~:/@%+=-]+$ ]] || die "--health-url must be a plain http(s) URL"

if [[ ${TOKEN_STDIN} -eq 1 && -n "${TOKEN_SRC}" ]]; then
  die "choose either --token-file or --token-stdin, not both"
fi
if [[ ${TOKEN_STDIN} -eq 0 && -z "${TOKEN_SRC}" ]]; then
  die "a token is required: --token-file PATH or --token-stdin"
fi
TOKEN=""
if [[ -n "${TOKEN_SRC}" ]]; then
  [[ -r "${TOKEN_SRC}" ]] || die "cannot read token file: ${TOKEN_SRC}"
  TOKEN="$(tr -d '\r\n' < "${TOKEN_SRC}")"
else
  IFS= read -r TOKEN || true
  TOKEN="${TOKEN//$'\r'/}"
fi
[[ "${TOKEN}" =~ ^[A-Za-z0-9._~+/=-]{32,}$ ]] || die "token must be 32+ chars of [A-Za-z0-9._~+/=-]"

command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required"
[[ -x /usr/bin/systemctl ]] || die "/usr/bin/systemctl not found (the agent allowlist is pinned to it)"
[[ -r "${SCRIPT_DIR}/kds_vm_agent.py" ]] || die "kds_vm_agent.py not found next to this script"
[[ -r "${SCRIPT_DIR}/kds-agent.service" && -r "${SCRIPT_DIR}/kds-agent.timer" ]] || \
  die "kds-agent.service / kds-agent.timer not found next to this script"
getent group systemd-journal >/dev/null 2>&1 || die "missing systemd-journal group (needed to read failed-service logs)"
python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)' || die "python3 >= 3.8 required"

if [[ "${VM_ID}" == "vm1" ]]; then
  if ! systemctl cat kds-backend.service >/dev/null 2>&1; then
    info "warning: kds-backend.service is not installed on this VM yet"
    info "         the agent will report the unit as missing until it is deployed"
  fi
elif [[ "${VM_ID}" == "vm2" ]]; then
  # `systemctl cat` avoids the SIGPIPE/pipefail trap where `grep -q` exits
  # before systemctl finishes writing and the pipeline is misread as failure.
  systemctl cat mongod.service >/dev/null 2>&1 || \
    info "warning: mongod.service was not found; verify this is the MongoDB VM"
fi

MONGO_URI=""
if [[ -n "${MONGO_URI_SRC}" ]]; then
  [[ -r "${MONGO_URI_SRC}" ]] || die "cannot read Mongo URI file: ${MONGO_URI_SRC}"
  MONGO_URI="$(tr -d '\r\n' < "${MONGO_URI_SRC}")"
  [[ "${MONGO_URI}" =~ ^mongodb(\+srv)?://[^[:space:]]+$ ]] || die "Mongo URI must start with mongodb:// or mongodb+srv://"
  command -v mongosh >/dev/null 2>&1 || die "--mongo-uri-file needs mongosh on this host"
fi

if [[ -n "${BACKUP_DIR}" ]]; then
  [[ "${BACKUP_DIR}" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--backup-dir must be an absolute path"
  [[ -n "${BACKUP_GLOB}" ]] || BACKUP_GLOB="*"
  [[ "${BACKUP_GLOB}" =~ ^[A-Za-z0-9._*?/-]+$ ]] || die "--backup-glob has unsupported characters"
fi

RESTART_UNIT=""
if [[ "${VM_ID}" == "vm1" ]]; then RESTART_UNIT="kds-backend"; else RESTART_UNIT="mongod"; fi

NEW_CONF="$(mktemp)"
SELFTEST="$(mktemp)"
trap 'rm -f "${NEW_CONF:-}" "${SELFTEST:-}" "${TMP_TOKEN:-}" "${TMP_URI:-}" "${TMP_SUDO:-}"' EXIT

{
  printf '{\n'
  printf '  "vm_id": "%s",\n' "${VM_ID}"
  printf '  "api_url": "%s",\n' "${API_URL}"
  printf '  "token_file": "%s",\n' "${TOKEN_FILE}"
  printf '  "state_file": "%s/state.json",\n' "${STATE_DIR}"
  printf '  "services": ["%s"],\n' "${RESTART_UNIT}"
  printf '  "restart_allowlist": ["%s"],\n' "${RESTART_UNIT}"
  printf '  "journal_events": true,\n'
  printf '  "recovery_enabled": true,\n'
  if [[ "${VM_ID}" == "vm1" ]]; then
    printf '  "backend_health_url": "%s",\n' "${HEALTH_URL}"
    printf '  "mongo_tcp_target": "10.1.2.178:27017"\n'
  else
    if [[ -n "${MONGO_URI_SRC}" ]]; then
      printf '  "mongo_ping_enabled": true,\n'
      printf '  "mongo_uri_file": "%s",\n' "${MONGO_URI_FILE}"
    else
      printf '  "mongo_ping_enabled": false,\n'
    fi
    if [[ -n "${BACKUP_DIR}" ]]; then
      printf '  "backup_dir": "%s",\n' "${BACKUP_DIR}"
      printf '  "backup_glob": "%s",\n' "${BACKUP_GLOB}"
      printf '  "backup_max_age_hours": 30\n'
    else
      printf '  "backup_dir": "",\n'
      printf '  "backup_glob": ""\n'
    fi
  fi
  printf '}\n'
} > "${NEW_CONF}"

if [[ -f "${CONF_FILE}" ]]; then
  if cmp -s "${NEW_CONF}" "${CONF_FILE}"; then
    info "config is already up to date"
  elif [[ ${FORCE} -ne 1 ]]; then
    die "${CONF_FILE} exists and differs; inspect it, then re-run with --force to replace it (a timestamped backup is kept)"
  else
    BACKUP="${CONF_FILE}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    install -m 0640 -o root -g root "${CONF_FILE}" "${BACKUP}"
    info "existing config backed up to ${BACKUP}"
  fi
fi

info "vm_id=${VM_ID} api_url=${API_URL} restart_unit=${RESTART_UNIT}"
info "preflight passed; no changes have been made yet"

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------
step "Service user and directories"
if ! getent passwd "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${STATE_DIR}" --no-create-home \
          --shell /usr/sbin/nologin "${AGENT_USER}"
  info "created system user ${AGENT_USER}"
else
  info "system user ${AGENT_USER} already exists"
fi
install -d -m 0755 -o root -g root "${AGENT_DIR}"
install -d -m 0750 -o root -g "${AGENT_USER}" "${CONF_DIR}"
install -d -m 0750 -o "${AGENT_USER}" -g "${AGENT_USER}" "${STATE_DIR}"
install -m 0644 -o root -g root "${SCRIPT_DIR}/kds_vm_agent.py" "${AGENT_BIN}"
info "installed ${AGENT_BIN}"

step "Agent token"
TMP_TOKEN="$(mktemp)"
printf '%s' "${TOKEN}" > "${TMP_TOKEN}"
unset TOKEN
chmod 0640 "${TMP_TOKEN}"
chown "root:${AGENT_USER}" "${TMP_TOKEN}"
mv -f "${TMP_TOKEN}" "${TOKEN_FILE}"
chmod 0640 "${TOKEN_FILE}"
chown "root:${AGENT_USER}" "${TOKEN_FILE}"
info "wrote ${TOKEN_FILE} (0640 root:${AGENT_USER}); value not printed"

if [[ -n "${MONGO_URI_SRC}" ]]; then
  step "MongoDB URI"
  TMP_URI="$(mktemp)"
  printf '%s' "${MONGO_URI}" > "${TMP_URI}"
  unset MONGO_URI
  chmod 0640 "${TMP_URI}"
  chown "root:${AGENT_USER}" "${TMP_URI}"
  mv -f "${TMP_URI}" "${MONGO_URI_FILE}"
  chmod 0640 "${MONGO_URI_FILE}"
  chown "root:${AGENT_USER}" "${MONGO_URI_FILE}"
  info "wrote ${MONGO_URI_FILE} (0640 root:${AGENT_USER}); value not printed"
fi

step "Agent config"
install -m 0640 -o root -g "${AGENT_USER}" "${NEW_CONF}" "${CONF_FILE}"
info "wrote ${CONF_FILE} (0640 root:${AGENT_USER})"

step "Sudoers (exactly one restart command)"
TMP_SUDO="$(mktemp)"
cat > "${TMP_SUDO}" <<EOF
# Managed by KDS agents/install-agent.sh — one exact restart, no shell, no wildcard.
Defaults:kds-agent !lecture
kds-agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${RESTART_UNIT}
EOF
chmod 0440 "${TMP_SUDO}"
chown root:root "${TMP_SUDO}"
visudo -cf "${TMP_SUDO}" >/dev/null
install -m 0440 -o root -g root "${TMP_SUDO}" "${SUDOERS_FILE}"
rm -f "${TMP_SUDO}"
info "${SUDOERS_FILE}: kds-agent may run only 'systemctl restart ${RESTART_UNIT}'"

step "systemd units"
install -m 0644 -o root -g root "${SCRIPT_DIR}/kds-agent.service" "${UNIT_DIR}/kds-agent.service"
install -m 0644 -o root -g root "${SCRIPT_DIR}/kds-agent.timer" "${UNIT_DIR}/kds-agent.timer"
systemctl daemon-reload
info "installed kds-agent.service and kds-agent.timer"

step "Local collection self-test (no network)"
if sudo -u "${AGENT_USER}" /usr/bin/python3 "${AGENT_BIN}" --check > "${SELFTEST}" 2>&1; then
  python3 - "${SELFTEST}" <<'PY'
import json, sys
try:
    doc = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    doc = {}
metrics = doc.get("metrics") or {}
services = ", ".join(f"{s.get('name')}={s.get('active')}" for s in doc.get("services") or [])
print("  collected: cpu={cpu}% ram_available={ram}% disk_used={disk}% load1={load}".format(
    cpu=metrics.get("cpu_pct"), ram=metrics.get("mem_available_pct"),
    disk=metrics.get("disk_used_pct"), load=metrics.get("load1")))
print(f"  services:  {services or 'none'}")
PY
  info "self-test passed"
else
  sed -n '1,20p' "${SELFTEST}" >&2 || true
  die "self-test failed; the timer was NOT enabled"
fi

if [[ ${START} -eq 1 ]]; then
  step "Enable timer"
  systemctl enable --now kds-agent.timer >/dev/null
  info "kds-agent.timer enabled (30s after boot, then every 60s)"
  systemctl list-timers kds-agent.timer --no-pager || true
else
  step "Timer left disabled (--no-start)"
  info "enable later with: systemctl enable --now kds-agent.timer"
fi

printf '\nDone.\n'
printf '  logs:      journalctl -u kds-agent.service -n 50 --no-pager\n'
printf '  self-test: sudo -u %s python3 %s --check\n' "${AGENT_USER}" "${AGENT_BIN}"
printf '  next run:  systemctl list-timers kds-agent.timer\n'
printf '  rollback:  sudo bash %s --uninstall\n' "$0"
