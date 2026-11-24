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

import {
  STAGING_INTEGRATION_CHECK_NAME,
  evaluateBotPR,
  evaluateBotPRForStaging,
  isAuthorizedBotAuthor,
  isAuthorizedBotHeadRepository,
  isMajorDependencyUpdate,
} from './evaluate-bot-pr.mjs';

const REPO = 'GoogleCloudPlatform/google-distributed-cloud-node';

function makePassingPR(overrides = {}) {
  return {
    number: 12,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefOid: 'abc123',
    title: 'chore(deps): update dependency axios to v1.21.1',
    body: '| [axios](https://axios-http.com) | `1.20.0` → `1.21.1` |',
    author: { __typename: 'User', login: 'renovate-bot' },
    headRepository: { nameWithOwner: 'renovate-bot/GoogleCloudPlatform-_-google-distributed-cloud-node' },
    headRepositoryOwner: { login: 'renovate-bot' },
    labels: { nodes: [{ name: 'automerge' }] },
    reviewThreads: {
      pageInfo: { hasNextPage: false },
      nodes: [{ isResolved: true }],
    },
    latestReviews: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { __typename: 'CheckRun', name: 'Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-23T20:00:00Z' },
                  { __typename: 'CheckRun', name: 'Check (Syntax & Build)', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-23T20:00:00Z' },
                  { __typename: 'StatusContext', context: 'cla/google', state: 'SUCCESS', createdAt: '2026-11-23T20:00:00Z' },
                  { __typename: 'CheckRun', name: 'Authorize & Queue GDC Staging Test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-23T20:00:01Z' },
                  { __typename: 'CheckRun', name: STAGING_INTEGRATION_CHECK_NAME, status: 'COMPLETED', conclusion: 'SKIPPED', completedAt: '2026-11-23T20:00:02Z' },
                  { __typename: 'CheckRun', name: STAGING_INTEGRATION_CHECK_NAME, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-23T20:01:00Z' },
                  { __typename: 'CheckRun', name: 'zizmor-scan', status: 'COMPLETED', conclusion: 'SKIPPED', completedAt: '2026-11-23T20:00:00Z' },
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function makeUnverifiedStagingPR(overrides = {}) {
  const pr = makePassingPR(overrides);
  pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes =
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.filter(
      (n) => !(n.name === STAGING_INTEGRATION_CHECK_NAME && n.conclusion === 'SUCCESS')
    );
  return pr;
}

describe('isAuthorizedBotAuthor', () => {
  it('accepts renovate-bot, renovate[bot], and dependabot[bot]', () => {
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'renovate-bot' }), true);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'Bot', login: 'renovate' }), true);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'Bot', login: 'dependabot' }), true);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'renovate[bot]' }), true);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'dependabot[bot]' }), true);
  });

  it('rejects human users including lookalike logins', () => {
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'dilipkumar2k6' }), false);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'renovate' }), false);
    assert.equal(isAuthorizedBotAuthor({ __typename: 'User', login: 'dependabot' }), false);
    assert.equal(isAuthorizedBotAuthor(null), false);
  });
});

describe('isAuthorizedBotHeadRepository', () => {
  it('accepts same-repo branches and trusted bot forks, rejecting untrusted forks', () => {
    assert.equal(
      isAuthorizedBotHeadRepository({
        headRepository: { nameWithOwner: REPO },
        headRepositoryOwner: { login: 'GoogleCloudPlatform' },
      }, REPO),
      true
    );
    assert.equal(
      isAuthorizedBotHeadRepository({
        headRepository: { nameWithOwner: 'renovate-bot/GoogleCloudPlatform-_-google-distributed-cloud-node' },
        headRepositoryOwner: { login: 'renovate-bot' },
      }, REPO),
      true
    );
    assert.equal(
      isAuthorizedBotHeadRepository({
        headRepository: { nameWithOwner: 'attacker/google-distributed-cloud-node' },
        headRepositoryOwner: { login: 'attacker' },
      }, REPO),
      false
    );
  });
});

describe('isMajorDependencyUpdate', () => {
  it('detects major updates from Renovate body, title, or Dependabot title', () => {
    assert.equal(
      isMajorDependencyUpdate({
        title: 'fix(deps): update dependency @kubernetes/client-node to v2',
        body: '| `@kubernetes/client-node` | `^1.2.0` → `^2.0.0` |',
      }),
      true
    );
    assert.equal(
      isMajorDependencyUpdate({
        title: 'chore(deps): Bump foo from 1.9.0 to 2.0.0',
        body: '',
      }),
      true
    );
  });

  it('allows minor, patch, and 0.x minor updates', () => {
    assert.equal(
      isMajorDependencyUpdate({
        title: 'chore(deps): update dependency axios to v1.21.1',
        body: '| `axios` | `1.20.0` → `1.21.1` |',
      }),
      false
    );
    assert.equal(
      isMajorDependencyUpdate({
        title: 'fix(deps): update dependency @grpc/proto-loader to ^0.8.0',
        body: '| `@grpc/proto-loader` | `^0.7.10` → `^0.8.0` |',
      }),
      false
    );
  });
});

