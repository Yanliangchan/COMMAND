// ============================================================================
// ISLAND OPS — end-to-end checks in a real browser.
//   npm run e2e
//
// Starts the Vite dev server, drives the actual UI with Playwright (Chromium),
// and checks the player journeys and the regressions found in the release
// audit: corrupt saved settings, keyboard-only play, double Ready, stale
// timers after Skip, recon/undo, save & resume, spectating after elimination
// through to the end screen, the help dialog's focus handling, and the phone
// layout. Needs a Chromium that Playwright can launch (PLAYWRIGHT_BROWSERS_PATH
// or `npx playwright install chromium`).
// ============================================================================

import { chromium } from 'playwright';
import { createServer } from 'vite';

let failures = 0;
const check = (c, m) => {
  console.log(`${c ? ' ok ' : 'FAIL'}  ${m}`);
  if (!c) failures++;
};

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();

const errors = [];
async function open(viewport = { width: 1366, height: 768 }, storage = {}) {
  const ctx = await browser.newContext({ viewport, hasTouch: viewport.width < 900 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.goto(url);
  await page.getByTestId('deploy').waitFor();
  return { ctx, page };
}

const click = (page, sel) => page.evaluate((s) => document.querySelector(s)?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })), sel);
const mine = (page) => page.$$eval('path.io-region.io-hl-place', (els) => els.map((e) => e.getAttribute('data-region')));

async function deployAll(page) {
  await page.getByTestId('tool-deploy').click();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  const [r] = await mine(page);
  await click(page, `path[data-region="${r}"]`);
  return r;
}

async function bannerTitles(page) {
  return page.$$eval('.io-banner-title', (els) => els.map((e) => e.textContent));
}

// --- 1. Corrupt saved settings never break Start (QA-01) ---------------------
for (const bad of ['{"faction":"__proto__"}', '{"faction":"toString"}', '{"opponents":"abc","level":"NOPE"}', 'null', '[]', '{not json']) {
  const { ctx, page } = await open(undefined, { island_ops_setup_v2: bad });
  await page.getByTestId('deploy').click();
  const started = await page.getByTestId('ready').isVisible({ timeout: 4000 }).catch(() => false);
  check(started, `corrupt setup ${bad} still starts a match`);
  await ctx.close();
}

// --- 2. A whole round by keyboard alone (A11Y-01) ----------------------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('ready').waitFor();
  await page.getByRole('button', { name: 'All', exact: true }).focus();
  await page.keyboard.press('Enter');
  const [home] = await mine(page);
  await page.focus(`[data-badge="${home}"]`);
  await page.keyboard.press('Enter');
  check((await page.getByTestId('tool-deploy').textContent()).includes('✓'), 'keyboard: deploy every new troop with Enter on a region');
  await page.getByTestId('tool-move').focus();
  await page.keyboard.press('Enter');
  await page.focus(`[data-badge="${home}"]`);
  await page.keyboard.press('Enter');
  const targets = await page.$$eval('path.io-region.io-hl-target', (els) => els.map((e) => e.getAttribute('data-region')));
  const owned = await page.$$eval('[data-badge]', (els) => els.length);
  check(targets.length > 0 && owned === 39, 'keyboard: selecting a source lights its neighbours');
  await page.focus(`[data-badge="${targets[0]}"]`);
  await page.keyboard.press('Enter');
  const picker = await page.getByTestId('picker').isVisible();
  check(picker, 'keyboard: Enter on a neighbour opens the picker');
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Troops to send'), 'keyboard: picker focuses the troop slider');
  await page.keyboard.press('Enter');
  check(!(await page.getByTestId('picker').isVisible().catch(() => false)), 'keyboard: Enter confirms the picker');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Enter');
  check(await page.getByTestId('skip').isVisible({ timeout: 3000 }).catch(() => false), 'keyboard: Enter sends the orders (Ready)');
  // Arrow keys walk between neighbouring regions.
  await ctx.close();
}

// --- 3. Ready twice in one tick resolves once (QA-06) --------------------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await deployAll(page);
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="ready"]');
    b.click();
    b.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  });
  await page.waitForTimeout(300);
  const titles = await bannerTitles(page);
  check(titles.filter((t) => t.includes('Execute')).length === 1, `double Ready: one round resolved (banners: ${JSON.stringify(titles)})`);
  await ctx.close();
}

// --- 4. Skip leaves nothing behind for the next round (QA-05) ------------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  for (let round = 1; round <= 3; round++) {
    await deployAll(page);
    await page.getByTestId('ready').click();
    await page.getByTestId('step-card').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.getByTestId('skip').click();
  }
  await deployAll(page);
  await page.getByTestId('ready').click();
  await page.waitForTimeout(1200);
  const titles = await bannerTitles(page);
  check(!titles.some((t) => /secured|lost|wiped/.test(t)), `no stale banners from skipped rounds (${JSON.stringify(titles)})`);
  await ctx.close();
}

