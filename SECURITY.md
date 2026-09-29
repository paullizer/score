# Security policy

## Supported versions

Score is deployed from the `main` branch. Security fixes land on `main`; there are no maintained release branches.

## Reporting a vulnerability

Please don't report security problems in public issues, discussions or pull requests.

Report them privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/paullizer/score/security/advisories/new>. Only the maintainers can see the report.

Please include:

- what an attacker could do, and what access they need first (for example, a signed-in Reader in a different workspace);
- the affected route, page, worker, template or file, and the commit you tested;
- steps or a proof of concept that reproduces the problem;
- whether any real data or live deployment was involved.

The maintainers will acknowledge the report, discuss the fix with you in the private advisory, and credit you when the advisory is published unless you'd rather stay anonymous.

## Scope

In scope: the code and configuration in this repository. That covers the API (`server/`), the browser app (`src/`), the workers (`worker/`), the renderer (`renderer/`), the Azure templates (`infra/`), the deployment scripts (`scripts/`) and the GitHub workflows (`.github/`).

Out of scope:

- vulnerabilities in Azure services or third-party packages themselves (report those to the vendor, and tell us if Score is affected);
- findings that need an already compromised Azure subscription, Entra tenant or administrator account;
- denial of service through traffic volume;
- social engineering.

Test only against a deployment you own. Don't access, change or keep data that isn't yours.

## How the repository is checked

Pull requests run CodeQL, GitHub dependency review, a supply-chain and malicious-change review, and XSS, access-control and outbound-request guardrails. See [Security scanning](docs/security-scanning.md).
