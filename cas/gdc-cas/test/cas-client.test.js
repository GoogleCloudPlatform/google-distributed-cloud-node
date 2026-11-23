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

import { CASClient, RevocationReason } from '../index.js';

function createEphemeralPrivateKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return privateKey;
}

function startMockStsServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'mock-sts-token',
        token_type: 'Bearer',
        expires_in: 3600,
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/authenticate` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('RevocationReason', () => {
  it('loads enum values from compiled proto descriptor', () => {
    assert.equal(RevocationReason.UNSPECIFIED, 0);
    assert.equal(RevocationReason.KEY_COMPROMISE, 1);
    assert.equal(RevocationReason.CA_COMPROMISE, 2);
    assert.equal(RevocationReason.AFFILIATION_CHANGED, 3);
    assert.equal(RevocationReason.SUPERSEDED, 4);
    assert.equal(RevocationReason.CESSATION_OF_OPERATION, 5);
    assert.equal(RevocationReason.CERTIFICATE_HOLD, 6);
    assert.equal(RevocationReason.PRIVILEGE_WITHDRAWN, 7);
    assert.equal(RevocationReason.AA_COMPROMISE, 8);
  });
});

describe('CASClient constructor and URL derivation', () => {
  it('validates required constructor configuration', () => {
    assert.throws(() => new CASClient({}), /zone is required/);
    assert.throws(
      () => new CASClient({ zone: 'us-west6-a' }),
      /Either saFilePath or serviceAccount must be provided/
    );
  });

  it('derives management API and CAS proxy URLs accurately', () => {
    const client = new CASClient({
      zone: 'us-west6-a',
      serviceAccount: { name: 'sa' },
    });

    assert.equal(
      client._getManagementApiUrl('https://service-accounts.gdc1.example.gdc.domain.com/authenticate', 'us-west6-a'),
      'https://management-kube.apiserver.gdc1.us-west6-a.example.gdc.domain.com'
    );
    assert.equal(
      client._getManagementApiUrl('https://service-accounts.gdc1.us-west6-a.example.gdc.domain.com/authenticate', 'us-west6-a'),
      'https://management-kube.apiserver.gdc1.us-west6-a.example.gdc.domain.com'
    );
    assert.equal(
      client._getCasProxyUrl('https://service-accounts.gdc1.example.gdc.domain.com/authenticate', 'us-west6-a'),
      'https://cas.gdc1.us-west6-a.example.gdc.domain.com'
    );
    assert.equal(
      client._getCasProxyUrl('https://service-accounts.gdc1.us-west6-a.example.gdc.domain.com/authenticate', 'us-west6-a'),
      'https://cas.gdc1.us-west6-a.example.gdc.domain.com'
    );

    assert.throws(() => client._parseTokenUri('not-a-url'), /Invalid tokenUri format/);
    assert.throws(() => client._parseTokenUri('https://other.example.com/auth'), /Cannot derive API URL/);
  });
});

describe('CASClient KRM and gRPC operations', () => {
  it('initializes KRM clients with @kubernetes/client-node and issues/revokes certs', async () => {
    const { server, url } = await startMockStsServer();
    try {
      const client = new CASClient({
        zone: 'us-west6-a',
        serviceAccount: {
          name: 'test-sa',
          project: 'test-proj',
          private_key_id: 'key-1',
          private_key: createEphemeralPrivateKey(),
          token_uri: url,
        },
      });
      client._getManagementApiUrl = () => 'https://management-kube.apiserver.gdc1.us-west6-a.example.com';

      await client.init();
      assert.ok(client.customObjectsApi);
      assert.ok(client.coreV1Api);
      assert.equal(client.stsTokenCache.accessToken, 'mock-sts-token');

      await assert.rejects(
        () => client.createCertificateRequest('ns', { certificateAuthorityRef: 'ca', csr: 'Y3Ny', notAfter: 'not-a-date' }),
        /Invalid date for 'notAfter'/
      );

      let createdBody = null;
      client.customObjectsApi = {
        async createNamespacedCustomObject({ body }) {
          createdBody = body;
          return body;
        },
        async getNamespacedCustomObject() {
          return {
            status: {
              conditions: [{ type: 'Ready', status: 'True', reason: 'Issued' }],
            },
          };
        },
      };
      client.coreV1Api = {
        async readNamespacedSecret() {
          return {
            data: {
              'tls.crt': Buffer.from('CERT-PEM').toString('base64'),
              'ca.crt': Buffer.from('CA-PEM').toString('base64'),
            },
          };
        },
      };

      const issued = await client.createCertificateRequest(
        'test-proj',
        {
          certReqName: 'req-1',
          certificateAuthorityRef: 'my-ca',
          csr: Buffer.from('CSR-PEM').toString('base64'),
          notBefore: '2026-01-01T00:00:00.500Z',
          notAfter: new Date('2026-02-01T00:00:00.999Z'),
        },
        { timeoutMs: 2000, pollingIntervalMs: 10 }
      );

      assert.equal(issued.certificateRequestName, 'req-1');
      assert.equal(issued.tlsCrt, 'CERT-PEM');
      assert.equal(issued.caCert, 'CA-PEM');
      assert.equal(createdBody.spec.notBefore, '2026-01-01T00:00:00Z');
      assert.equal(createdBody.spec.notAfter, '2026-02-01T00:00:00Z');

      const revoked = await client.createRevokeCertificateRequest(
        'test-proj',
        {
          revokeReqName: 'rev-1',
          certificateRequestRef: { name: 'req-1', namespace: 'test-proj' },
          reason: RevocationReason.KEY_COMPROMISE,
        },
        { timeoutMs: 2000, pollingIntervalMs: 10 }
      );
      assert.equal(revoked.revokeCertificateRequestName, 'rev-1');
      assert.equal(createdBody.spec.reason, 'keycompromise');

      if (client.keepAliveAgent) {
        client.keepAliveAgent.destroy();
      }
    } finally {
      await stopServer(server);
    }
  });

  it('initializes gRPC client and invokes gRPC certificate issuance and revocation', async () => {
    const { server, url } = await startMockStsServer();
    try {
      const client = new CASClient({
        zone: 'us-west6-a',
        useGrpc: true,
        casProxyUrl: 'https://cas.gdc1.us-west6-a.example.com',
        grpcRetryPolicy: { maxAttempts: 3 },
        serviceAccount: {
          name: 'test-sa',
          project: 'test-proj',
          private_key_id: 'key-1',
          private_key: createEphemeralPrivateKey(),
          token_uri: url,
        },
      });
      client._getManagementApiUrl = () => 'https://management-kube.apiserver.gdc1.us-west6-a.example.com';

      await client.init();
      assert.ok(client.grpcClient);
      assert.equal(client.stsAuthParams.targetAudience, 'https://cas.gdc1.us-west6-a.example.com');

      const originalGrpcClient = client.grpcClient;
      let capturedAuthHeader = null;
      client.grpcClient = {
        CreateCertificateRequest(_req, metadata, _opts, cb) {
          capturedAuthHeader = metadata.get('authorization')[0];
          cb(null, {
            certificate: Buffer.from('GRPC-CERT'),
            ca_certificate: Buffer.from('GRPC-CA'),
          });
        },
        CreateRevokeCertificateRequest(req, _metadata, _opts, cb) {
          cb(null, {
            certificate: req.revoke_certificate_request.certificate,
            reason: req.revoke_certificate_request.reason,
          });
        },
      };

      const res = await client.createCertificateRequest('test-proj', {
        certReqName: 'grpc-req-1',
        certificateAuthorityRef: 'my-ca',
        csr: Buffer.from('CSR').toString('base64'),
      });
      assert.equal(capturedAuthHeader, 'Bearer mock-sts-token');
      assert.equal(res.tlsCrt, 'GRPC-CERT');
      assert.equal(res.caCert, 'GRPC-CA');

      const rev = await client.createRevokeCertificateRequest('test-proj', {
        certificate: 'GRPC-CERT',
        reason: RevocationReason.SUPERSEDED,
      });
      assert.equal(rev.certificate, 'GRPC-CERT');
      assert.equal(rev.reason, RevocationReason.SUPERSEDED);

      originalGrpcClient.close();
      if (client.keepAliveAgent) {
        client.keepAliveAgent.destroy();
      }
    } finally {
      await stopServer(server);
    }
  });
});
