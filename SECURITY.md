# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**. Use this repository's GitHub **Security** tab and choose **Report a vulnerability**; only the maintainers can see the report. Don't open a public issue or pull request for a security problem.

Please include:

- what an attacker can do, and what they need first (an account, a role, a client membership);
- steps to reproduce, ideally against a local `npm run dev` instance;
- the commit or release you tested.

We aim to acknowledge reports within 3 working days and to agree a disclosure date with you. Fixes ship as a release that deployments pick up by syncing their fork. Credit is given in the release notes unless you'd rather not be named.

## Scope

In scope: this repository's code, including the Worker, the web app, email templates, and the deploy configuration.

Out of scope:
- a consultancy's own Cloudflare, Resend, or GitHub account settings;
- denial of service through volume;
- findings that need a compromised Owner account or a compromised fork.

`docs/security.md` describes the security model and its known limitations.

## Supported versions

Only the latest release is supported. Deployments update by syncing their fork: the included `sync-upstream` workflow can do it, or GitHub's "Sync fork" button.
