# Contributing to google-distributed-cloud-node

We welcome contributions to the Google Distributed Cloud (GDC) air-gapped Node.js Client SDK! Whether you are reporting a bug, improving an existing package (such as `cas/gdc-cas`), or contributing a new client library for another GDC air-gapped service, this guide will help you get started.

---

## Code of Conduct

This project adheres to the [Contributor Code of Conduct](./CODE_OF_CONDUCT.md) and [Google's Open Source Community Guidelines](https://opensource.google/conduct/). By participating, you are expected to uphold these standards to maintain a welcoming and inclusive environment.

---

## Contributor License Agreement

Before we can accept and merge your code or documentation contributions, you must sign a **Contributor License Agreement (CLA)**. You (or your employer) retain the copyright to your contribution; this simply gives us permission to use and redistribute your contributions as part of the project.

* **Individual CLA:** If you are contributing as an individual, sign the [Individual CLA](https://developers.google.com/open-source/cla/individual).
* **Corporate CLA:** If you are contributing on behalf of your company, your organization must sign the [Corporate CLA](https://developers.google.com/open-source/cla/corporate).

You generally only need to submit a CLA once, so if you have already signed one (even for a different Google project), you do not need to sign it again. Check your current agreements at <https://cla.developers.google.com/>.

**Note:** When you open a Pull Request, an automated `@googlebot` check will verify your CLA status and provide instructions if a signature is needed.

---

## Code Reviews

All submissions, including submissions by project members, require review via GitHub Pull Requests. Consult [GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-pull-requests) for more information on using pull requests.

When adding support for a new GDC air-gapped service:

* Place the new client in its own top-level directory alongside `cas/` with a self-contained `package.json`, `README.md`, TypeScript definitions (`.d.ts`), and tests.
* Ensure Apache 2.0 license headers are present on source files and any third-party attributions are noted in `NOTICE`.
* Do not commit real credentials, service account keys (`*sa.json`), or trust store certificates (`*ca.crt`).

---

## Local Development & Verification

Before opening a pull request, install dependencies and verify your changes locally. For example, for the `cas/gdc-cas` package:

```bash
cd cas/gdc-cas
npm install
# If you modified proto/cas.proto, regenerate proto/cas-json.js:
npm run build:proto
```

---

## Security Issues

Please do **not** report security vulnerabilities through public GitHub issues. Follow the instructions in [SECURITY.md](./SECURITY.md) to report security issues privately via [g.co/vulnz](https://g.co/vulnz).
