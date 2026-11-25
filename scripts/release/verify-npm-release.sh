#!/usr/bin/env bash
# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# Post-publish verification for official npm releases:
#   1. Polls the npm registry until `<pkg>@<version>` is promoted onto the target dist-tag
#      (accounting for Google OSS Exit Gate + npm staged first-publish latency).
#   2. Verifies published tarball SHA-512 integrity (SRI) against the certified artifact.
#   3. Installs `<pkg>@<version>` into a clean isolated consumer project.
#   4. Executes the live GDC Air-gapped Staging integration suite against the installed npm package.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${GITHUB_WORKSPACE:-$(cd "${SCRIPT_DIR}/../.." && pwd)}"
cd "${REPO_ROOT}"

# shellcheck source=scripts/ci-common.sh
source "${REPO_ROOT}/scripts/ci-common.sh"

PKG_NAME="${PKG_NAME:-}"
PKG_VERSION="${PKG_VERSION:-}"
NPM_DIST_TAG="${NPM_DIST_TAG:-latest}"
EXPECTED_TARBALL_SRI="${EXPECTED_TARBALL_SRI:-}"
NPM_REGISTRY_URL="${NPM_REGISTRY_URL:-https://registry.npmjs.org}"
POLL_INTERVAL_SECS="${POLL_INTERVAL_SECS:-15}"
MAX_WAIT_SECS="${MAX_WAIT_SECS:-720}"
OFFLINE_SELFTEST="${VERIFY_NPM_OFFLINE_SELFTEST:-false}"

if ! [[ "${PKG_NAME}" =~ ^(@[a-z0-9._-]+/)?[a-z0-9._-]+$ ]]; then
  echo "::error::Invalid PKG_NAME '${PKG_NAME}'."
  exit 1
