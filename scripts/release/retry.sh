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

# Bounded exponential-backoff retry wrapper for transient CI / registry / API errors.
# Usage: ./scripts/release/retry.sh <max_attempts> <base_delay_seconds> <command...>

set -euo pipefail

max_attempts="${1:?max_attempts is required}"
base_delay="${2:?base_delay is required}"
shift 2

attempt=1
delay="${base_delay}"
exit_code=0

while true; do
  if "$@"; then
    exit 0
  else
    exit_code=$?
  fi

  if [[ "${attempt}" -ge "${max_attempts}" ]]; then
    echo "::warning::Command failed after ${attempt} attempts (exit ${exit_code}): $*" >&2
    exit "${exit_code}"
  fi

  echo "Transient failure on attempt ${attempt}/${max_attempts} (exit ${exit_code}); retrying in ${delay}s: $*" >&2
  if [[ "${delay}" != "0" ]]; then
    sleep "${delay}"
    delay=$(( delay * 2 ))
  fi
  attempt=$(( attempt + 1 ))
done
