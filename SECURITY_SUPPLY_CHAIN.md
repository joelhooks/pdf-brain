# Supply-chain hardening policy

This repo treats dependency, workflow, source, script, and release changes as security-sensitive.

## Required defaults

- Use the committed lockfile with `pnpm install --frozen-lockfile` in CI.
- For first inspection of unfamiliar dependencies, install with `--ignore-scripts`.
- Keep lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare`, `prepublishOnly`) rare and explicit.
- GitHub Actions permissions default to read-only; grant write permissions only per job.
- Release/deploy jobs must not run on `pull_request`, `pull_request_target`, `discussion`, or other user-content events.
- Require review for `.github/workflows/`, `.github/actions/`, package manifests, lockfiles, `.npmrc`, source files, scripts, and release config.

## Shai-Hulud-style IOC checks

Block and investigate these immediately:

- `setup_bun.js` or `bun_environment.js` appearing unexpectedly in dependencies or project root.
- New workflow files such as `.github/workflows/discussion.yaml` or `shai-hulud-workflow.yml`.
- Self-hosted runners named `SHA1HULUD` or unexpected runner registration files under `$HOME/.dev-env/`.
- Unexpected public repos/descriptions referencing `Sha1-Hulud`, `Shai-hulud Migration`, or `-migration`.

If a compromised package install ran: assume local/user secrets are burned, revoke npm/GitHub/cloud tokens, rotate deploy secrets, compare artifacts against source, and rebuild the machine instead of surgical cleanup theater.
