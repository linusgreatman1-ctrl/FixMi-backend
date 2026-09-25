const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// Same principle as the mobile shell: load the real deployed web app
// directly rather than bundling a second copy of the frontend, so the
// desktop app can never drift from what /app actually serves.
const APP_URL = process.env.FIXME_APP_URL || "https://YOUR-DEPLOYED-BACKEND.example.com/app";

function createWindow() {
  const win = new BrowserWindow({
    width: 430,
    height: 900,
    minWidth: 375,
    title: "FixMe",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL(APP_URL);

  // Anything that isn't the app itself (Paystack checkout popups, external
  // links) should open in the system browser, not take over the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
