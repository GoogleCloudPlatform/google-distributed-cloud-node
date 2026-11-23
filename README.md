# Google Distributed Cloud Air-gapped Node.js Client SDK (`google-distributed-cloud-node`)

`google-distributed-cloud-node` is the official Node.js client SDK for Google Distributed Cloud air-gapped (GDCag) services.

## Supported Services

Currently, this repository supports **Certificate Authority Service (CAS)** via the [`gdc-cas`](./cas/gdc-cas) package. Contributions adding Node.js client libraries for additional GDC air-gapped services are very welcome — see [Contributing](#contributing) below.

## Overview

This repository contains the client library modules and developer utilities designed for enterprise workloads integrating with GDC air-gapped services:

* **[`gdc-cas`](./cas/gdc-cas)**: Node.js client library for the Google Distributed Cloud air-gapped Certificate Authority Service (CAS). Supports RFC 8693 Security Token Service (STS) authentication, Kubernetes Resource Model (KRM) custom resources (`CertificateRequest`, `CertificateAuthority`, `RevokeCertificateRequest`), and direct gRPC dataplane communication.
* **[CAS Load Test & Examples](./cas)**: Sample scripts and high-performance load testing utilities for validating Certificate Authority Service issuing and revocation throughput.

## Repository Structure

```
google-distributed-cloud-node/
├── .github/
│   └── CODEOWNERS            # Repository code owners
├── cas/
│   ├── gdc-cas/              # The 'gdc-cas' npm package source
│   │   ├── cas-client.js     # CAS client implementation (KRM & gRPC)
│   │   ├── cas-client.d.ts   # TypeScript definitions
│   │   ├── sts-auth.js       # STS token acquisition & JWT exchange
│   │   └── proto/            # Protocol buffer definitions & compiled descriptors
│   ├── run-example.js        # CAS client example and QPS benchmark runner
│   └── README.md             # Load testing guide and execution modes
├── CONTRIBUTING.md           # Guidelines for contributing to this project
├── LICENSE                   # Apache 2.0 license
├── NOTICE                    # Copyright and third-party attribution notices
└── README.md                 # Root documentation
```

## Quick Start (`gdc-cas`)

### Installation

Install the `gdc-cas` package in your Node.js application:

```bash
npm install gdc-cas
```

### Basic Usage

```javascript
import { CASClient } from 'gdc-cas';

const client = new CASClient({
  saFilePath: '/path/to/service-account.json',
  caFilePath: '/path/to/trust-bundle.crt',
  zone: 'us-west6-a',
});

// Initialize authentication and API clients
await client.init();

// Request a new TLS certificate
const certResult = await client.createCertificateRequest('my-project', {
  certificateAuthorityRef: 'my-ca',
  csr: base64EncodedCsrString,
});

console.log('Issued Certificate:', certResult.tlsCrt);
```

For full documentation, advanced options (connection pooling, custom HTTP middleware, direct gRPC mode, built-in retries, keepalive), and certificate revocation, see the [gdc-cas package README](./cas/gdc-cas/README.md).

## Prerequisites

To interact with GDC air-gapped services using this SDK (currently CAS), you will need:

1. A project created in your GDC organization.
2. A service account key JSON file with appropriate permissions (e.g. `certificate-authority-service-admin` for CAS).
3. The GDC trust store root certificate (`ca.crt`).
4. An active Certificate Authority configured in your GDC namespace (for CAS usage).

## Contributing

Contributions are welcome — both improvements to existing packages (`cas/gdc-cas`) and new Node.js client libraries for additional Google Distributed Cloud air-gapped services!

Please place new service clients in their own top-level directory alongside `cas/` (with a self-contained `package.json`, documentation, and tests), and read [CONTRIBUTING.md](./CONTRIBUTING.md) for details on submitting pull requests and signing the Google Contributor License Agreement (CLA).

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for full details.
