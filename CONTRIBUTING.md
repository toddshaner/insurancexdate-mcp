# Contributing

Personal project, MIT licensed. PRs and issues are welcome but there's no SLA on response times.

## Filing an issue

Useful issues include one of:

- A reproducible bug (steps, expected, actual, the request payload if relevant)
- A schema mismatch between this wrapper and the upstream InsuranceXDate API
- A documentation gap or factual error
- A request for a tool or filter that the upstream supports but this wrapper doesn't expose

If you're seeing a "filter not applied" symptom, please curl `tools/list` against `https://www.insurancexdate.com/api2/McpData` first and compare the param names and types against this wrapper's schema before opening the issue. The CHANGELOG documents two bugs (one in `serff_search`, one in `search`) that were caught this way.

## Submitting a PR

1. Fork the repo
2. Create a branch off `main`
3. Make your change in `server/src/`
4. Run `cd server && npm run build` — must exit 0 with `noEmitOnError: true`
5. If the change touches schema or behavior, add a CHANGELOG entry under `## [Unreleased]`
6. Open a PR with:
   - What changed and why
   - Whether it's a bug fix, feature, or refactor
   - Verification steps (curl output, `tools/list` diff, or live test transcript)

CI runs the build on Node 20.x and 22.x and verifies `mcpb pack` succeeds end-to-end. Both checks must pass before merge.

## Code style

- TypeScript with `strict: true` and `noEmitOnError: true`. Don't disable either.
- zod schemas on every tool input. Optional fields stay optional; required fields stay required.
- Comments explain *why*, not *what*. Anything load-bearing or non-obvious gets a comment.
- No new dependencies without a clear reason. Current deps: `@modelcontextprotocol/sdk`, `zod`. That's it.

## Testing changes against XDate live

Set `INSURANCEXDATE_API_KEY` in env, then:

```sh
cd server && npm run build
INSURANCEXDATE_API_KEY=your-key node dist/index.js
```

The server speaks MCP on stdio. For interactive testing, point any MCP client at `dist/index.js` (see README's Install section). For non-interactive testing, pipe JSON-RPC requests via stdin.

Free tools (`search`, `match`, `filter`) are safe to exercise. Paid tools (`company_details`, `talkpoints`, `serff_search`, `serff_filing`) charge your XDate account per call. Set `XDATE_DISABLE_PAID=1` to short-circuit them with `isError` while you iterate.

## License

By submitting a PR, you agree to license your contribution under MIT, the same license as the repo.
