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
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const VERIFY_SCRIPT = path.join(SCRIPT_DIR, 'verify-npm-release.sh');

function startMockRegistryServer({ tarballBytes, integrity, stagingPolls = 1, pkgName = 'gdc-cas', version = '0.1.0' }) {
  let metaHits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === `/${pkgName}`) {
      metaHits += 1;
      if (metaHits <= stagingPolls) {
        // Simulate npm first-publish staged placeholder before target version is promoted.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            name: pkgName,
            'dist-tags': { latest: '0.0.0-stage' },
            versions: { '0.0.0-stage': { name: pkgName, version: '0.0.0-stage' } },
          })
        );
        return;
      }
      const addr = server.address();
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          name: pkgName,
          'dist-tags': { latest: version },
          versions: {
            [version]: {
              name: pkgName,
              version,
              main: 'index.js',
              type: 'module',
              dist: {
                tarball: `${baseUrl}/${pkgName}/-/${pkgName}-${version}.tgz`,
                integrity,
              },
            },
          },
        })
      );
      return;
    }

    if (req.url === `/${pkgName}/-/${pkgName}-${version}.tgz`) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(tarballBytes);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        getMetaHits: () => metaHits,
      });
    });
  });
}

describe('scripts/release/verify-npm-release.sh', () => {
  it('waits for dist-tag promotion, verifies SRI, installs from registry, and runs offline self-test', async () => {
    const tmpPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-npm-pack-'));
    let mock = null;
    try {
      // Build a minimal self-contained tarball (zero external deps) that exports CASClient & RevocationReason.
      const pkgDir = path.join(tmpPackDir, 'pkg');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'gdc-cas',
          version: '0.1.0',
          type: 'module',
          main: 'index.js',
        })
      );
      fs.writeFileSync(
        path.join(pkgDir, 'index.js'),
        [
          'export const RevocationReason = { SUPERSEDED: 4 };',
          'export class CASClient {',
          '  constructor(opts = {}) {',
          '    if (!opts.saFilePath && !opts.serviceAccount) {',
          '      throw new Error("Either saFilePath or serviceAccount is required");',
          '    }',
          '  }',
          '}',
        ].join('\n') + '\n'
      );

      const { stdout: packOut } = await execFileAsync('npm', ['pack', '--pack-destination', tmpPackDir], {
        cwd: pkgDir,
      });
      const tgzName = packOut.trim().split('\n').pop().trim();
      const tarballBytes = fs.readFileSync(path.join(tmpPackDir, tgzName));
      const integrity = `sha512-${crypto.createHash('sha512').update(tarballBytes).digest('base64')}`;

      mock = await startMockRegistryServer({ tarballBytes, integrity, stagingPolls: 1 });

      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;

      const { stdout, stderr } = await execFileAsync('bash', [VERIFY_SCRIPT], {
        cwd: REPO_ROOT,
        env: {
          ...childEnv,
          PKG_NAME: 'gdc-cas',
          PKG_VERSION: '0.1.0',
          NPM_DIST_TAG: 'latest',
          NPM_REGISTRY_URL: mock.baseUrl,
          EXPECTED_TARBALL_SRI: integrity,
          POLL_INTERVAL_SECS: '0',
          MAX_WAIT_SECS: '15',
          VERIFY_NPM_OFFLINE_SELFTEST: 'true',
        },
      });

      const combined = `${stdout}\n${stderr}`;
      assert.ok(mock.getMetaHits() >= 2, 'Expected script to poll past 0.0.0-stage placeholder');
      assert.match(combined, /Published version gdc-cas@0\.1\.0 is live on dist-tag 'latest'/);
      assert.match(combined, /Verified published tarball SHA-512 integrity matches certified release artifact/);
      assert.match(combined, /Verified installed package: gdc-cas@0\.1\.0/);
      assert.match(combined, /Offline CSR & Fast-Fail Self-Tests/);

      // Integrity mismatch must fail fast before installing.
      await assert.rejects(
        () =>
          execFileAsync('bash', [VERIFY_SCRIPT], {
            cwd: REPO_ROOT,
            env: {
              ...childEnv,
              PKG_NAME: 'gdc-cas',
              PKG_VERSION: '0.1.0',
              NPM_DIST_TAG: 'latest',
              NPM_REGISTRY_URL: mock.baseUrl,
              EXPECTED_TARBALL_SRI: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
              POLL_INTERVAL_SECS: '0',
              MAX_WAIT_SECS: '15',
              VERIFY_NPM_OFFLINE_SELFTEST: 'true',
            },
          }),
        (err) => /integrity mismatch/i.test(`${err.stdout || ''}\n${err.stderr || ''}`)
      );
    } finally {
      if (mock) {
        await new Promise((resolve) => mock.server.close(resolve));
      }
      fs.rmSync(tmpPackDir, { recursive: true, force: true });
    }
  });
});
