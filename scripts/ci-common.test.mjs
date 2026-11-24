// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CI_COMMON = path.join(SCRIPT_DIR, 'ci-common.sh');

function runBash(snippet, extraEnv = {}) {
  return execFileSync(
    'bash',
    ['-c', `source "${CI_COMMON}" && ${snippet}`],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    }
  );
}

function runPrecheckWithEvent(eventName, payload, extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-common-test-'));
  const eventPath = path.join(tmpDir, 'event.json');
  const outputPath = path.join(tmpDir, 'github_output.txt');
  fs.writeFileSync(eventPath, JSON.stringify(payload));
  fs.writeFileSync(outputPath, '');

  try {
    const stdout = runBash('precheck_integration_trigger', {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: 'GoogleCloudPlatform/google-distributed-cloud-node',
      ...extraEnv,
    });
    const output = fs.readFileSync(outputPath, 'utf8');
    return { stdout, output };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('scripts/ci-common.sh authorization & security helpers', () => {
  it('accepts CODEOWNERS maintainers and rejects bots or unknown users', () => {
    runBash('is_authorized_maintainer "dilipkumar2k6" "NONE"');
    runBash('is_authorized_maintainer "sarathps93" "NONE"');
    runBash('is_authorized_maintainer "cmuuss" "NONE"');

    assert.throws(() => runBash('is_authorized_maintainer "renovate-bot" "COLLABORATOR"'));
    assert.throws(() => runBash('is_authorized_maintainer "dependabot[bot]" "CONTRIBUTOR"'));
    assert.throws(() => runBash('is_authorized_maintainer "random-external-user" "NONE"'));
  });

  it('recognizes authorized dependency bots and trusted bot forks only', () => {
    runBash('is_authorized_dependency_bot "renovate-bot"');
    runBash('is_authorized_dependency_bot "renovate[bot]"');
    runBash('is_authorized_dependency_bot "app/renovate"');
    runBash('is_authorized_dependency_bot "dependabot[bot]"');
    runBash('is_authorized_dependency_bot "app/dependabot"');

    assert.throws(() => runBash('is_authorized_dependency_bot "dilipkumar2k6"'));
    assert.throws(() => runBash('is_authorized_dependency_bot "renovate"'));
    assert.throws(() => runBash('is_authorized_dependency_bot "random[bot]"'));

    runBash('is_authorized_dependency_bot_fork "renovate-bot/GoogleCloudPlatform-_-google-distributed-cloud-node" "renovate-bot"');
    runBash('is_authorized_dependency_bot_fork "dependabot/repo" "dependabot[bot]"');

    assert.throws(() => runBash('is_authorized_dependency_bot_fork "attacker/repo" "renovate-bot"'));
    assert.throws(() => runBash('is_authorized_dependency_bot_fork "renovate-bot/repo" "attacker"'));
  });

  it('defers renovate-bot fork PRs cleanly without failing precheck', () => {
    const { stdout, output } = runPrecheckWithEvent('pull_request', {
      pull_request: {
        number: 28,
        author_association: 'CONTRIBUTOR',
        user: { login: 'renovate-bot' },
        head: {
          sha: '0000000000000000000000000000000000000000',
          repo: { full_name: 'renovate-bot/GoogleCloudPlatform-_-google-distributed-cloud-node' },
        },
      },
    });
    assert.match(stdout, /Deferring GDC Staging integration test/);
    assert.match(output, /^should_run=false$/m);
  });

  it('allows same-repo pull requests authored by renovate[bot] or dependabot[bot]', () => {
    for (const botLogin of ['renovate[bot]', 'dependabot[bot]', 'renovate-bot']) {
      const { output } = runPrecheckWithEvent('pull_request', {
        pull_request: {
          number: 42,
          author_association: 'NONE',
          user: { login: botLogin },
          head: {
            sha: '0000000000000000000000000000000000000000',
            repo: { full_name: 'GoogleCloudPlatform/google-distributed-cloud-node' },
          },
        },
      });
      assert.match(output, /^should_run=true$/m);
    }
  });

  it('still blocks untrusted external forks and bot /test-integration comments', () => {
    assert.throws(() =>
      runPrecheckWithEvent('pull_request', {
        pull_request: {
          number: 99,
          author_association: 'NONE',
          user: { login: 'random-external-user' },
          head: {
            sha: '0000000000000000000000000000000000000000',
            repo: { full_name: 'random-external-user/google-distributed-cloud-node' },
          },
        },
      })
    );

    assert.throws(() =>
      runPrecheckWithEvent('pull_request', {
        pull_request: {
          number: 100,
          author_association: 'NONE',
          user: { login: 'renovate-bot' },
          head: {
            sha: '0000000000000000000000000000000000000000',
            repo: { full_name: 'untrusted-org/google-distributed-cloud-node' },
          },
        },
      })
    );

    assert.throws(() =>
      runPrecheckWithEvent('issue_comment', {
        issue: { number: 99, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/99' } },
        comment: {
          id: 123,
          body: '/test-integration',
          author_association: 'CONTRIBUTOR',
          user: { login: 'renovate-bot' },
        },
      })
    );
  });

  it('masks multi-line secret values line-by-line in GitHub Actions mode', () => {
    const out = runBash(
      'mask_secret_value "{\n  \\"private_key_id\\": \\"secret-id-1\\",\n  \\"private_key\\": \\"line-a\\"\n}"',
      { GITHUB_ACTIONS: 'true' }
    );
    assert.match(out, /::add-mask::"private_key_id": "secret-id-1",/);
    assert.match(out, /::add-mask::"private_key": "line-a"/);
    assert.doesNotMatch(out, /::add-mask::\{$/m);
  });

  it('retries transient command failures with bounded backoff before succeeding or failing', () => {
    const okOut = runBash(`
      tmp_state="$(mktemp)"
      echo 0 > "\${tmp_state}"
      flaky_cmd() {
        local c
        c=$(cat "\${tmp_state}")
        c=$((c + 1))
        echo "\${c}" > "\${tmp_state}"
        [[ "\${c}" -ge 3 ]]
      }
      retry_with_backoff 4 0 flaky_cmd
      cat "\${tmp_state}"
      rm -f "\${tmp_state}"
    `);
    assert.equal(okOut.trim(), '3');

    assert.throws(() => runBash('retry_with_backoff 2 0 false'));
  });
});
