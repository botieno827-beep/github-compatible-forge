# Standalone GitHub-compatible forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/botieno827-beep/github-compatible-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/botieno827-beep/github-compatible-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A single-process forge with an in-memory store shared by Git smart HTTP, the GitHub REST v3 API, GraphQL, and MCP. It has no UI and uses only the Node.js standard library: no install step, Git executable, database service, or external API is required.

Built for [make.fun's GitHub-compatible git forge bounty](https://make.fun/bounty/github-core-clone-01). Distributed under the MIT license.

## Run

Use Node.js 22.18 or later:

```sh
node main.ts
```

The process binds an ephemeral port and prints its address. `FORGE_PORT` and `FORGE_HOST` configure standalone operation. Port 8080 is reserved for the bounty suite.

During a bounty trial, `MAKEFUN_ENV_URL` names the suite: the forge registers its allocated port, serves requests, polls `/done`, and exits after the suite finishes. `MAKEFUN_SHOP_TOKEN` supplies the bearer token used to authenticate the shared API surfaces.

## Interfaces

- Git smart HTTP: `/{owner}/{repo}.git`, including upload-pack v2 and receive-pack v0.
- REST: `/api/v3`, including repositories, contents, labels, issues, and pull requests.
- GraphQL: `/api/graphql`, with queries and mutations over the same store.
- MCP: `/mcp`, with discovery, tool schemas, and repository, issue, and pull-request tools.
- Health check: `/healthz`.

Repository state is process-local and starts fresh on each run.

## Tests

```sh
node --test test/server.test.ts test/surfaces.test.ts tests/git.test.ts
```

The tests cover authentication, error responses, GraphQL validation and pagination, concurrent MCP requests, Git pack objects and deltas, fast-forward checks, and shared state across the interfaces.

With the separately downloaded make.fun kit in `github-core-clone-01-kit/`, the advisory native suite can be run with:

```sh
node scripts/kit-local.ts
```

The competition's own sandbox grading remains authoritative.