// --- 5. Recon is instant, and Undo says what it undid (QA-09/UX-07) ------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await deployAll(page);
  await page.getByTestId('tool-recon').click();
  const hint = await page.locator('.io-dock-hint').textContent();
  check(/can.t be undone/.test(hint), 'recon tool warns that recon cannot be undone');
  const target = await page.$eval('path.io-region.io-hl-recon', (e) => e.getAttribute('data-region'));
  await click(page, `path[data-region="${target}"]`);
  await page.getByRole('button', { name: 'Undo last order' }).click();
  const toast = await page.locator('.io-toast').textContent();
  check(/^Undone: \+\d+ troops?/.test(toast), `Undo names what it removed ("${toast}")`);
  await ctx.close();
}

// --- 6. Save and resume (ARC-03/QA-11) ----------------------------------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await deployAll(page);
  await page.getByTestId('ready').click();
  await page.getByTestId('skip').click();
  const round = await page.evaluate(() => JSON.parse(localStorage.getItem('island_ops_match_v1')).game.round);
  await page.reload();
  await page.getByTestId('continue').click();
  const hint = await page.locator('.io-dock-hint').textContent();
  check(round === 2 && hint.includes(`Round ${round}/`), `reload keeps the match: Continue resumes round ${round}`);
  await ctx.close();
}

// --- 6b. Leaving mid-playback can't take back a round you've seen resolve ---
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await deployAll(page);
  await page.getByTestId('ready').click();
  await page.getByTestId('skip').waitFor();
  await page.getByRole('button', { name: /Main menu/ }).click();
  await page.getByTestId('continue').click();
  const hint = await page.locator('.io-dock-hint').textContent();
  check(hint.includes('Round 2/'), `exit mid-playback, Continue: the resolved round stands (${hint.slice(0, 20)})`);
  check(await page.getByTestId('report').isVisible().catch(() => false), 'resuming shows the last round\'s report (RT-06)');
  await ctx.close();
}

// --- 6b2. Leaving during the deciding round still shows the result (RT-05) ---
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await page.getByTestId('ready').waitFor();
  // One round from victory: 29 VP and every Key Installation, each well garrisoned.
  await page.evaluate(() => {
    const m = JSON.parse(localStorage.getItem('island_ops_match_v1'));
    const g = m.game;
    const me = g.factions.find((f) => g.players[f].human);
    g.players[me].vp = 29;
    for (const r of ['tengah', 'seletar', 'paya-lebar', 'changi', 'tuas', 'sembawang', 'tanjong-pagar', 'marina-bay', 'jurong-island', 'bukit-timah', 'woodlands'])
      g.map[r] = { ...g.map[r], owner: me, troops: 40 };
    m.draft = [];
    localStorage.setItem('island_ops_match_v1', JSON.stringify(m));
  });
  await page.reload();
  await page.getByTestId('continue').click();
  await deployAll(page);
  await page.getByTestId('ready').click();
  await page.getByTestId('skip').waitFor();
  await page.getByRole('button', { name: /Main menu/ }).click();
  const offered = await page.getByTestId('continue').isVisible().catch(() => false);
  check(offered, 'leaving during the deciding round keeps the finished match');
  if (offered) {
    await page.getByTestId('continue').click();
    check(await page.getByRole('heading', { name: 'Victory' }).isVisible({ timeout: 4000 }).catch(() => false), 'Continue shows the result: Victory');
    await page.reload();
    check(!(await page.getByTestId('continue').isVisible().catch(() => false)), 'once the result has been shown the save is gone');
  }
  await ctx.close();
}

// --- 6b3. Landscape phone: the picker's Send button is on screen and on top (RT-03) ---
{
  const { ctx, page } = await open({ width: 844, height: 390 });
  await page.getByTestId('deploy').click();
  await deployAll(page);
  await page.getByTestId('tool-move').click();
  const [home] = await mine(page);
  await click(page, `path[data-region="${home}"]`);
  const target = await page.$eval('path.io-region.io-hl-target', (e) => e.getAttribute('data-region'));
  await click(page, `path[data-region="${target}"]`);
  const hit = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="picker-ok"]').getBoundingClientRect();
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return !!el?.closest('[data-testid="picker-ok"]') && b.bottom <= window.innerHeight;
  });
  check(hit, 'landscape phone: the picker\'s Send button is visible and clickable');
  await ctx.close();
}

