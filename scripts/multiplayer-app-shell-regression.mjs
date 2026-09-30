import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, shell, overlay, panel, characterPanel] = await Promise.all([
  readFile(new URL('../js/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui/multiplayer-overlay.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/multiplayer/multiplayer-panel.js', import.meta.url), 'utf8'),
  readFile(new URL('../js/ui/multiplayer-character-panel.js', import.meta.url), 'utf8')
]);

assert.match(shell, /id="btn-multiplayer"/u);
assert.match(shell, /eventBus\.emit\('app:open-multiplayer'\)/u);
assert.match(app, /openMultiplayerOverlay/u);
assert.match(app, /eventBus\.on\('app:open-multiplayer'/u);
assert.match(app, /eventBus\.on\('app:open-multiplayer', async \(options = \{\}\) =>/u);
assert.match(app, /MULTIPLAYER_ROOM_STORAGE_KEY = 'naruto_multiplayer_last_room'/u);
assert.match(app, /MULTIPLAYER_INVITE_SESSION_KEY = 'naruto_multiplayer_session_invite'/u);
assert.match(app, /globalThis\.localStorage\?\.setItem\(multiplayerRoomStorageKey\(\), roomId\)/u);
assert.match(app, /globalThis\.sessionStorage\?\.setItem\(MULTIPLAYER_INVITE_SESSION_KEY/u);
assert.match(app, /forgetRememberedMultiplayerSession\(\)/u);
assert.match(app, /this\._scheduleMultiplayerRestore\(\)/u);
assert.match(app, /eventBus\.request\('app:open-multiplayer', \{/u);
assert.match(app, /autoRestore: true/u);
assert.match(app, /await panel\.connectRoom\(roomId\)/u);
assert.match(app, /if \(forgetSession\) \{/u);
assert.match(app, /const user = await authClient\.checkAuth\(true\);/u);
assert.match(app, /if \(!user\) \{\s*window\.location\.href = '\/login\.html';\s*return null;\s*\}/u);
assert.ok(
  app.indexOf('await authClient.checkAuth(true)')
    < app.indexOf('this._multiplayerOverlay = openMultiplayerOverlay'),
  'authentication refresh must complete before the multiplayer overlay opens'
);
assert.match(overlay, /panel\.controller\?\.disconnect/u);
assert.match(overlay, /panel\.controller\?\.disconnect\?\.\(\{ reset: true \}\)/u);
assert.match(overlay, /await chooseRoomExit\(\)/u);
assert.ok(overlay.indexOf('await localRoomHistory.remember') < overlay.indexOf("savedRoom: choice === 'save'"), 'exit must wait for the requested local snapshot');
assert.match(overlay, /multiplayer-exit-request/u);
assert.match(overlay, /document\.createElement\(PANEL_TAG\)/u);
assert.match(shell, /id="multiplayer-character-panel"/u);
assert.match(shell, /multiplayerInfo\?\.setSessionState/u);
assert.match(characterPanel, /projectedAuthoritativeState/u);
assert.match(characterPanel, /服务端状态/u);
assert.match(app, /canSubmitProjectedAction\(multiplayer\.state\)/u);
assert.match(app, /actionSubmissionUnavailableMessage\(multiplayer\.state\)/u);
assert.match(app, /const options = multiplayerPanel\.actionOptions/u);
assert.match(app, /visibility: options\.visibility/u);
assert.match(panel, /narrationPreference: 'full'/u);
assert.match(shell, /const canSubmit = canSubmitProjectedAction\(value\)/u);
assert.match(shell, /const unavailableMessage = actionSubmissionUnavailableMessage\(value\)/u);
assert.match(panel, /id="copy-room-invite"/u);
assert.match(panel, /id="copy-room-code"/u);
assert.match(panel, /id="copy-invite-code"/u);
assert.match(panel, /id="exit-room"/u);
assert.match(panel, /id="active-exit-room"/u);
assert.match(panel, /activeMemberCount < 2 \? state\.invite : null/u);
assert.match(panel, /id="active-action-visibility"/u);
assert.match(panel, /id="main-api-scheme"/u);
assert.match(panel, /id="import-main-api-scheme"/u);
assert.match(panel, /id="turn-recovery"[^>]*hidden/u);
assert.match(panel, /<details id="room-tools"/u);

for (const removedControl of [
  'new-era',
  'new-preset',
  'custom-room-code',
  'custom-invite-code',
  'restore-room',
  'refresh-room',
  'copy-current-room',
  'action-form',
  'action-text',
  'action-visibility',
  'narration-preference',
  'narration-note',
  'state-output',
  'memory-output',
  'daily-output',
  'timeline-output',
  'lineage-output',
  'probe-output',
  'void-proposal',
  'archive-proposal',
  'continuation-proposal',
  'export-output'
]) {
  assert.doesNotMatch(panel, new RegExp(`id="${removedControl}"`, 'u'));
}

for (const source of [overlay, panel, characterPanel]) {
  assert.doesNotMatch(source, /MessagePipeline|InstructionParser|_applyInstructions|stateManager/u);
}

console.log('multiplayer app-shell regression passed');
