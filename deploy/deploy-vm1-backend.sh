#!/usr/bin/env bash
# ============================================================================
# KDS VM1 — Backend deployment and verification script
#
# Run on VM1 as root (or with sudo). This script:
#   1. Verifies git state (branch, commit, working tree)
#   2. Verifies the Python venv and dependencies
#   3. Validates /etc/kds/backend.env exists and has required variables
#   4. Installs the systemd service file
#   5. Starts the backend (single process, no reload)
#   6. Verifies health endpoint, MongoDB connection, restart behavior
#
# No secrets are printed. No firewall/SSH changes are made.
# ============================================================================
set -euo pipefail

REPO_DIR="/opt/kds/repo"
VENV_DIR="/opt/kds/venv"
BACKEND_DIR="${REPO_DIR}/python-service"
ENV_FILE="/etc/kds/backend.env"
SERVICE_FILE="/etc/systemd/system/kds-backend.service"
SERVICE_UNIT="kds-backend.service"
LOG_FILE="/var/log/kds-backend-deploy.log"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}"; }
die() { log "ERROR: $*"; exit 1; }

# ---------------------------------------------------------------------------
# 0. Preflight: must run as root
# ---------------------------------------------------------------------------
[[ ${EUID} -eq 0 ]] || die "Run as root (sudo $0 ...)"

log "=== KDS VM1 Backend Deployment Started ==="

# ---------------------------------------------------------------------------
# 1. Verify git state
# ---------------------------------------------------------------------------
log "Step 1: Checking git state in ${REPO_DIR}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  die "Not a git repository at ${REPO_DIR}"
fi

cd "${REPO_DIR}"

BRANCH=$(git branch --show-current 2>/dev/null || die "Cannot determine branch")
log "Current branch: ${BRANCH}"

if [[ "${BRANCH}" != "main" ]]; then
  die "Expected branch 'main', got '${BRANCH}' — switch to main before deploying"
fi

COMMIT=$(git rev-parse --short HEAD 2>/dev/null || die "Cannot read HEAD commit")
log "HEAD commit: ${COMMIT}"

# Check working tree status
STATUS=$(git status --porcelain 2>/dev/null || true)
if [[ -n "${STATUS}" ]]; then
  log "WARNING: Uncommitted changes detected (preserving them):"
  echo "${STATUS}" | while IFS= read -r line; do log "  ${line}"; done
else
  log "Working tree: clean"
fi

# Verify remote tracking
REMOTE_STATUS=$(git status --short --branch 2>/dev/null | head -1 || true)
log "Branch status: ${REMOTE_STATUS}"

# ---------------------------------------------------------------------------
# 2. Verify Python virtual environment and dependencies
# ---------------------------------------------------------------------------
log "Step 2: Verifying Python environment"

if [[ ! -x "${VENV_DIR}/bin/python" ]]; then
  die "Python venv not found at ${VENV_DIR}/bin/python"
fi

PYTHON_VERSION=$("${VENV_DIR}/bin/python" --version 2>&1)
log "Python: ${PYTHON_VERSION}"

# Check key dependencies are importable
for mod in fastapi uvicorn motor pydantic dnspython websockets; do
  if ! "${VENV_DIR}/bin/python" -c "import ${mod}" 2>/dev/null; then
    log "WARNING: Python module '${mod}' not importable — may need pip install"
  fi
done

log "Python environment OK"

# ---------------------------------------------------------------------------
# 3. Validate environment file
# ---------------------------------------------------------------------------
log "Step 3: Validating ${ENV_FILE}"

if [[ ! -f "${ENV_FILE}" ]]; then
  die "Environment file ${ENV_FILE} not found. Create it from deploy/vm1-backend.env.template first."
fi

# Check permissions
PERMS=$(stat -c '%a' "${ENV_FILE}")
OWNER=$(stat -c '%U' "${ENV_FILE}")
if [[ "${PERMS}" != "600" ]]; then
  die "${ENV_FILE} permissions are ${PERMS}, expected 600"
fi
if [[ "${OWNER}" != "root" ]]; then
  die "${ENV_FILE} owner is ${OWNER}, expected root"
fi

