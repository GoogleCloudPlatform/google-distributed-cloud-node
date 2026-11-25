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

/**
 * SemVer resolution (`snapshot` vs `release`) under the pre-release bump model
 * (where `package.json` on `main` matches the latest published npm version until
 * bumped in a pre-release PR), GitHub API release-notes preparation, and GitHub
 * Pages `runs.json` ledger updater for Node.js SDK releases.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PACKAGE_REGISTRY = {
  'gdc-cas': {
    dir: 'cas/gdc-cas',
    tagPrefix: 'gdc-cas-v',
  },
};

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseSemVer(version) {
  const match = String(version || '').trim().match(SEMVER_RE);
  if (!match) {
    throw new Error(`Invalid SemVer 2.0 version '${version}'. Expected X.Y.Z or X.Y.Z-prerelease.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || '',
  };
}

/**
 * Compares two SemVer 2.0.0 version strings.
 * Returns -1 if a < b, 0 if a == b, and 1 if a > b.
 */
export function compareSemVer(a, b) {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  if (!pa.prerelease && !pb.prerelease) return 0;
  if (!pa.prerelease) return 1;
  if (!pb.prerelease) return -1;

  const aIds = pa.prerelease.split('.');
  const bIds = pb.prerelease.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i += 1) {
    if (i >= aIds.length) return -1;
    if (i >= bIds.length) return 1;
    const ai = aIds[i];
    const bi = bIds[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) > Number(bi) ? 1 : -1;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ai > bi ? 1 : -1;
  }
  return 0;
}

export function computeNextVersion(currentVersion, bumpOp) {
  const parsed = parseSemVer(currentVersion);
  switch (bumpOp) {
    case 'noop':
      return currentVersion;
    case 'bump-patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
    case 'bump-minor':
      return `${parsed.major}.${parsed.minor + 1}.0`;
    case 'bump-major':
      return `${parsed.major + 1}.0.0`;
    default:
      throw new Error(`Unsupported next_version operation '${bumpOp}'. Expected bump-patch, bump-minor, bump-major, or noop.`);
  }
}

