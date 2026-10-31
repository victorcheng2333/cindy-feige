// Integration-only bootstrap: capture the real Tray so tests exercise its actual
// registered handlers, without adding a debug IPC or test hook to the shipped app.
const { Tray } = require('electron');
const on = Tray.prototype.on;
Tray.prototype.on = function (event, listener) {
  if (event === 'click') {
    globalThis.quotaCatTestTray = this;
    Tray.prototype.on = on;
  }
  return on.call(this, event, listener);
};
require(process.argv[2]);
