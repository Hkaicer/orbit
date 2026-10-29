// Protecting the Gmail app password with Windows DPAPI.
//
// DPAPI encrypts with a key tied to the Windows account: the stored value can
// only be decrypted by this user on this computer. PowerShell does the work
// (no native module to install). The secret goes through stdin in base64,
// never on a command line, and never into the database or the logs.

import { execFile } from "node:child_process";

export interface Protector {
  name: "dpapi" | "none";
  protect(plain: string): Promise<string>;
  unprotect(stored: string): Promise<string>;
}

// Unchanged since the first version (AuraJobs), so the password already saved stays readable.
const ENTROPY = "AuraJobs.gmail.v1";

const script = (op: "Protect" | "Unprotect") => `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$in = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY}')
$out = [Security.Cryptography.ProtectedData]::${op}($in, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($out))`;

function powershell(op: "Protect" | "Unprotect", inputB64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script(op)],
      { timeout: 30_000, windowsHide: true, encoding: "utf8" },
      (err, stdout) => (err ? reject(new Error("Le chiffrement Windows (DPAPI) a échoué.")) : resolve(stdout.trim())),
    );
    child.stdin?.end(inputB64);
  });
}

export const dpapi: Protector = {
  name: "dpapi",
  async protect(plain) {
    return powershell("Protect", Buffer.from(plain, "utf8").toString("base64"));
  },
  async unprotect(stored) {
    return Buffer.from(await powershell("Unprotect", stored), "base64").toString("utf8");
  },
};

/** Only for tests: no protection. */
export const noProtection: Protector = {
  name: "none",
  async protect(plain) {
    return Buffer.from(plain, "utf8").toString("base64");
  },
  async unprotect(stored) {
    return Buffer.from(stored, "base64").toString("utf8");
  },
};