export function resolveReleasePlan({ packageName, releaseMode, repoRoot = process.cwd(), commitSha = '' }) {
  const pkgMeta = PACKAGE_REGISTRY[packageName];
  if (!pkgMeta) {
    throw new Error(`Unknown package '${packageName}'. Supported: ${Object.keys(PACKAGE_REGISTRY).join(', ')}`);
  }
  if (!['snapshot', 'release'].includes(releaseMode)) {
    throw new Error(`Invalid release_mode '${releaseMode}'. Expected 'snapshot' or 'release'.`);
  }

  const pkgJsonPath = path.join(repoRoot, pkgMeta.dir, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const baseVersion = String(pkgJson.version || '').trim();
  const parsed = parseSemVer(baseVersion);

  if (releaseMode === 'release' && parsed.prerelease) {
    throw new Error(
      `Official release mode requires a clean X.Y.Z version in ${pkgMeta.dir}/package.json (found '${baseVersion}').`
    );
  }

  let shortSha = String(commitSha || '').trim().slice(0, 7);
  if (!shortSha) {
    try {
      shortSha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      shortSha = '';
    }
  }

  const candidateTag = `${pkgMeta.tagPrefix}${baseVersion}`;
  let tagAlreadyExists = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${candidateTag}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    tagAlreadyExists = true;
  } catch {
    tagAlreadyExists = false;
  }

  if (releaseMode === 'release' && tagAlreadyExists) {
    throw new Error(
      `Release tag '${candidateTag}' already exists for ${pkgMeta.dir}/package.json version '${baseVersion}'. ` +
        `Under the pre-release bump model, open and merge a PR bumping ${pkgMeta.dir}/package.json (and package-lock.json) to the next SemVer version before triggering release_mode=release.`
    );
  }

  const snapshotBaseVer = tagAlreadyExists
    ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
    : `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const version = releaseMode === 'snapshot'
    ? (shortSha ? `${snapshotBaseVer}-snapshot.${shortSha}` : `${snapshotBaseVer}-snapshot`)
    : baseVersion;
  const gitTag = releaseMode === 'snapshot' ? '-' : candidateTag;
  const npmDistTag = releaseMode === 'release' ? 'latest' : '';

  let lastTag = '';
  try {
    lastTag = execFileSync(
      'git',
      ['describe', '--tags', '--abbrev=0', '--match', `${pkgMeta.tagPrefix}*`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    lastTag = '';
  }

  let hasChanges = true;
  if (lastTag) {
    try {
      execFileSync(
        'git',
        ['diff', '--quiet', `${lastTag}..HEAD`, '--', pkgMeta.dir],
        { cwd: repoRoot }
      );
      hasChanges = false;
    } catch {
      hasChanges = true;
    }
  }

  return {
    packageName,
    packageDir: pkgMeta.dir,
    version,
    gitTag,
    npmDistTag,
    lastTag,
    needsPublish: releaseMode === 'release' && hasChanges,
  };
}

/**
 * Calls GitHub's official REST API (`POST /repos/{owner}/{repo}/releases/generate-notes`)
 * to prepare structured release notes for `release` mode runs.
 */
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function generateReleaseNotesViaGitHubApi({
  repoSlug,
  gitTag,
  targetCommitish,
  previousTag = '',
  token = '',
  apiBaseUrl = process.env.GITHUB_API_URL || 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  baseDelayMs = 1000,
}) {
  if (!repoSlug || !repoSlug.includes('/')) {
    throw new Error(`Invalid repository slug '${repoSlug}'. Expected 'owner/repo'.`);
  }
  if (!gitTag || gitTag === '-') {
    throw new Error(`Valid gitTag is required to generate release notes (got '${gitTag}').`);
  }
  if (!token) {
    throw new Error('GH_TOKEN is required to call the GitHub release notes API.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch implementation is required (Node.js 22+).');
  }

  const base = String(apiBaseUrl).replace(/\/+$/, '');
  const url = `${base}/repos/${repoSlug}/releases/generate-notes`;
  const payload = {
    tag_name: gitTag,
  };
  if (targetCommitish) {
    payload.target_commitish = targetCommitish;
  }
  if (previousTag) {
    payload.previous_tag_name = previousTag;
  }

  let attempt = 1;
  let delayMs = baseDelayMs;
  while (true) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify(payload),
      });
    } catch (netErr) {
      if (attempt >= maxAttempts) {
        throw new Error(`GitHub generate-notes API network failure after ${attempt} attempts: ${netErr?.message || netErr}`);
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
      attempt += 1;
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      return {
        name: String(data?.name || gitTag),
        body: String(data?.body || '').trim(),
      };
    }

    const errText = await response.text().catch(() => '');
    if (attempt >= maxAttempts || !RETRYABLE_HTTP_STATUS.has(response.status)) {
      throw new Error(`GitHub generate-notes API failed (HTTP ${response.status}): ${errText}`);
    }

    const retryAfterSec = Number(response.headers?.get?.('retry-after') || 0);
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : delayMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs *= 2;
    }
    attempt += 1;
  }
}

/**
 * Verifies that `targetVersion` from `package.json` on `main` is strictly higher
 * (per SemVer 2.0.0) than every version currently published on npmjs.com
 * (including `dist-tags.latest` and all entries in `.versions`).
 * Allows initial first-time publication when the registry returns HTTP 404.
 */
export async function verifyVersionHigherThanNpm({
  packageName,
  targetVersion,
  registryBaseUrl = process.env.NPM_REGISTRY_URL || 'https://registry.npmjs.org',
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  baseDelayMs = 1000,
}) {
  if (!packageName || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(packageName)) {
    throw new Error(`Invalid package name '${packageName}'.`);
  }
  parseSemVer(targetVersion);
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch implementation is required (Node.js 22+).');
  }

  const base = String(registryBaseUrl).replace(/\/+$/, '');
  const encodedPkg = packageName.replace(/\//g, '%2F');
  const url = `${base}/${encodedPkg}`;

  let attempt = 1;
  let delayMs = baseDelayMs;
  while (true) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (netErr) {
      if (attempt >= maxAttempts) {
        throw new Error(`npm registry lookup network failure after ${attempt} attempts: ${netErr?.message || netErr}`);
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
      attempt += 1;
      continue;
    }

    if (response.status === 404) {
      return {
        ok: true,
        packageName,
        targetVersion,
        publishedHighest: null,
        latestTag: null,
      };
    }

    if (response.ok) {
      const data = await response.json();
      const versionsObj = data?.versions && typeof data.versions === 'object' ? data.versions : {};
      const distTags = data?.['dist-tags'] && typeof data['dist-tags'] === 'object' ? data['dist-tags'] : {};
      const latestTag = typeof distTags.latest === 'string' && SEMVER_RE.test(distTags.latest.trim())
        ? distTags.latest.trim()
        : null;

      if (Object.prototype.hasOwnProperty.call(versionsObj, targetVersion)) {
        throw new Error(
          `Version '${targetVersion}' of '${packageName}' is already published on npmjs.com (latest: '${latestTag || 'none'}'). ` +
            `Bump package.json (and package-lock.json) in a PR to a strictly higher SemVer version before running release_mode=release.`
        );
      }

      const publishedVersions = Object.keys(versionsObj).filter((v) => SEMVER_RE.test(v));
      if (latestTag && !publishedVersions.includes(latestTag)) {
        publishedVersions.push(latestTag);
      }

      let publishedHighest = null;
      for (const v of publishedVersions) {
        if (!publishedHighest || compareSemVer(v, publishedHighest) > 0) {
          publishedHighest = v;
        }
      }

      if (publishedHighest && compareSemVer(targetVersion, publishedHighest) <= 0) {
        throw new Error(
          `Version '${targetVersion}' in package.json must be strictly higher than what is published on npmjs.com ` +
            `(highest published: '${publishedHighest}', latest dist-tag: '${latestTag || 'none'}'). ` +
            `Bump package.json (and package-lock.json) in a PR before running release_mode=release.`
        );
      }

      return {
        ok: true,
        packageName,
        targetVersion,
        publishedHighest,
        latestTag,
      };
    }

    const errText = await response.text().catch(() => '');
    if (attempt >= maxAttempts || !RETRYABLE_HTTP_STATUS.has(response.status)) {
      throw new Error(`npm registry lookup failed for '${packageName}' (HTTP ${response.status}): ${errText}`);
    }

    const retryAfterSec = Number(response.headers?.get?.('retry-after') || 0);
    const waitMs = retryAfterSec > 0 ? retryAfterSec * 1000 : delayMs;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      delayMs *= 2;
    }
    attempt += 1;
  }
}

export function appendDashboardRun(runsFilePath, newEntry, maxEntries = 200) {
  let existing = [];
  if (fs.existsSync(runsFilePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(runsFilePath, 'utf8'));
      if (Array.isArray(raw)) existing = raw;
    } catch {
      existing = [];
    }
  }
  const filtered = existing.filter((r) => String(r.runId) !== String(newEntry.runId));
  const updated = [newEntry, ...filtered].slice(0, maxEntries);
  fs.mkdirSync(path.dirname(runsFilePath), { recursive: true });
  fs.writeFileSync(runsFilePath, JSON.stringify(updated, null, 2) + '\n');
  return updated;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cmd = process.argv[2];
  if (cmd === 'resolve') {
    const plan = resolveReleasePlan({
      packageName: process.env.PACKAGE_NAME || 'gdc-cas',
      releaseMode: process.env.RELEASE_MODE || 'snapshot',
      commitSha: process.env.COMMIT_SHA || '',
    });
    if (process.env.GITHUB_OUTPUT) {
      const lines = [
        `package_name=${plan.packageName}`,
        `package_dir=${plan.packageDir}`,
        `version=${plan.version}`,
        `git_tag=${plan.gitTag}`,
        `npm_dist_tag=${plan.npmDistTag}`,
        `last_tag=${plan.lastTag}`,
        `needs_publish=${plan.needsPublish}`,
      ];
      fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
    }
    console.log(JSON.stringify(plan, null, 2));
  } else if (cmd === 'prepare-notes') {
    const outputFile = process.argv[3];
    if (!outputFile) {
      console.error('Usage: node semver-helper.mjs prepare-notes <output-markdown-path>');
      process.exit(1);
    }
    const result = await generateReleaseNotesViaGitHubApi({
      repoSlug: process.env.REPO_SLUG || '',
      gitTag: process.env.GIT_TAG || '',
      targetCommitish: process.env.COMMIT_SHA || '',
      previousTag: process.env.LAST_TAG || '',
      token: process.env.GH_TOKEN || '',
    });
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, `${result.body}\n`, 'utf8');
    console.log(result.body);
  } else if (cmd === 'check-npm') {
    const res = await verifyVersionHigherThanNpm({
      packageName: process.env.PACKAGE_NAME || 'gdc-cas',
      targetVersion: process.env.TARGET_VERSION || '',
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (cmd === 'bump') {
    const nextVer = computeNextVersion(process.env.CURRENT_VERSION || '', process.env.NEXT_VERSION_OP || 'noop');
    console.log(nextVer);
  } else if (cmd === 'append-run') {
    const targetFile = process.argv[3];
    const releaseMode = process.env.RELEASE_MODE || 'snapshot';
    let releaseNotes = '';
    const notesFile = process.env.RELEASE_NOTES_FILE || '';
    if (releaseMode === 'release' && notesFile && fs.existsSync(notesFile)) {
      releaseNotes = fs.readFileSync(notesFile, 'utf8').trim();
    } else if (releaseMode === 'release' && process.env.RELEASE_NOTES) {
      releaseNotes = String(process.env.RELEASE_NOTES).trim();
    }
    const entry = {
      runId: process.env.RUN_ID || '',
      runNumber: process.env.RUN_NUMBER || '',
      timestamp: new Date().toISOString(),
      package: process.env.PACKAGE_NAME || 'gdc-cas',
      releaseMode,
      trigger: process.env.TRIGGER_EVENT || 'manual',
      actor: process.env.ACTOR || '',
      status: process.env.OVERALL_STATUS || 'failure',
      version: process.env.PACKAGE_VERSION || '-',
      tag: process.env.GIT_TAG || '-',
      commitSha: process.env.COMMIT_SHA || '',
      duration: process.env.DURATION || 'N/A',
      runUrl: process.env.RUN_URL || '',
      stages: {
        authorize: process.env.STAGE_AUTHORIZE || 'skipped',
        notes: process.env.STAGE_NOTES || 'skipped',
        staging: process.env.STAGE_STAGING || 'skipped',
        publish: process.env.STAGE_PUBLISH || 'skipped',
        verifyNpm: process.env.STAGE_VERIFY_NPM || 'skipped',
      },
      ...(releaseNotes ? { releaseNotes } : {}),
      ...(process.env.RELEASE_URL ? { releaseUrl: process.env.RELEASE_URL } : {}),
    };
    appendDashboardRun(targetFile, entry);
  } else {
    console.error(`Unknown subcommand '${cmd}'. Expected resolve, check-npm, prepare-notes, bump, or append-run.`);
    process.exit(1);
  }
}
