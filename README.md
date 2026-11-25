# Google Distributed Cloud Air-gapped Node.js Client SDK (`google-distributed-cloud-node`)

[![gdc-node Release & Qualification Pipeline](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/release-pipeline.yaml/badge.svg)](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/release-pipeline.yaml)
[![CI](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/ci.yml/badge.svg)](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/ci.yml)
[![Release Pipeline Dashboard](https://img.shields.io/badge/dashboard-GitHub%20Pages-0ea5e9)](https://googlecloudplatform.github.io/google-distributed-cloud-node/)

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
│   ├── ISSUE_TEMPLATE/       # Bug report and feature request templates
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/            # CI, GDC Staging qualification & OSS Exit Gate release workflows
├── cas/
│   ├── gdc-cas/              # The 'gdc-cas' npm package source
│   │   ├── cas-client.js     # CAS client implementation (KRM & gRPC)
│   │   ├── cas-client.d.ts   # TypeScript definitions
│   │   ├── sts-auth.js       # STS token acquisition & JWT exchange
│   │   └── proto/            # Protocol buffer definitions & compiled descriptors
│   ├── run-example.js        # CAS client example and QPS benchmark runner
│   └── README.md             # Load testing guide and execution modes
├── dashboard/                # Static GitHub Pages CI/CD & Release Pipeline Dashboard
│   ├── index.html            # Live pipeline monitor UI & execution history viewer
│   └── data/runs.json        # Recorded snapshot & official release run ledger
├── scripts/
│   └── release/              # SemVer resolution, GitHub API release notes & retry helpers
├── CODEOWNERS                # Repository code owners
├── CODE_OF_CONDUCT.md        # Contributor Code of Conduct
├── CONTRIBUTING.md           # Guidelines for contributing to this project
├── LICENSE                   # Apache 2.0 license
├── NOTICE                    # Copyright and third-party attribution notices
├── README.md                 # Root documentation
├── SECURITY.md               # Security vulnerability reporting policy
└── renovate.json             # Automated dependency update configuration
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

---

## Monitoring & Release Pipeline Dashboard

Continuous qualification and official SemVer npm releases are tracked through the GitHub Pages pipeline monitor and GitHub Actions summaries:

* **Release Pipeline Dashboard ([`https://googlecloudplatform.github.io/google-distributed-cloud-node/`](https://googlecloudplatform.github.io/google-distributed-cloud-node/))**:
  * **Live Active Run Polling**: Automatically polls in-progress, queued, and waiting GitHub Actions runs to display real-time stage-by-stage progress (`Authorize & SemVer` → `Release Notes` → `GDC Staging (KRM + gRPC)` → `Publish via OSS Exit Gate` → `Verify Published npm Package`) with a live elapsed timer.
  * **KPI Overview & Registry Telemetry**: Displays total recorded runs, overall pass rate, latest certified `release` and `snapshot` versions, live `npmjs.org` published version, and 30-day npm download counts.
  * **Filterable Execution History**: Tracks historical `snapshot` and `release` runs with package/mode/status filters, tested commit SHAs, trigger actors, stage badges, and expandable GitHub API release notes.
* **GitHub Actions Job Summary**: Every pipeline execution publishes a structured summary table (and prepared release notes in `release` mode) under the workflow run's **Summary** tab.

### Execution Modes (`snapshot` vs. `release`)

The **[gdc-node Release & Qualification Pipeline](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/release-pipeline.yaml)** uses the standard npm **pre-release version bump model**: `cas/gdc-cas/package.json` on `main` always reflects the **currently published version** on `npmjs.com` until a maintainer bumps it in a PR right before cutting the next release.

* **`snapshot` Mode (Weeknight Qualification / Pre-Release)**:
  * Runs automatically every weeknight (**Monday–Friday at `02:00 PST` / `10:00 UTC`**) and on manual `snapshot` dispatches.
  * Resolves `<next-version>-snapshot.<short_sha>` (auto-incrementing the patch component when the `package.json` version is already tagged), packs the candidate npm tarball, runs all unit, type, consumer smoke, and live GDC Air-gapped Staging integration tests (both KRM and direct gRPC), records telemetry on the dashboard, and **skips `npmjs.com` registry publication**.
* **`release` Mode (Official SemVer Release)**:
  * **Step 1 (Pre-release version bump PR):** Open and merge a PR bumping `cas/gdc-cas/package.json` (and `package-lock.json`, plus `CHANGELOG.md` if applicable) to the target SemVer version (`patch`, `minor`, or `major`).
  * **Step 2 (Dispatch release):** Triggered by repository maintainers listed in [`CODEOWNERS`](./CODEOWNERS) from `main`. Verifies the `package.json` version is not already tagged in Git and is **strictly higher (SemVer 2.0)** than what is currently published on `npmjs.com`, executes full GDC Air-gapped Staging qualification, prepares structured release notes via the GitHub REST API, publishes the certified tarball to `npmjs.com` via Google OSS Exit Gate (Workload Identity Federation), creates the `gdc-cas-v<version>` GitHub Release with SHA-512 integrity digest, and then **installs the newly published package directly from `registry.npmjs.org` to run a post-publish end-to-end verification (UC1–UC6) against GDC Air-gapped Staging**.

### Triggering the Pipeline

Maintainers can dispatch the workflow from **[Actions → gdc-node Release & Qualification Pipeline](https://github.com/GoogleCloudPlatform/google-distributed-cloud-node/actions/workflows/release-pipeline.yaml)** on `main` or via the GitHub CLI (`gh`):

| Input | Default | Description |
| :--- | :--- | :--- |
| `package` | `gdc-cas` | Target SDK package to qualify or release. |
| `release_mode` | `snapshot` | Execution mode: `snapshot` (Staging qualification only, no npm publish) or `release` (official SemVer release + npm publish + post-publish live npm verification). |
| `oss_exit_gate_project` | `gdc-node` | Google OSS Exit Gate project slug used during `release` publication. |

```bash
# Trigger a snapshot qualification run (runs all tests on GDC Staging without npm publish)
gh workflow run release-pipeline.yaml \
  --repo GoogleCloudPlatform/google-distributed-cloud-node \
  --ref main \
  -f package=gdc-cas \
  -f release_mode=snapshot

# Trigger an official SemVer release (after merging a pre-release version bump PR on main)
gh workflow run release-pipeline.yaml \
  --repo GoogleCloudPlatform/google-distributed-cloud-node \
  --ref main \
  -f package=gdc-cas \
  -f release_mode=release
```

---

## Contributing

Contributions are welcome — both improvements to existing packages (`cas/gdc-cas`) and new Node.js client libraries for additional Google Distributed Cloud air-gapped services!

Please place new service clients in their own top-level directory alongside `cas/` (with a self-contained `package.json`, documentation, and tests), and read [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md) before submitting a pull request.

## Security

To report a security vulnerability, please follow the instructions in [SECURITY.md](./SECURITY.md) rather than opening a public GitHub issue.

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for full details.