# Check required variables are set (do not print values)
REQUIRED_VARS=(
  MONGODB_URI
  MONGODB_DATABASE
  APP_USERNAME
  APP_PASSWORD
  JWT_SECRET
  AUTH_SESSION_SECRET
  AUTH_SIGNUP_EMAIL
  AUTH_SIGNUP_MPIN
  HOST
  PORT
  BROKER_MODE
  KOTAK_ENABLED
  SHOONYA_ENABLED
)

MISSING=0
for var in "${REQUIRED_VARS[@]}"; do
  if ! grep -q "^${var}=" "${ENV_FILE}" 2>/dev/null; then
    log "MISSING required variable: ${var}"
    MISSING=$((MISSING + 1))
  fi
done

if [[ ${MISSING} -gt 0 ]]; then
  die "${MISSING} required variable(s) missing from ${ENV_FILE}. Fill them in before starting."
fi

# Warn on placeholder values (do not print the values)
for var in MONGODB_URI APP_PASSWORD JWT_SECRET AUTH_SESSION_SECRET AUTH_SIGNUP_EMAIL AUTH_SIGNUP_MPIN CORS_ORIGINS; do
  if grep -q "^${var}=.*<REPLACE" "${ENV_FILE}" 2>/dev/null; then
    log "WARNING: ${var} still contains a placeholder value — replace before production use"
  fi
done

# Check security-critical settings
if grep -q "^HOST=0.0.0.0" "${ENV_FILE}" 2>/dev/null; then
  log "WARNING: HOST=0.0.0.0 exposes backend on all interfaces. Consider HOST=10.1.1.133 for production."
fi
if grep -q "^CORS_ORIGINS=\*" "${ENV_FILE}" 2>/dev/null; then
  log "WARNING: CORS_ORIGINS=* with credentials may cause FastAPI startup failure. Set specific origins."
fi
if grep -q "^BROKER_MODE=kotak" "${ENV_FILE}" 2>/dev/null; then
  log "WARNING: BROKER_MODE=kotak may attempt live broker login. Use dummy for verification."
fi
if grep -q "^KOTAK_ENABLED=true" "${ENV_FILE}" 2>/dev/null || ! grep -q "^KOTAK_ENABLED=false" "${ENV_FILE}" 2>/dev/null; then
  log "WARNING: KOTAK_ENABLED not explicitly false — scheduler may attempt real Kotak logins."
fi

log "Environment file validated"

# ---------------------------------------------------------------------------
# 4. Install systemd service
# ---------------------------------------------------------------------------
log "Step 4: Installing systemd service"

SERVICE_SRC="$(dirname "$0")/kds-backend.service"
if [[ ! -f "${SERVICE_SRC}" ]]; then
  die "Service file not found at ${SERVICE_SRC} (run this script from the deploy/ directory or copy kds-backend.service manually)"
fi

cp "${SERVICE_SRC}" "${SERVICE_FILE}"
chmod 644 "${SERVICE_FILE}"
systemctl daemon-reload
log "Service file installed at ${SERVICE_FILE}"

# ---------------------------------------------------------------------------
# 5. Start the backend (single process, no reload)
# ---------------------------------------------------------------------------
log "Step 5: Starting ${SERVICE_UNIT}"

# Stop any existing instance first (clean start)
systemctl stop "${SERVICE_UNIT}" 2>/dev/null || true
systemctl reset-failed "${SERVICE_UNIT}" 2>/dev/null || true

systemctl enable --now "${SERVICE_UNIT}" || die "Failed to start ${SERVICE_UNIT}"

log "Backend service started"

# ---------------------------------------------------------------------------
# 6. Verify health endpoint
# ---------------------------------------------------------------------------
log "Step 6: Verifying health endpoint"

HOST_VAL=$(grep '^HOST=' "${ENV_FILE}" | cut -d= -f2-)
PORT_VAL=$(grep '^PORT=' "${ENV_FILE}" | cut -d= -f2-)
HEALTH_URL="http://${HOST_VAL:-127.0.0.1}:${PORT_VAL:-8000}/api/system/health"

log "Probing ${HEALTH_URL}"

