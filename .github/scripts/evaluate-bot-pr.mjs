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

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STAGING_INTEGRATION_CHECK_NAME = 'CAS Integration Test (GDC Staging)';

export const DEFAULT_FAST_REQUIRED_CHECKS = [
  'Unit Tests',
  'Check (Syntax & Build)',
  'cla/google',
];

export const DEFAULT_REQUIRED_CHECKS = [
  ...DEFAULT_FAST_REQUIRED_CHECKS,
  STAGING_INTEGRATION_CHECK_NAME,
];

const SELF_CHECK_NAMES = new Set([
  'Approve & Enable Auto-Merge',
  'Certify Bot PRs (GDC Staging)',
  'Renovate Auto-Merge',
]);

const BLOCKING_LABELS = new Set([
  'hold',
  'do-not-merge',
  'do-not-merge/hold',
  'wip',
]);

const PASSING_CONCLUSIONS = new Set([
  'SUCCESS',
  'NEUTRAL',
  'SKIPPED',
]);

const AUTHORIZED_BOT_FORK_OWNERS = new Set([
  'renovate-bot',
  'renovate',
  'dependabot',
  'renovate[bot]',
  'dependabot[bot]',
]);

/**
 * Returns true if the PR author is an authorized dependency update bot.
 * Supports GoogleCloudPlatform's `renovate-bot` user as well as GitHub App
 * bots `renovate[bot]` and `dependabot[bot]`.
 */
export function isAuthorizedBotAuthor(author) {
  if (!author || !author.login) return false;
  const login = String(author.login).toLowerCase();
  const type = String(author.__typename || '');

  if (login === 'renovate-bot' || login === 'renovate[bot]' || login === 'app/renovate') {
    return true;
  }
  if (login === 'dependabot[bot]' || login === 'app/dependabot') {
    return true;
  }
  if ((login === 'renovate' || login === 'dependabot') && type === 'Bot') {
    return true;
  }
  return false;
}

/**
 * Verifies that a bot PR comes either from the base repository itself or from
 * an authorized dependency-bot fork owner. If head repository metadata is
 * omitted (e.g. minimal fixtures without repo fields), returns true.
 */
export function isAuthorizedBotHeadRepository(pr, repoFullName = '') {
  const headRepoName = String(pr?.headRepository?.nameWithOwner || '').toLowerCase();
  const headOwnerLogin = String(pr?.headRepositoryOwner?.login || '').toLowerCase();
  const normalizedBaseRepo = String(repoFullName || '').toLowerCase();

  if (!headRepoName && !headOwnerLogin) {
    return true;
  }
  if (normalizedBaseRepo && headRepoName && headRepoName === normalizedBaseRepo) {
    return true;
  }
  const owner = headOwnerLogin || (headRepoName.includes('/') ? headRepoName.split('/')[0] : '');
  return AUTHORIZED_BOT_FORK_OWNERS.has(owner);
}

