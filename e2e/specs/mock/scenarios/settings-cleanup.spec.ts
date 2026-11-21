import { expect, test } from '../fixtures';
import { NEW_CHAT_PATH } from '../helpers';
import { openSidebar } from './sidebar';

test('settings offer only applicable controls @scenario:settings-cleanup', async ({
  page,
}, testInfo) => {
  await page.route('**/api/files/speech/config/get', (route) =>
    route.fulfill({
      json: { sttExternal: true, ttsExternal: true, engineSTT: 'browser', engineTTS: 'browser' },
    }),
  );
  await page.route('**/api/files/speech/tts/voices', (route) => route.fulfill({ json: ['alloy'] }));
  await page.route('**/api/roles/*', async (route) => {
    const response = await route.fetch();
    const role = await response.json();
    await route.fulfill({
      response,
      json: {
        ...role,
        permissions: { ...role.permissions, PROMPTS: { ...role.permissions?.PROMPTS, USE: false } },
      },
    });
  });
  await page.addInitScript(() => {
    if (sessionStorage.getItem('settings-cleanup-seeded')) return;
    for (const [key, value] of Object.entries({
      engineSTT: 'browser',
      engineTTS: 'browser',
      speechToText: true,
      textToSpeech: true,
      autoTranscribeAudio: false,
      autoSendText: 8,
      decibelValue: -60,
      automaticPlayback: false,
      conversationMode: true,
    })) {
      localStorage.setItem(key, JSON.stringify(value));
    }
    sessionStorage.setItem('settings-cleanup-seeded', '1');
  });
  await page.goto(NEW_CHAT_PATH);
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  for (const query of ['Display username', 'Save badges state', 'Advanced prompts']) {
    await dialog.getByRole('textbox', { name: 'Search settings' }).fill(query);
    await expect(dialog.getByText('No settings match your search', { exact: false })).toBeVisible();
  }
  await dialog.getByRole('textbox', { name: 'Search settings' }).clear();
  await dialog.getByRole('tab', { name: 'Chat', exact: true }).click();
  await testInfo.attach('chat-settings-after', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const back = dialog.getByRole('button', { name: 'Back', exact: true });
  if (await back.isVisible()) await back.click();
  await dialog.getByRole('tab', { name: 'Speech', exact: true }).click();
  const sensitivity = dialog.getByText('Decibel sensitivity', { exact: true });
  const playback = dialog.getByText('Audio Playback Rate', { exact: true });
  const cache = dialog.getByRole('switch', { name: 'Enable cache TTS', exact: true });
  await expect(sensitivity).toBeHidden();
  await expect(playback).toBeHidden();
  await expect(cache).toBeHidden();
  const stt = dialog.getByTestId('EngineSTTDropdown');
  await stt.click();
  await page
    .locator(`[id="${await stt.getAttribute('aria-controls')}"]`)
    .getByRole('option', { name: 'External', exact: true })
    .click();
  await expect(sensitivity).toBeVisible();
  const tts = dialog.getByTestId('EngineTTSDropdown');
  await tts.click();
  await page
    .locator(`[id="${await tts.getAttribute('aria-controls')}"]`)
    .getByRole('option', { name: 'External', exact: true })
    .click();
  await expect(playback).toBeVisible();
  await expect(cache).toBeVisible();
  await dialog.getByRole('switch', { name: 'Text to Speech', exact: true }).click();
  const apply = dialog.getByRole('button', { name: 'Apply preset', exact: true });
  await expect(apply).toBeEnabled();
  await apply.focus();
  await page.keyboard.press('Enter');
  const preferences = () =>
    page.evaluate(() =>
      [
        'autoTranscribeAudio',
        'autoSendText',
        'decibelValue',
        'textToSpeech',
        'automaticPlayback',
      ].map((key) => JSON.parse(localStorage.getItem(key) ?? 'null')),
    );
  await expect.poll(preferences).toEqual([true, 3, -45, false, false]);
  await testInfo.attach('speech-settings-after', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.reload();
  await expect.poll(preferences).toEqual([true, 3, -45, false, false]);
});
