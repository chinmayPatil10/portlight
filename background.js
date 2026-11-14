import { runCycle } from './lib/cycle.js';

const TICK = 'portlight-tick';

function setup() {
  chrome.alarms.clear('keel-tick'); // name used before the rename
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.get(TICK, (a) => { if (!a) chrome.alarms.create(TICK, { periodInMinutes: 5, delayInMinutes: 1 }); });
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
setup();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === TICK) runCycle({ force: true, background: true }).catch(() => {});
});

// Clicking an alert notification opens the panel on the current window.
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  try {
    const w = await chrome.windows.getLastFocused();
    await chrome.sidePanel.open({ windowId: w.id });
  } catch { /* panel can only open from a user gesture in some Chrome versions */ }
});
