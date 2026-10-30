// Opening a link for the assistant, read only: to see a test result or an offer
// cited in an email. Only public pages, without cookies or any account. A link
// that would do something (unsubscribe, confirm, accept or decline, sign in with
// a one-time link...) is never opened, at any step of its redirects: opening it
// could act for the user, or use up a link meant for them.

import { BLOCK_HOSTS, htmlToText, type FetchFn } from "./fetchOffer";

/** Words of a link that acts instead of showing something. */
const ACTS =
  /(unsubscribe|desabonn|désabonn|desinscri|désinscri|opt-?out|remove-?me|confirm|accept|decline|reject|refus|cancel|annul|delete|supprim|withdraw|desist|reschedul|rsvp|vote|approve|activate|verif|reset|password|mot-de-passe|magic|one-?click|login|log-in|signin|sign-in|sso|oauth|authorize|logout)/i;

export interface OpenedPage {
  url: string;
  status: number;
  title: string | null;
  text: string;
  /** The page asks to sign in: only the user can open it. */
  loginRequired: boolean;
  /** The page only appeared with JavaScript: it was shown by an invisible browser. */
  rendered?: boolean;
}

export class LinkRefused extends Error {}

const MAX_BYTES = 3_000_000;

function check(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LinkRefused("Ce n'est pas une adresse web valide.");
  }
  if (!/^https?:$/.test(u.protocol) || BLOCK_HOSTS.test(u.hostname)) throw new LinkRefused("Seuls les liens publics en http ou https sont ouverts.");
  const raw2 = `${u.hostname}${u.pathname}?${u.search}`;
  let words = raw2;
  try {
    words = decodeURIComponent(raw2);
  } catch {
    // a malformed escape: the address is checked as written
  }
  words = words.toLowerCase();
  const act = ACTS.exec(words);
  if (act) throw new LinkRefused(`Ce lien semble déclencher une action (« ${act[1]} ») : ORBIT ne l'ouvre pas. L'utilisateur peut l'ouvrir lui-même s'il le souhaite.`);
  return u;
}

/** Pages built by JavaScript show almost nothing to a plain reading. */
const NEEDS_JS = /(enable javascript|activer javascript|javascript (has been|is) disabled|javascript est d[ée]sactiv|requires javascript|n[ée]cessite javascript)/i;

export async function openLink(fetchFn: FetchFn, raw: string, opts: { render?: (url: string) => Promise<string | null> } = {}): Promise<OpenedPage> {
  let url = check(raw);
  // Each redirect is checked before it is followed: a tracking link may lead to an action.
  for (let hop = 0; hop < 6; hop++) {
    const res = await fetchFn(url.toString(), {
      redirect: "manual",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(20_000),
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = check(new URL(next, url).toString());
      continue;
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/html|json|text\/plain/i.test(type)) return { url: url.toString(), status: res.status, title: null, text: `(fichier ${type || "inconnu"} : non lu)`, loginRequired: false };
    const body = (await res.text()).slice(0, MAX_BYTES);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? null;
    let text = /json/i.test(type) ? body.slice(0, 12_000) : htmlToText(body).slice(0, 12_000);
    let rendered = false;
    // An empty application shell (<div id="root"></div>) or a request to enable JavaScript.
    const shell = /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(body);
    if (!/json/i.test(type) && res.ok && opts.render && (NEEDS_JS.test(text) || (shell && text.length < 400) || text.length < 30)) {
      const shown = await opts.render(url.toString());
      if (shown) {
        text = htmlToText(shown).replace(NEEDS_JS, "").slice(0, 12_000);
        rendered = true;
      }
    }
    const loginRequired =
      res.status === 401 ||
      res.status === 403 ||
      /<input[^>]+type=["']?password/i.test(body) ||
      (/(connexion|se connecter|sign in|log in|login|identifiez-vous)/i.test(`${title ?? ""} ${text.slice(0, 600)}`) && text.length < 2500);
    return { url: url.toString(), status: res.status, title: title ? htmlToText(title) : null, text, loginRequired, ...(rendered ? { rendered } : {}) };
  }
  throw new LinkRefused("Trop de redirections : la page n'a pas été lue.");
}

/** The links of an email, with their text, for the assistant to choose the one it needs. */
export function emailLinks(html: string | null, text: string | null): { text: string; url: string; acts: boolean }[] {
  const found = new Map<string, string>();
  for (const m of (html ?? "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = m[1]!.replace(/&amp;/g, "&").trim();
    if (/^https?:\/\//i.test(url) && !found.has(url)) found.set(url, htmlToText(m[2]!).replace(/\s+/g, " ").trim().slice(0, 120));
  }
  for (const m of (text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) if (!found.has(m[0])) found.set(m[0], "");
  return [...found].slice(0, 40).map(([url, label]) => {
    let acts = false;
    try {
      check(url);
    } catch {
      acts = true;
    }
    return { text: label, url, acts };
  });
}
