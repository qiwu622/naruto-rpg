## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Release announcements

Every production release must include a dated website announcement. Update the
package/app versions, CHANGELOG.md and docs/releases/v<version>-discord.md, then
run sync-public to generate announcements.html and its public copy. Keep the
login-page and in-game settings announcement entries available. Verify the live
website announcement matches the released version after deployment. Include
upgrade and save-compatibility notes, and preserve historical announcements.