MAX_ATTEMPTS=30
for i in $(seq 1 "${MAX_ATTEMPTS}"); do
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${HEALTH_URL}" 2>/dev/null || echo "000")
  if [[ "${HTTP_CODE}" == "200" || "${HTTP_CODE}" == "503" ]]; then
    log "Health endpoint responded HTTP ${HTTP_CODE} (200=healthy, 503=degraded/MongoDB down)"
    break
  fi
  if [[ ${i} -eq ${MAX_ATTEMPTS} ]]; then
    die "Health endpoint did not respond after ${MAX_ATTEMPTS} attempts (last code: ${HTTP_CODE})"
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# 7. Verify service status
# ---------------------------------------------------------------------------
log "Step 7: Checking systemd status"

systemctl is-active "${SERVICE_UNIT}" --quiet && log "Service: active" || log "Service: NOT active"
systemctl is-enabled "${SERVICE_UNIT}" --quiet && log "Service: enabled" || log "Service: NOT enabled"

# ---------------------------------------------------------------------------
# 8. Verify MongoDB connectivity (redacted)
# ---------------------------------------------------------------------------
log "Step 8: MongoDB connectivity is verified via /api/system/health (database.connected field)"
log "Do not print the MongoDB URI. Check the health response for database.connected=true"

# Verify the VM1 owner-auth surface is really deployed (no secrets printed).
AUTH_STATUS_URL="http://${HOST_VAL:-127.0.0.1}:${PORT_VAL:-8000}/api/auth/status"
AUTH_STATUS_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${AUTH_STATUS_URL}" 2>/dev/null || echo "000")
if [[ "${AUTH_STATUS_CODE}" == "200" ]]; then
  log "Owner auth status endpoint: HTTP 200"
elif [[ "${AUTH_STATUS_CODE}" == "503" ]]; then
  log "WARNING: Owner auth status endpoint returned 503 (MongoDB unavailable)"
else
  log "WARNING: Owner auth status endpoint returned HTTP ${AUTH_STATUS_CODE} — expected 200"
fi

OPERATOR_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST \
  "http://${HOST_VAL:-127.0.0.1}:${PORT_VAL:-8000}/api/auth/operator-token" 2>/dev/null || echo "000")
if [[ "${OPERATOR_CODE}" == "401" || "${OPERATOR_CODE}" == "403" ]]; then
  log "Owner-token endpoint is session-gated: HTTP ${OPERATOR_CODE}"
elif [[ "${OPERATOR_CODE}" == "404" || "${OPERATOR_CODE}" == "405" ]]; then
  log "WARNING: Owner-token endpoint missing (HTTP ${OPERATOR_CODE}) — deployed code predates /api/auth/operator-token"
else
  log "WARNING: Unexpected owner-token response HTTP ${OPERATOR_CODE}"
fi

# ---------------------------------------------------------------------------
# 9. Verify restart behavior (bounded)
# ---------------------------------------------------------------------------
log "Step 9: Testing restart behavior"

systemctl restart "${SERVICE_UNIT}" || die "Restart failed"
sleep 3

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "${HEALTH_URL}" 2>/dev/null || echo "000")
if [[ "${HTTP_CODE}" == "200" || "${HTTP_CODE}" == "503" ]]; then
  log "Restart verified: health endpoint responds HTTP ${HTTP_CODE} after restart"
else
  log "WARNING: Health endpoint returned HTTP ${HTTP_CODE} after restart — investigate"
fi

# ---------------------------------------------------------------------------
# 10. Summary
# ---------------------------------------------------------------------------
log "=== KDS VM1 Backend Deployment Complete ==="
log "Service:    ${SERVICE_UNIT}"
log "Commit:     ${COMMIT}"
log "Branch:     ${BRANCH}"
log "Health URL: ${HEALTH_URL}"
log "Logs:       journalctl -u ${SERVICE_UNIT} -n 50 --no-pager"
log "Status:     systemctl status ${SERVICE_UNIT}"
log ""
log "Next: install VM1 agent (agents/install-agent.sh) then VM2 agent."
log "      Configure Vercel frontend with BACKEND_URL pointing to HTTPS endpoint."

exit 0