describe('evaluateBotPRForStaging', () => {
  it('schedules GDC Staging test when fast checks pass and staging check was SKIPPED on fork PR', () => {
    const pr = makeUnverifiedStagingPR();
    const res = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(res.shouldTest, true);
    assert.equal(res.action, 'test');
    assert.equal(res.headRefOid, 'abc123');
  });

  it('also schedules GDC Staging test for major Renovate updates once fast checks pass', () => {
    const pr = makeUnverifiedStagingPR({
      number: 29,
      title: 'chore(deps): update actions/configure-pages action to v6',
      body: '| `actions/configure-pages` | `v5` → `v6` |',
    });
    const res = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(res.shouldTest, true);
    assert.equal(res.action, 'test');
  });

  it('skips staging test when CAS Integration Test (GDC Staging) already passed on HEAD', () => {
    const pr = makePassingPR();
    const res = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(res.shouldTest, false);
    assert.equal(res.action, 'skip');
  });

  it('does not re-run a failed staging check automatically unless forceRetest is enabled', () => {
    const pr = makeUnverifiedStagingPR();
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push({
      __typename: 'CheckRun',
      name: STAGING_INTEGRATION_CHECK_NAME,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-11-23T20:05:00Z',
    });
    const autoRes = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(autoRes.shouldTest, false);
    assert.equal(autoRes.action, 'block');

    const manualRes = evaluateBotPRForStaging(pr, { repoFullName: REPO, forceRetest: true });
    assert.equal(manualRes.shouldTest, true);
    assert.equal(manualRes.action, 'test');
  });

  it('blocks staging test when Unit Tests, security scan, or Authorize precheck failed', () => {
    const pr = makeUnverifiedStagingPR();
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push({
      __typename: 'CheckRun',
      name: 'scan-pr',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-11-23T20:01:00Z',
    });
    const res = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(res.shouldTest, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes('scan-pr')));
  });

  it('skips untrusted fork repositories even if author field looks like a bot', () => {
    const pr = makeUnverifiedStagingPR({
      headRepository: { nameWithOwner: 'attacker/google-distributed-cloud-node' },
      headRepositoryOwner: { login: 'attacker' },
    });
    const res = evaluateBotPRForStaging(pr, { repoFullName: REPO });
    assert.equal(res.shouldTest, false);
    assert.equal(res.action, 'skip');
  });
});

describe('evaluateBotPR', () => {
  it('approves eligible Renovate PR when all checks including GDC Staging pass and no open comments exist', () => {
    const res = evaluateBotPR(makePassingPR(), { repoFullName: REPO });
    assert.equal(res.eligible, true);
    assert.equal(res.action, 'approve');
    assert.equal(res.alreadyApprovedByActions, false);
  });

  it('blocks auto-approval when CAS Integration Test (GDC Staging) was only SKIPPED', () => {
    const res = evaluateBotPR(makeUnverifiedStagingPR(), { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes(STAGING_INTEGRATION_CHECK_NAME)));
  });

  it('skips major updates during automatic evaluation but allows when allowMajor is true', () => {
    const majorPr = makePassingPR({
      number: 14,
      title: 'fix(deps): update dependency @kubernetes/client-node to v2',
      body: '| `@kubernetes/client-node` | `^1.2.0` → `^2.0.0` |',
    });
    const autoRes = evaluateBotPR(majorPr, { repoFullName: REPO });
    assert.equal(autoRes.eligible, false);
    assert.equal(autoRes.action, 'skip');

    const manualRes = evaluateBotPR(majorPr, { allowMajor: true, repoFullName: REPO });
    assert.equal(manualRes.eligible, true);
    assert.equal(manualRes.action, 'approve');
  });

  it('blocks when any review comment thread is unresolved', () => {
    const pr = makePassingPR({
      reviewThreads: {
        pageInfo: { hasNextPage: false },
        nodes: [{ isResolved: true }, { isResolved: false }],
      },
    });
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes('1 unresolved review comment thread')));
  });

  it('blocks when a reviewer requested changes', () => {
    const pr = makePassingPR({
      latestReviews: {
        nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'dilipkumar2k6' } }],
      },
    });
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes('CHANGES_REQUESTED')));
  });

  it('blocks when Unit Tests or any other check failed', () => {
    const pr = makePassingPR();
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes[0].conclusion = 'FAILURE';
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes('Unit Tests')));
  });

  it('blocks when an extra non-required check failed', () => {
    const pr = makePassingPR();
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push({
      __typename: 'CheckRun',
      name: 'scan-pr',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-11-23T20:01:00Z',
    });
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'block');
    assert.ok(res.reasons.some((r) => r.includes('scan-pr')));
  });

  it('uses latest re-run result when a previously failed check is re-run and succeeds', () => {
    const pr = makePassingPR();
    pr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.unshift({
      __typename: 'CheckRun',
      name: 'Unit Tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-11-23T19:00:00Z',
    });
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, true);
    assert.equal(res.action, 'approve');
  });

  it('skips human PRs even when all checks pass', () => {
    const pr = makePassingPR({ author: { __typename: 'User', login: 'dilipkumar2k6' } });
    const res = evaluateBotPR(pr, { repoFullName: REPO });
    assert.equal(res.eligible, false);
    assert.equal(res.action, 'skip');
  });
});
