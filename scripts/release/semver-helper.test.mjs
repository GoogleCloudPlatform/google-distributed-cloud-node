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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSemVer,
  computeNextVersion,
  resolveReleasePlan,
  generateReleaseNotesViaGitHubApi,
  appendDashboardRun,
} from './semver-helper.mjs';

describe('semver-helper', () => {
  it('parses valid SemVer strings and rejects malformed versions', () => {
    assert.deepEqual(parseSemVer('0.1.0'), { major: 0, minor: 1, patch: 0, prerelease: '' });
    assert.deepEqual(parseSemVer('0.1.0-snapshot.abc1234'), {
      major: 0,
      minor: 1,
      patch: 0,
      prerelease: 'snapshot.abc1234',
    });
    assert.throws(() => parseSemVer('v0.1'), /Invalid SemVer/);
  });

  it('computes post-release SemVer bumps accurately', () => {
    assert.equal(computeNextVersion('0.1.0', 'noop'), '0.1.0');
    assert.equal(computeNextVersion('0.1.0', 'bump-patch'), '0.1.1');
    assert.equal(computeNextVersion('0.1.0', 'bump-minor'), '0.2.0');
    assert.equal(computeNextVersion('0.1.0', 'bump-major'), '1.0.0');
  });

  it('resolves snapshot vs release plans accurately', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-plan-'));
    try {
      const pkgDir = path.join(tmpRepo, 'cas', 'gdc-cas');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'gdc-cas', version: '0.1.0' }));

      const snapPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'snapshot',
        repoRoot: tmpRepo,
        commitSha: '1234567890abcdef',
      });
      assert.equal(snapPlan.version, '0.1.0-snapshot.1234567');
      assert.equal(snapPlan.gitTag, '-');
      assert.equal(snapPlan.npmDistTag, '');
      assert.equal(snapPlan.needsPublish, false);

      const relPlan = resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'release', repoRoot: tmpRepo });
      assert.equal(relPlan.version, '0.1.0');
      assert.equal(relPlan.gitTag, 'gdc-cas-v0.1.0');
      assert.equal(relPlan.npmDistTag, 'latest');
      assert.equal(relPlan.needsPublish, true);

      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'gdc-cas', version: '0.1.0-dev' }));
      assert.throws(
        () => resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'release', repoRoot: tmpRepo }),
        /Official release mode requires a clean X\.Y\.Z version/
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('prepares release notes via GitHub generate-notes REST API', async () => {
    let capturedCall = null;
    const mockFetch = async (url, init) => {
      capturedCall = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          name: 'gdc-cas-v0.1.0',
          body: "## What's Changed\n* feat(cas): prepare gdc-cas 0.1.0 by @maintainer in #16\n",
        }),
      };
    };

    const res = await generateReleaseNotesViaGitHubApi({
      repoSlug: 'GoogleCloudPlatform/google-distributed-cloud-node',
      gitTag: 'gdc-cas-v0.1.0',
      targetCommitish: '540d4d9',
      previousTag: 'gdc-cas-v0.0.9',
      token: 'ghs_test_token',
      apiBaseUrl: 'https://api.github.com/',
      fetchImpl: mockFetch,
    });

    assert.equal(
      capturedCall.url,
      'https://api.github.com/repos/GoogleCloudPlatform/google-distributed-cloud-node/releases/generate-notes'
    );
    assert.equal(capturedCall.init.method, 'POST');
    assert.equal(capturedCall.init.headers.Authorization, 'Bearer ghs_test_token');
    assert.deepEqual(capturedCall.body, {
      tag_name: 'gdc-cas-v0.1.0',
      target_commitish: '540d4d9',
      previous_tag_name: 'gdc-cas-v0.0.9',
    });
    assert.equal(res.name, 'gdc-cas-v0.1.0');
    assert.match(res.body, /## What's Changed/);

    // Verify transient HTTP 502 / network failures retry before succeeding, while HTTP 404 fails fast
    let transientAttempts = 0;
    const retried = await generateReleaseNotesViaGitHubApi({
      repoSlug: 'GoogleCloudPlatform/google-distributed-cloud-node',
      gitTag: 'gdc-cas-v0.1.0',
      token: 'ghs_test_token',
      baseDelayMs: 0,
      fetchImpl: async () => {
        transientAttempts += 1;
        if (transientAttempts === 1) throw new TypeError('fetch failed');
        if (transientAttempts === 2) return { ok: false, status: 502, text: async () => 'Bad Gateway' };
        return { ok: true, status: 200, json: async () => ({ name: 'gdc-cas-v0.1.0', body: '## Notes' }) };
      },
    });
    assert.equal(transientAttempts, 3);
    assert.equal(retried.body, '## Notes');

    let permanentAttempts = 0;
    await assert.rejects(
      () =>
        generateReleaseNotesViaGitHubApi({
          repoSlug: 'GoogleCloudPlatform/google-distributed-cloud-node',
          gitTag: 'gdc-cas-v0.1.0',
          token: 'ghs_test_token',
          baseDelayMs: 0,
          fetchImpl: async () => {
            permanentAttempts += 1;
            return { ok: false, status: 404, text: async () => 'Not Found' };
          },
        }),
      /HTTP 404/
    );
    assert.equal(permanentAttempts, 1);
  });

  it('deduplicates and prepends runs with releaseNotes in runs.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-json-'));
    try {
      const runsFile = path.join(tmpDir, 'runs.json');
      appendDashboardRun(runsFile, { runId: '100', status: 'running' });
      const res = appendDashboardRun(runsFile, {
        runId: '100',
        status: 'success',
        releaseMode: 'release',
        releaseNotes: "## What's Changed\n* Initial release",
      });
      assert.equal(res.length, 1);
      assert.equal(res[0].status, 'success');
      assert.match(res[0].releaseNotes, /Initial release/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
