# About this fork

## Siteworthy Q4 ownership

The adopted October 22, 2026 roadmap puts the Siteworthy care product beside
stock upstream Dokploy. This maintained fork supports the existing internal
installation; it is not the customer beta distribution or the home of a new
fork-native product executor. Q4 fork work is limited to necessary security
maintenance and the existing Caddy contribution path. Older full-stack rollout
plans are historical and do not restart from their original dates.

[Siteworthy product roadmap](https://github.com/masonjames/siteworthy/blob/main/docs/roadmap.md) · [product tracker](https://github.com/masonjames/siteworthy/issues/1) · [platform coordination](https://github.com/masonjames/platform-infra/issues/795) · [Dockhand internal maintenance](https://github.com/masonjames/dockhand/issues/199).

Siteworthy is the product name; Figaro is its display persona; Dockhand remains
the internal runtime. Future fork retirement requires its own reviewed migration
and operational approval. This document changes no installed system or license.

This repository is a fork of [Dokploy](https://github.com/Dokploy/dokploy),
maintained by Mason James. The maintained branch is `mj/prod-caddy`.

It is **not affiliated with, endorsed by or supported by Dokploy**. "Dokploy"
is used here only to say what this is a fork of. Please don't take questions
about this fork to Dokploy's Discord or issue tracker; open an issue here.

## What the fork changes

The fork tracks upstream releases and merges them regularly. On top of
upstream it carries:

| Area | Change |
| --- | --- |
| Web server | Caddy as an optional web server, chosen per server, beside Traefik: Caddyfile rendering from the database, background sync, request logs with secrets redacted, and switching a server between the two. Offered upstream as [Dokploy#5567](https://github.com/Dokploy/dokploy/pull/5567) |
| Deployments | A lane for deploying an image pinned by digest, with a check that the running revision is the expected one |
| Teardown | Compose and stack teardown that verifies what it removed, including web server routes |
| Builds | An admission check for host build capacity before a build starts |
| Access | Administrator-only API keys and a built-in read-only role for release observation |
| Health | Recognizes health checks defined in the image, and reports when runtime health evidence is unavailable |
| Release tooling | A release pipeline that pins its actions, scans images before publication and patches flagged dependencies |

The exact difference is always `git diff` between this branch and the upstream
commit it was last merged from.

## License

This fork keeps upstream's licensing unchanged. See [LICENSE.MD](LICENSE.MD).

- Everything outside a `/proprietary` directory is under the **Apache License
  2.0**. The fork's own changes are offered under the same license.
- Code inside a `/proprietary` directory belongs to Dokploy Technology, Inc.
  and is under the Dokploy Source Available License
  ([LICENSE_PROPRIETARY.md](LICENSE_PROPRIETARY.md)). **This fork does not
  modify those files.** Using those features in production requires a
  commercial agreement with Dokploy, exactly as it does upstream.

## Staying current

Upstream releases are merged into `mj/prod-caddy`. If the Caddy work is
accepted upstream, this fork's reason to exist shrinks to whatever has not yet
been offered or accepted.