// --- 6c. A corrupt saved match is never offered (it would crash every Continue) ---
for (const [label, mutate] of [
  ['ships not an array', 'm.game.ships = "x"'],
  ['ship in an unknown zone', 'm.game.ships[0].zone = "NOWHERE"'],
  ['player record missing', 'delete m.game.players[m.game.factions[1]]'],
  ['malformed draft order', 'm.draft = [{ kind: "MOVE", from: "nowhere" }]'],
  ['null log entry', 'm.game.log.push(null)'],
  ['log entry from an unknown side', 'm.game.log.push({ round: 1, who: "ZZZ", text: "x" })'],
  ['log text not a string', 'm.game.log.push({ round: 1, who: null, text: { x: 1 } })'],
  ['round beyond the limit', 'm.game.round = 99'],
  ['duplicate ship id', 'm.game.ships.push({ ...m.game.ships[0] })'],
]) {
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await page.getByTestId('ready').waitFor();
  await page.evaluate((code) => {
    const m = JSON.parse(localStorage.getItem('island_ops_match_v1'));
    new Function('m', code)(m);
    localStorage.setItem('island_ops_match_v1', JSON.stringify(m));
  }, mutate);
  await page.reload();
  await page.getByTestId('deploy').waitFor();
  const offered = await page.getByTestId('continue').isVisible().catch(() => false);
  if (offered) {
    await page.getByTestId('continue').click();
    await page.waitForTimeout(500);
    await page.getByTestId('tab-log').click().catch(() => {});
    await page.waitForTimeout(200);
  }
  const crashed = await page.getByText('Something went wrong').isVisible().catch(() => false);
  check(!crashed, `corrupt saved match (${label}) never crashes the game${offered ? ' (offered, but loads)' : ''}`);
  await ctx.close();
}

// --- 7. Eliminated: watch to the end, then the end screen (QA-02) -------------
{
  const { ctx, page } = await open();
  await page.getByTestId('deploy').click();
  await page.evaluate(() => {
    const m = JSON.parse(localStorage.getItem('island_ops_match_v1'));
    const g = m.game;
    const me = g.factions.find((f) => g.players[f].human);
    const heir = g.factions.find((f) => f !== me);
    for (const r of Object.keys(g.map)) if (g.map[r].owner === me) g.map[r].owner = heir;
    g.players[me].alive = false;
    g.players[me].eliminatedRound = g.round;
    g.ships = g.ships.filter((s) => s.owner !== me);
    localStorage.setItem('island_ops_match_v1', JSON.stringify(m));
  });
  await page.reload();
  await page.getByTestId('continue').click();
  await page.getByTestId('spectate').click();
  await page.evaluate(() => {
    // Skip each round's playback as soon as it starts.
    setInterval(() => document.querySelector('[data-testid="skip"]')?.click(), 150);
  });
  const ended = await page.getByRole('heading', { name: /Victory|Defeat/ }).waitFor({ timeout: 60000 }).then(() => true, () => false);
  check(ended, 'after elimination the bots play on to the end screen');
  check(ended && (await page.getByRole('heading', { name: 'Defeat' }).isVisible()), 'the end screen says Defeat');
  if (ended) {
    await page.getByRole('button', { name: 'Play again' }).click();
    check(await page.getByTestId('ready').isVisible({ timeout: 4000 }).catch(() => false), 'Play again starts a fresh match');
  }
  await ctx.close();
}

// --- 8. Help dialog: focus in, Escape out, focus back (A11Y-02) ---------------
{
  const { ctx, page } = await open();
  await page.getByTestId('howto').click();
  const inDialog = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  check(inDialog, 'help: focus moves into the dialog');
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  check(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'help: Tab stays inside the dialog');
  await page.keyboard.press('Escape');
  check(!(await page.getByRole('dialog').isVisible().catch(() => false)), 'help: Escape closes it');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'howto'), 'help: focus returns to the button that opened it');
  await ctx.close();
}

// --- 9. Phone: no sideways scroll, big enough targets, map opens readable (UX-04/UX-16)
{
  const { ctx, page } = await open({ width: 390, height: 844 });
  await page.getByTestId('deploy').click();
  await page.getByTestId('ready').waitFor();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'phone: no horizontal overflow');
  const small = await page.$$eval('.io-dock button, .io-topbar button', (els) => els.filter((e) => e.getBoundingClientRect().height < 38).map((e) => e.getAttribute('aria-label') || e.textContent));
  check(!small.length, `phone: HUD buttons are at least 38px tall (${small.join(', ') || 'all ok'})`);
  const badge = await page.$eval('[data-badge] g[filter] rect', (e) => e.getBoundingClientRect().width);
  check(badge >= 26, `phone: map opens zoomed so badges are readable (${badge.toFixed(0)}px)`);
  await ctx.close();
}

check(errors.length === 0, `no page errors or console errors${errors.length ? `: ${[...new Set(errors)].slice(0, 5).join(' | ')}` : ''}`);

await browser.close();
await server.close();
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall e2e checks passed');
