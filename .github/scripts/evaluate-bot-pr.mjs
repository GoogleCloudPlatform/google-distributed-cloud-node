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

export const DEFAULT_REQUIRED_CHECKS = [
  'Unit Tests',
  'Check (Syntax & Build)',
  'cla/google',
];

const SELF_CHECK_NAMES = new Set([
  'Approve & Enable Auto-Merge',
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

/**
 * Evaluates whether a bot PR satisfies all conditions to be auto-approved and queued
 * for GitHub auto-merge:
 *   1. Open, non-draft PR targeting `main`
 *   2. Authored by an authorized dependency bot (Renovate / Dependabot)
 *   3. No hold/do-not-merge labels
 *   4. Non-major update (unless `allowMajor` is set via workflow_dispatch)
 *   5. No unresolved review comment threads and no CHANGES_REQUESTED reviews
 *   6. All required checks succeeded and zero failing/pending checks on the head commit
 */
export function evaluateBotPR(pr, options = {}) {
  const {
    requiredChecks = DEFAULT_REQUIRED_CHECKS,
    allowMajor = false,
  } = options;

  if (!pr) {
    return { eligible: false, action: 'skip', reasons: ['Pull request data not found.'] };
  }
  if (pr.state !== 'OPEN') {
    return { eligible: false, action: 'skip', reasons: [`PR #${pr.number} is not open (state=${pr.state}).`] };
  }
  if (pr.isDraft) {
    return { eligible: false, action: 'skip', reasons: [`PR #${pr.number} is a draft.`] };
  }
  if (pr.baseRefName !== 'main') {
    return { eligible: false, action: 'skip', reasons: [`PR #${pr.number} targets '${pr.baseRefName}', not 'main'.`] };
  }
  if (!isAuthorizedBotAuthor(pr.author)) {
    return {
      eligible: false,
      action: 'skip',
      reasons: [`PR #${pr.number} author '${pr.author?.login || 'unknown'}' is not an authorized dependency bot.`],
    };
  }

  const labels = (pr.labels?.nodes || []).map((l) => String(l.name || '').toLowerCase());
  const foundBlockingLabels = labels.filter((l) => BLOCKING_LABELS.has(l));
  if (foundBlockingLabels.length > 0) {
    return {
      eligible: false,
      action: 'block',
      reasons: [`PR #${pr.number} has blocking label(s): ${foundBlockingLabels.join(', ')}.`],
    };
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
  const allowMajor = process.env.ALLOW_MAJOR === 'true';
  const result = evaluateBotPR(pr, { allowMajor });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
