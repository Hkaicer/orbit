// Shows a page that only appears with JavaScript (a test platform's score card,
// for example), with Microsoft Edge or Chrome running invisible. Each page gets
// a new empty profile, deleted right after: no cookie, no account, no history
// of the user's own browser.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/microsoft-edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export const findBrowser = (): string | null => CANDIDATES.find((p) => p && fs.existsSync(p)) ?? null;

/** The page's HTML once its scripts have run, or null without a browser. */
export async function renderPage(url: string, timeoutMs = 45_000): Promise<string | null> {
  const browser = findBrowser();
  if (!browser) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-render-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--mute-audio",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=15000",
    "--dump-dom",
    url,
  ];
  try {
    return await new Promise<string | null>((resolve) => {
      const child = spawn(browser, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c: string) => {
        if (out.length < 5_000_000) out += c;
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(out.trim() ? out : null);
      });
    });
  } finally {
    // The browser may still hold its files for a moment.
    setTimeout(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }, () => undefined), 1000);
  }
}
