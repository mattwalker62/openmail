# openmail

Agent-first email on Cloudflare Workers. Bring your own Amazon SES; send transactional mail and
owner-approved campaigns from your apps (HTTP API) or your agents (MCP).

**Status:** early. Not ready for use.

## Develop
```sh
npm install
npm test          # runs against a local D1 in the Workers runtime
npm run preflight # every CI gate
```