fi
if ! [[ "${PKG_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::Invalid PKG_VERSION '${PKG_VERSION}'."
  exit 1
fi
if ! [[ "${NPM_DIST_TAG}" =~ ^[a-zA-Z0-9._-]+$ ]]; then
  echo "::error::Invalid NPM_DIST_TAG '${NPM_DIST_TAG}'."
  exit 1
fi
if ! [[ "${POLL_INTERVAL_SECS}" =~ ^[0-9]+$ && "${MAX_WAIT_SECS}" =~ ^[0-9]+$ ]]; then
  echo "::error::POLL_INTERVAL_SECS and MAX_WAIT_SECS must be non-negative integers."
  exit 1
fi

WORK_DIR="$(mktemp -d /tmp/gdc-npm-verify.XXXXXX)"
chmod 700 "${WORK_DIR}"
SA_FILE="${GDC_CAS_SA_FILE:-${WORK_DIR}/sa.json}"
CA_FILE="${GDC_CAS_CA_FILE:-${WORK_DIR}/ca.crt}"
CONSUMER_DIR="${WORK_DIR}/consumer"
mkdir -p "${CONSUMER_DIR}"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT INT TERM

registry_base="${NPM_REGISTRY_URL%/}"
encoded_pkg="${PKG_NAME//\//%2F}"
meta_url="${registry_base}/${encoded_pkg}"
meta_file="${WORK_DIR}/registry-meta.json"

echo "=== 1. Polling npm registry for ${PKG_NAME}@${PKG_VERSION} (dist-tag: ${NPM_DIST_TAG}) ==="
start_epoch="$(date -u +%s)"
published_sri=""
published_tarball=""

while true; do
  http_code="$(
    unset GDC_CAS_STAGING_SA_KEY GDC_CAS_STAGING_CA_CERT GH_TOKEN
    curl -sS -o "${meta_file}" -w '%{http_code}' -H 'Accept: application/json' "${meta_url}" || echo "000"
  )"

  if [[ "${http_code}" == "200" ]] && jq -e '.' "${meta_file}" >/dev/null 2>&1; then
    has_version="$(jq -r --arg v "${PKG_VERSION}" 'if (.versions // {})[$v] != null then "true" else "false" end' "${meta_file}")"
    current_tag="$(jq -r --arg t "${NPM_DIST_TAG}" '(."dist-tags" // {})[$t] // empty' "${meta_file}")"
    if [[ "${has_version}" == "true" && "${current_tag}" == "${PKG_VERSION}" ]]; then
      published_sri="$(jq -r --arg v "${PKG_VERSION}" '.versions[$v].dist.integrity // empty' "${meta_file}")"
      published_tarball="$(jq -r --arg v "${PKG_VERSION}" '.versions[$v].dist.tarball // empty' "${meta_file}")"
      echo "Published version ${PKG_NAME}@${PKG_VERSION} is live on dist-tag '${NPM_DIST_TAG}'."
      echo "Registry tarball: ${published_tarball}"
      echo "Registry integrity: ${published_sri}"
      break
    fi
    echo "Package metadata fetched (HTTP 200), waiting for ${PKG_VERSION} on dist-tag '${NPM_DIST_TAG}' (has_version=${has_version}, current_tag=${current_tag:-none})..."
  else
    echo "Registry returned HTTP ${http_code} for ${meta_url}; waiting for OSS Exit Gate publication..."
  fi

  now_epoch="$(date -u +%s)"
  elapsed=$(( now_epoch - start_epoch ))
  if [[ "${elapsed}" -ge "${MAX_WAIT_SECS}" ]]; then
    echo "::error::Timed out after ${elapsed}s waiting for ${PKG_NAME}@${PKG_VERSION} to appear on ${meta_url} (dist-tag: ${NPM_DIST_TAG})."
    exit 1
  fi
  sleep "${POLL_INTERVAL_SECS}"
done

if [[ -n "${EXPECTED_TARBALL_SRI}" ]]; then
  if [[ "${published_sri}" != "${EXPECTED_TARBALL_SRI}" ]]; then
    echo "::error::Published tarball integrity mismatch! Expected '${EXPECTED_TARBALL_SRI}', got '${published_sri}'."
    exit 1
  fi
  echo "Verified published tarball SHA-512 integrity matches certified release artifact."
fi

echo "=== 2. Installing published ${PKG_NAME}@${PKG_VERSION} into isolated consumer project ==="
cat > "${CONSUMER_DIR}/package.json" <<'EOF'
{
  "name": "gdc-npm-release-verifier",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
EOF

install_args=(install --no-audit --no-fund "${PKG_NAME}@${PKG_VERSION}")
if [[ "${registry_base}" != "https://registry.npmjs.org" ]]; then
  install_args=(install --registry="${registry_base}" --no-audit --no-fund "${PKG_NAME}@${PKG_VERSION}")
fi

(
  unset GDC_CAS_STAGING_SA_KEY GDC_CAS_STAGING_CA_CERT GH_TOKEN
  cd "${CONSUMER_DIR}"
  retry_with_backoff 4 5 npm "${install_args[@]}"
)

(
  unset GDC_CAS_STAGING_SA_KEY GDC_CAS_STAGING_CA_CERT GH_TOKEN
  cd "${CONSUMER_DIR}"
  VERIFY_PKG_NAME="${PKG_NAME}" \
  VERIFY_PKG_VERSION="${PKG_VERSION}" \
  VERIFY_EXPECTED_SRI="${EXPECTED_TARBALL_SRI}" \
  node -e '
    const fs = require("node:fs");
    const name = process.env.VERIFY_PKG_NAME;
    const version = process.env.VERIFY_PKG_VERSION;
    const expectedSri = process.env.VERIFY_EXPECTED_SRI;
    const pkg = JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`, "utf8"));
    if (pkg.name !== name || pkg.version !== version) {
      throw new Error(`Installed package mismatch: got ${pkg.name}@${pkg.version}, expected ${name}@${version}`);
    }
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const entry = (lock.packages || {})[`node_modules/${name}`] || {};
    if (expectedSri && entry.integrity !== expectedSri) {
      throw new Error(`Installed lockfile integrity mismatch: got ${entry.integrity}, expected ${expectedSri}`);
    }
    console.log(`Verified installed package: ${pkg.name}@${pkg.version} (${entry.resolved || "resolved"})`);
  '
)

if [[ "${PKG_NAME}" != "gdc-cas" ]]; then
  echo "No Staging integration suite registered for '${PKG_NAME}'; installation verification succeeded."
  exit 0
fi

STAGING_TEST_SCRIPT="${CI_TRUSTED_DIR:-${REPO_ROOT}}/cas/integration/staging.test.js"
cp "${STAGING_TEST_SCRIPT}" "${CONSUMER_DIR}/staging.test.js"

if [[ "${OFFLINE_SELFTEST}" == "true" ]]; then
  echo "=== 3. Running offline self-test against installed ${PKG_NAME}@${PKG_VERSION} ==="
  (
    unset GDC_CAS_STAGING_SA_KEY GDC_CAS_STAGING_CA_CERT GH_TOKEN
    cd "${CONSUMER_DIR}"
    GDC_CAS_OFFLINE_SELFTEST=true node --test staging.test.js
  )
  exit 0
fi

ORG="${GDC_ORG:-}"
ZONE="${GDC_ZONE:-}"
LAB_URL="${GDC_LAB_URL:-}"
CAS_PROJECT="${GDC_CAS_PROJECT:-}"
CAS_CA_NAME="${GDC_CAS_CA_NAME:-}"

setup_gdc_staging_credentials \
  "${SA_FILE}" \
  "${CA_FILE}" \
  "${ORG}" \
  "${ZONE}" \
  "${LAB_URL}" \
  "${GDC_CAS_STAGING_SA_KEY:-}" \
  "${GDC_CAS_STAGING_CA_CERT:-}"
unset GDC_CAS_STAGING_SA_KEY GDC_CAS_STAGING_CA_CERT

if [[ -z "${CAS_PROJECT}" && -s "${SA_FILE}" ]]; then
  CAS_PROJECT="$(jq -r '.project // empty' "${SA_FILE}")"
fi

echo "=== 3. Executing live GDC Air-gapped Staging CAS Integration Suite (UC1-UC6) against installed ${PKG_NAME}@${PKG_VERSION} ==="
(
  cd "${CONSUMER_DIR}"
  GDC_CAS_SA_FILE="${SA_FILE}" \
  GDC_CAS_CA_FILE="${CA_FILE}" \
  GDC_ZONE="${ZONE}" \
  GDC_CAS_PROJECT="${CAS_PROJECT}" \
  GDC_CAS_CA_NAME="${CAS_CA_NAME}" \
  node --test staging.test.js
)
