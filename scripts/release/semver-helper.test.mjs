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

import {
  parseSemVer,
  compareSemVer,
  computeNextVersion,
  isBiweeklyReleaseWeek,
  hasSubstantivePackageChanges,
  resolveReleasePlan,
  generateReleaseNotesViaGitHubApi,
  verifyVersionHigherThanNpm,
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

      // Under the pre-release bump model, once gdc-cas-v0.1.0 is tagged:
      //  - snapshot runs resolve to next-patch (0.1.1-snapshot.<sha>)
      //  - release runs fail fast until package.json is bumped to the next version
      execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpRepo });
      execFileSync('git', ['config', 'tag.gpgSign', 'false'], { cwd: tmpRepo });
      execFileSync('git', ['add', '.'], { cwd: tmpRepo });
      execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tmpRepo });
      execFileSync('git', ['tag', '-a', 'gdc-cas-v0.1.0', '-m', 'Release gdc-cas-v0.1.0'], { cwd: tmpRepo });

      const postTagSnap = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'snapshot',
        repoRoot: tmpRepo,
        commitSha: 'abcdef1234567890',
      });
      assert.equal(postTagSnap.version, '0.1.1-snapshot.abcdef1');
      assert.equal(postTagSnap.lastTag, 'gdc-cas-v0.1.0');
      assert.equal(postTagSnap.needsPublish, false);

      assert.throws(
        () => resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'release', repoRoot: tmpRepo }),
        /Release tag 'gdc-cas-v0\.1\.0' already exists/
      );

      // After a pre-release bump PR updates package.json to 0.2.0, release resolves cleanly.
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'gdc-cas', version: '0.2.0' }));
      execFileSync('git', ['add', '.'], { cwd: tmpRepo });
      execFileSync('git', ['commit', '-q', '-m', 'chore(gdc-cas): bump version to 0.2.0'], { cwd: tmpRepo });
      const bumpedRel = resolveReleasePlan({ packageName: 'gdc-cas', releaseMode: 'release', repoRoot: tmpRepo });
      assert.equal(bumpedRel.version, '0.2.0');
      assert.equal(bumpedRel.gitTag, 'gdc-cas-v0.2.0');
      assert.equal(bumpedRel.lastTag, 'gdc-cas-v0.1.0');
      assert.equal(bumpedRel.needsPublish, true);

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

  it('compares SemVer 2.0.0 versions accurately including prereleases and multi-digit segments', () => {
    assert.equal(compareSemVer('0.1.0', '0.1.0'), 0);
    assert.equal(compareSemVer('0.1.1', '0.1.0'), 1);
    assert.equal(compareSemVer('0.1.0', '0.1.1'), -1);
    assert.equal(compareSemVer('0.10.0', '0.2.0'), 1);
    assert.equal(compareSemVer('1.0.0', '0.9.9'), 1);
    assert.equal(compareSemVer('0.1.0', '0.0.0-stage'), 1);
    assert.equal(compareSemVer('0.1.0', '0.1.0-rc.1'), 1);
    assert.equal(compareSemVer('0.1.0-rc.2', '0.1.0-rc.10'), -1);
  });

  it('enforces package.json version is strictly higher than npmjs.com published versions', async () => {
    // 1. Unpublished package (HTTP 404) passes for initial release.
    const firstPub = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.1.0',
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'Not found' }),
    });
    assert.equal(firstPub.ok, true);
    assert.equal(firstPub.publishedHighest, null);

    // 2. Strictly higher than latest & all published versions passes.
    const makeRegistry = (latest, versions) => async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'gdc-cas',
        'dist-tags': { latest },
        versions: Object.fromEntries(versions.map((v) => [v, { version: v }])),
      }),
    });

    const bumpOk = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.1.1',
      fetchImpl: makeRegistry('0.1.0', ['0.0.0-stage', '0.1.0']),
    });
    assert.equal(bumpOk.ok, true);
    assert.equal(bumpOk.publishedHighest, '0.1.0');
    assert.equal(bumpOk.latestTag, '0.1.0');

    // 3. Staged placeholder only (0.0.0-stage) allows 0.1.0.
    const afterStage = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.1.0',
      fetchImpl: makeRegistry('0.0.0-stage', ['0.0.0-stage']),
    });
    assert.equal(afterStage.ok, true);

    // 4. Equal version rejects.
    await assert.rejects(
      () =>
        verifyVersionHigherThanNpm({
          packageName: 'gdc-cas',
          targetVersion: '0.1.0',
          fetchImpl: makeRegistry('0.1.0', ['0.0.0-stage', '0.1.0']),
        }),
      /already published on npmjs\.com/
    );

    // 5. Lower version than npm latest rejects (prevents accidental downgrade).
    await assert.rejects(
      () =>
        verifyVersionHigherThanNpm({
          packageName: 'gdc-cas',
          targetVersion: '0.1.9',
          fetchImpl: makeRegistry('0.2.0', ['0.1.0', '0.2.0']),
        }),
      /must be strictly higher than what is published on npmjs\.com/
    );

    // 6. Lower than highest published version even if dist-tag latest points lower rejects.
    await assert.rejects(
      () =>
        verifyVersionHigherThanNpm({
          packageName: 'gdc-cas',
          targetVersion: '0.1.5',
          fetchImpl: makeRegistry('0.1.0', ['0.1.0', '0.2.0']),
        }),
      /must be strictly higher than what is published on npmjs\.com/
    );

    // 7. Retries transient HTTP 503 and succeeds.
    let attempts = 0;
    const retried = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.2.0',
      baseDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 503, text: async () => 'Service Unavailable' };
        return makeRegistry('0.1.0', ['0.1.0'])();
      },
    });
    assert.equal(attempts, 2);
    assert.equal(retried.ok, true);
  });

  it('evaluates strict 14-day biweekly release week parity across year boundaries', () => {
    // 2026-11-23 (v0.1.0 release Monday) -> even epoch week (release week)
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-11-23T12:00:00Z')).isReleaseWeek, true);
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-11-30T12:00:00Z')).isReleaseWeek, false);
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-12-07T12:00:00Z')).isReleaseWeek, true);
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-12-14T12:00:00Z')).isReleaseWeek, false);
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-12-21T12:00:00Z')).isReleaseWeek, true);
    assert.equal(isBiweeklyReleaseWeek(new Date('2026-12-28T12:00:00Z')).isReleaseWeek, false);
    // Crosses 53-week ISO year 2026 into 2027 without cadence drift
    assert.equal(isBiweeklyReleaseWeek(new Date('2027-01-04T12:00:00Z')).isReleaseWeek, true);
    assert.throws(() => isBiweeklyReleaseWeek('not-a-date'), /Invalid date value/);
  });

  it('skips scheduled biweekly releases cleanly when unchanged or version is not bumped', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'semver-biweekly-'));
    try {
      const pkgDir = path.join(tmpRepo, 'cas', 'gdc-cas');
      fs.mkdirSync(pkgDir, { recursive: true });
      const initPkg = { name: 'gdc-cas', version: '0.1.0', dependencies: { axios: '^1.9.0' } };
      const initLock = {
        name: 'gdc-cas',
        version: '0.1.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'gdc-cas', version: '0.1.0', dependencies: { axios: '^1.9.0' } },
          'node_modules/axios': { version: '1.9.0' },
        },
      };
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(initPkg, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify(initLock, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export const v = 1;\n');
      fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Root\n');

      const git = (...args) => execFileSync('git', args, { cwd: tmpRepo, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.name', 'Test');
      git('config', 'user.email', 'test@example.com');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'tag.gpgSign', 'false');
      git('add', '.');
      git('commit', '-q', '-m', 'initial 0.1.0');
      git('tag', '-a', 'gdc-cas-v0.1.0', '-m', 'Release gdc-cas-v0.1.0');

      // 1. Zero changes since last tag -> skip cleanly (not throw).
      assert.equal(
        hasSubstantivePackageChanges({ repoRoot: tmpRepo, lastTag: 'gdc-cas-v0.1.0', packageDir: 'cas/gdc-cas' }),
        false
      );
      const noDiffPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'release',
        repoRoot: tmpRepo,
        allowSkipWhenUnchanged: true,
      });
      assert.equal(noDiffPlan.shouldRun, false);
      assert.equal(noDiffPlan.needsPublish, false);
      assert.match(noDiffPlan.skipReason, /No substantive changes/);

      // 2. Non-package change (root README.md) -> still skip cleanly.
      fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Updated Root\n');
      git('add', '.');
      git('commit', '-q', '-m', 'docs: update root readme');
      const nonPkgPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'release',
        repoRoot: tmpRepo,
        allowSkipWhenUnchanged: true,
      });
      assert.equal(nonPkgPlan.shouldRun, false);
      assert.equal(nonPkgPlan.needsPublish, false);

      // 3. Version-only bump in package.json + package-lock.json with zero other changes -> skip cleanly.
      const bumpedOnlyPkg = { ...initPkg, version: '0.1.1' };
      const bumpedOnlyLock = {
        ...initLock,
        version: '0.1.1',
        packages: {
          ...initLock.packages,
          '': { ...initLock.packages[''], version: '0.1.1' },
        },
      };
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(bumpedOnlyPkg, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify(bumpedOnlyLock, null, 2));
      git('add', '.');
      git('commit', '-q', '-m', 'chore(gdc-cas): pre-stage 0.1.1 version');
      assert.equal(
        hasSubstantivePackageChanges({ repoRoot: tmpRepo, lastTag: 'gdc-cas-v0.1.0', packageDir: 'cas/gdc-cas' }),
        false
      );
      const versionOnlyPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'release',
        repoRoot: tmpRepo,
        allowSkipWhenUnchanged: true,
      });
      assert.equal(versionOnlyPlan.shouldRun, false);
      assert.equal(versionOnlyPlan.needsPublish, false);
      assert.match(versionOnlyPlan.skipReason, /No substantive changes/);

      // 4. Dependency update in package-lock.json while version stays 0.1.0 (already tagged) -> skip cleanly with reminder.
      const depUpdatedLock = {
        ...initLock,
        packages: {
          ...initLock.packages,
          'node_modules/axios': { version: '1.9.1' },
        },
      };
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(initPkg, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify(depUpdatedLock, null, 2));
      git('add', '.');
      git('commit', '-q', '-m', 'chore(deps): bump axios to 1.9.1');
      assert.equal(
        hasSubstantivePackageChanges({ repoRoot: tmpRepo, lastTag: 'gdc-cas-v0.1.0', packageDir: 'cas/gdc-cas' }),
        true
      );
      const unbumpedPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'release',
        repoRoot: tmpRepo,
        allowSkipWhenUnchanged: true,
      });
      assert.equal(unbumpedPlan.shouldRun, false);
      assert.equal(unbumpedPlan.needsPublish, false);
      assert.match(unbumpedPlan.skipReason, /already tagged.*bump package\.json/);

      // 5. Substantive change + bumped version (0.1.1) -> promote!
      const readyPkg = { ...initPkg, version: '0.1.1' };
      const readyLock = {
        ...depUpdatedLock,
        version: '0.1.1',
        packages: {
          ...depUpdatedLock.packages,
          '': { ...depUpdatedLock.packages[''], version: '0.1.1' },
        },
      };
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(readyPkg, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify(readyLock, null, 2));
      git('add', '.');
      git('commit', '-q', '-m', 'chore(gdc-cas): bump version to 0.1.1');
      const readyPlan = resolveReleasePlan({
        packageName: 'gdc-cas',
        releaseMode: 'release',
        repoRoot: tmpRepo,
        allowSkipWhenUnchanged: true,
      });
      assert.equal(readyPlan.shouldRun, true);
      assert.equal(readyPlan.needsPublish, true);
      assert.equal(readyPlan.version, '0.1.1');
      assert.equal(readyPlan.gitTag, 'gdc-cas-v0.1.1');

      // 6. Prerelease version in package.json still fails fast even in scheduled mode.
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ ...initPkg, version: '0.1.1-dev' }));
      assert.throws(
        () =>
          resolveReleasePlan({
            packageName: 'gdc-cas',
            releaseMode: 'release',
            repoRoot: tmpRepo,
            allowSkipWhenUnchanged: true,
          }),
        /Official release mode requires a clean X\.Y\.Z version/
      );
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it('skips already-published equal version on scheduled npm check but still rejects downgrades', async () => {
    const makeRegistry = (latest, versions) => async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'gdc-cas',
        'dist-tags': { latest },
        versions: Object.fromEntries(versions.map((v) => [v, { version: v }])),
      }),
    });

    // Equal to highest published -> skip cleanly in scheduled mode.
    const eqRes = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.1.0',
      allowSkipWhenAlreadyPublished: true,
      fetchImpl: makeRegistry('0.1.0', ['0.0.0-stage', '0.1.0']),
    });
    assert.equal(eqRes.ok, true);
    assert.equal(eqRes.skipped, true);
    assert.match(eqRes.skipReason, /already published on npmjs\.com/);

    // Strictly higher -> proceed in scheduled mode.
    const hiRes = await verifyVersionHigherThanNpm({
      packageName: 'gdc-cas',
      targetVersion: '0.1.1',
      allowSkipWhenAlreadyPublished: true,
      fetchImpl: makeRegistry('0.1.0', ['0.0.0-stage', '0.1.0']),
    });
    assert.equal(hiRes.ok, true);
    assert.equal(hiRes.skipped, false);

    // Strictly lower -> still fail even in scheduled mode (accidental downgrade).
    await assert.rejects(
      () =>
        verifyVersionHigherThanNpm({
          packageName: 'gdc-cas',
          targetVersion: '0.1.0',
          allowSkipWhenAlreadyPublished: true,
          fetchImpl: makeRegistry('0.2.0', ['0.1.0', '0.2.0']),
        }),
      /must be strictly higher than what is published on npmjs\.com/
    );
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