function parseLeadingMajor(versionStr) {
  if (!versionStr) return null;
  const match = String(versionStr).trim().match(/^[~^><=v\s]*(\d+)(?:\.\d+)?(?:\.\d+)?/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

/**
 * Detects whether a Renovate or Dependabot PR includes a SemVer major version bump.
 */
export function isMajorDependencyUpdate(pr) {
  const labels = (pr.labels?.nodes || []).map((l) => String(l.name || '').toLowerCase());
  if (labels.includes('major')) {
    return true;
  }

  const body = String(pr.body || '');
  // Renovate table format: `^1.2.0` → `^2.0.0` or `1.4.0` -> `2.0.2`
  const transitionRegex = /`([^`]+)`\s*(?:→|->)\s*`([^`]+)`/g;
  let match;
  while ((match = transitionRegex.exec(body)) !== null) {
    const oldMajor = parseLeadingMajor(match[1]);
    const newMajor = parseLeadingMajor(match[2]);
    if (oldMajor !== null && newMajor !== null && newMajor > oldMajor) {
      return true;
    }
  }

  const title = String(pr.title || '');
  // Dependabot title format: Bump <pkg> from 1.2.3 to 2.0.0
  const depMatch = title.match(/\bfrom\s+([^\s]+)\s+to\s+([^\s]+)/i);
  if (depMatch) {
    const oldMajor = parseLeadingMajor(depMatch[1]);
    const newMajor = parseLeadingMajor(depMatch[2]);
    if (oldMajor !== null && newMajor !== null && newMajor > oldMajor) {
      return true;
    }
  }

  // Renovate major title format: "update dependency <pkg> to v2" (major-only target)
  if (/\bto\s+v\d+\b(?![.\d])/i.test(title)) {
    return true;
  }

  return false;
}

/**
 * Deduplicates statusCheckRollup contexts by check name, retaining the most recent
 * CheckRun (by completedAt/startedAt) when a check has been re-run.
 */
function normalizeChecks(contexts) {
  const byName = new Map();
  for (const ctx of contexts) {
    if (!ctx) continue;
    const isCheckRun = ctx.__typename === 'CheckRun' || Object.prototype.hasOwnProperty.call(ctx, 'conclusion');
    const name = isCheckRun ? ctx.name : ctx.context;
    if (!name || SELF_CHECK_NAMES.has(name)) continue;

    const status = isCheckRun
      ? String(ctx.status || '').toUpperCase()
      : (String(ctx.state || '').toUpperCase() === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED');
    const conclusion = isCheckRun
      ? String(ctx.conclusion || '').toUpperCase()
      : String(ctx.state || '').toUpperCase();
    const timestamp = Date.parse(ctx.completedAt || ctx.startedAt || ctx.createdAt || '') || 0;

    const prev = byName.get(name);
    if (!prev || timestamp >= prev.timestamp) {
      byName.set(name, { name, status, conclusion, timestamp });
    }
  }
  return byName;
}

function checkCommonBotPreconditions(pr, repoFullName) {
  if (!pr) {
    return { action: 'skip', reasons: ['Pull request data not found.'] };
  }
  if (pr.state !== 'OPEN') {
    return { action: 'skip', reasons: [`PR #${pr.number} is not open (state=${pr.state}).`] };
  }
  if (pr.isDraft) {
    return { action: 'skip', reasons: [`PR #${pr.number} is a draft.`] };
  }
  if (pr.baseRefName !== 'main') {
    return { action: 'skip', reasons: [`PR #${pr.number} targets '${pr.baseRefName}', not 'main'.`] };
  }
  if (!isAuthorizedBotAuthor(pr.author)) {
    return {
      action: 'skip',
      reasons: [`PR #${pr.number} author '${pr.author?.login || 'unknown'}' is not an authorized dependency bot.`],
    };
  }
  if (!isAuthorizedBotHeadRepository(pr, repoFullName)) {
    return {
      action: 'skip',
      reasons: [
        `PR #${pr.number} head repository '${pr.headRepository?.nameWithOwner || pr.headRepositoryOwner?.login || 'unknown'}' is not an authorized dependency bot fork.`,
      ],
    };
  }

  const labels = (pr.labels?.nodes || []).map((l) => String(l.name || '').toLowerCase());
  const foundBlockingLabels = labels.filter((l) => BLOCKING_LABELS.has(l));
  if (foundBlockingLabels.length > 0) {
    return {
      action: 'block',
      reasons: [`PR #${pr.number} has blocking label(s): ${foundBlockingLabels.join(', ')}.`],
    };
  }

  return null;
}

/**
 * Evaluates whether an authorized dependency-bot PR should have the
 * GDC Staging CAS integration suite executed on its current HEAD commit by the
 * trusted `Renovate Auto-Merge` workflow on `main`.
 */
export function evaluateBotPRForStaging(pr, options = {}) {
  const {
    requiredFastChecks = DEFAULT_FAST_REQUIRED_CHECKS,
    stagingCheckName = STAGING_INTEGRATION_CHECK_NAME,
    forceRetest = false,
    repoFullName = '',
  } = options;

  const failure = checkCommonBotPreconditions(pr, repoFullName);
  if (failure) {
    return { shouldTest: false, ...failure };
  }

  const reasons = [];

  const changeRequests = (pr.latestReviews?.nodes || []).filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changeRequests.length > 0) {
    const reviewers = changeRequests.map((r) => r.author?.login || 'unknown').join(', ');
    reasons.push(`PR has CHANGES_REQUESTED review(s) from: ${reviewers}.`);
  }

  const headCommit = pr.commits?.nodes?.[0]?.commit;
  const rollup = headCommit?.statusCheckRollup;
  if (!rollup || !rollup.contexts) {
    reasons.push('No status checks found on the latest commit.');
  } else {
    if (rollup.contexts.pageInfo?.hasNextPage) {
      reasons.push('More than 100 status checks on HEAD; refusing to run staging without full inspection.');
    }
    const checksByName = normalizeChecks(rollup.contexts.nodes || []);

    for (const reqName of requiredFastChecks) {
      const check = checksByName.get(reqName);
      if (!check) {
        reasons.push(`Required check '${reqName}' has not reported on HEAD.`);
      } else if (check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS') {
        reasons.push(`Required check '${reqName}' is not passing (status=${check.status}, conclusion=${check.conclusion || 'NONE'}).`);
      }
    }

    for (const check of checksByName.values()) {
      if (check.name === stagingCheckName) {
        continue;
      }
      if (check.status !== 'COMPLETED') {
        reasons.push(`Check '${check.name}' is still incomplete (status=${check.status}).`);
      } else if (!PASSING_CONCLUSIONS.has(check.conclusion)) {
        reasons.push(`Check '${check.name}' did not pass (conclusion=${check.conclusion || 'NONE'}).`);
      }
    }

    if (reasons.length === 0) {
      const stagingCheck = checksByName.get(stagingCheckName);
      if (stagingCheck) {
        if (stagingCheck.status !== 'COMPLETED') {
          return {
            shouldTest: false,
            action: 'skip',
            reasons: [`Check '${stagingCheckName}' is already in progress on HEAD (status=${stagingCheck.status}).`],
          };
        }
        if (stagingCheck.conclusion === 'SUCCESS') {
          return {
            shouldTest: false,
            action: 'skip',
            reasons: [`Check '${stagingCheckName}' already passed on HEAD.`],
          };
        }
        if (stagingCheck.conclusion !== 'SKIPPED' && stagingCheck.conclusion !== 'NEUTRAL' && !forceRetest) {
          return {
            shouldTest: false,
            action: 'block',
            reasons: [
              `Check '${stagingCheckName}' already failed on HEAD (conclusion=${stagingCheck.conclusion || 'NONE'}). Dispatch workflow manually with pr_number to re-run.`,
            ],
          };
        }
      }
    }
  }

  if (reasons.length > 0) {
    return { shouldTest: false, action: 'block', reasons };
  }

  return {
    shouldTest: true,
    action: 'test',
    headRefOid: pr.headRefOid,
    reasons: [],
  };
}

/**
 * Evaluates whether a bot PR satisfies all conditions to be auto-approved and queued
 * for GitHub auto-merge:
 *   1. Open, non-draft PR targeting `main`
 *   2. Authored by an authorized dependency bot (Renovate / Dependabot) from a trusted repo/fork
 *   3. No hold/do-not-merge labels
 *   4. Non-major update (unless `allowMajor` is set via workflow_dispatch)
 *   5. No unresolved review comment threads and no CHANGES_REQUESTED reviews
 *   6. All required checks (including GDC Staging CAS integration test) succeeded and zero failing/pending checks on HEAD
 */
export function evaluateBotPR(pr, options = {}) {
  const {
    requiredChecks = DEFAULT_REQUIRED_CHECKS,
    allowMajor = false,
    repoFullName = '',
  } = options;

  const failure = checkCommonBotPreconditions(pr, repoFullName);
  if (failure) {
    return { eligible: false, ...failure };
  }

  if (!allowMajor && isMajorDependencyUpdate(pr)) {
    return {
      eligible: false,
      action: 'skip',
      reasons: [`PR #${pr.number} contains a major version update; manual review is required.`],
    };
  }

  const reasons = [];

  // Enforce zero unresolved review threads ("no open comment").
  if (pr.reviewThreads?.pageInfo?.hasNextPage) {
    reasons.push('PR has more than 100 review threads; refusing to auto-approve without full inspection.');
  }
  const unresolvedThreads = (pr.reviewThreads?.nodes || []).filter((t) => !t.isResolved);
  if (unresolvedThreads.length > 0) {
    reasons.push(`PR has ${unresolvedThreads.length} unresolved review comment thread(s).`);
  }

  // Enforce no outstanding CHANGES_REQUESTED reviews.
  const changeRequests = (pr.latestReviews?.nodes || []).filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changeRequests.length > 0) {
    const reviewers = changeRequests.map((r) => r.author?.login || 'unknown').join(', ');
    reasons.push(`PR has CHANGES_REQUESTED review(s) from: ${reviewers}.`);
  }

  // Enforce all required checks passed and zero failing/pending checks on HEAD.
  const headCommit = pr.commits?.nodes?.[0]?.commit;
  const rollup = headCommit?.statusCheckRollup;
  if (!rollup || !rollup.contexts) {
    reasons.push('No status checks found on the latest commit.');
  } else {
    if (rollup.contexts.pageInfo?.hasNextPage) {
      reasons.push('More than 100 status checks on HEAD; refusing to auto-approve without full inspection.');
    }
    const checksByName = normalizeChecks(rollup.contexts.nodes || []);

    for (const reqName of requiredChecks) {
      const check = checksByName.get(reqName);
      if (!check) {
        reasons.push(`Required check '${reqName}' has not reported on HEAD.`);
      } else if (check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS') {
        reasons.push(`Required check '${reqName}' is not passing (status=${check.status}, conclusion=${check.conclusion || 'NONE'}).`);
      }
    }

    for (const check of checksByName.values()) {
      if (check.status !== 'COMPLETED') {
        reasons.push(`Check '${check.name}' is still incomplete (status=${check.status}).`);
      } else if (!PASSING_CONCLUSIONS.has(check.conclusion)) {
        reasons.push(`Check '${check.name}' did not pass (conclusion=${check.conclusion || 'NONE'}).`);
      }
    }
  }

  if (reasons.length > 0) {
    return { eligible: false, action: 'block', reasons };
  }

  const headOid = pr.headRefOid;
  const alreadyApprovedByActions = (pr.latestReviews?.nodes || []).some(
    (r) =>
      r.state === 'APPROVED' &&
      r.commit?.oid === headOid &&
      (r.author?.login === 'github-actions' || r.author?.login === 'github-actions[bot]')
  );

  return {
    eligible: true,
    action: 'approve',
    alreadyApprovedByActions,
    reasons: [],
  };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node evaluate-bot-pr.mjs <pr-graphql-json-file>');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const pr = raw?.data?.repository?.pullRequest || raw;
  const mode = process.env.EVAL_MODE || 'approve';
  const repoFullName = process.env.REPO_FULL_NAME || '';

  const result = mode === 'staging'
    ? evaluateBotPRForStaging(pr, {
        forceRetest: process.env.FORCE_RETEST === 'true',
        repoFullName,
      })
    : evaluateBotPR(pr, {
        allowMajor: process.env.ALLOW_MAJOR === 'true',
        repoFullName,
      });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
