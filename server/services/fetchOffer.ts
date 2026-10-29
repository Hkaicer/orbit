// Reading an offer from its link.
//
// Many career sites publish the offer as schema.org "JobPosting" data in the
// page: it is read first, without the AI. Otherwise the visible text of the page
// is extracted. A page that refuses the request, needs a login or only renders
// with JavaScript is reported as such: the user is then asked to paste the
// description, and nothing is claimed about a page that was not read.

import type { OfferInput } from "../domain/offers";

export type FetchFn = typeof fetch;

export type PageResult =
  | { ok: true; url: string; title: string | null; text: string; posting: Partial<OfferInput> | null }
  | { ok: false; reason: "invalid" | "blocked" | "not_found" | "network" | "empty"; message: string };

const BLOCK_HOSTS = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;
const LOGIN_ONLY = /(^|\.)(linkedin\.com|indeed\.(com|fr)|jobteaser\.com|glassdoor\.(com|fr))$/i;

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", rsquo: "’", laquo: "«", raquo: "»" };

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|ul|ol)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Json = Record<string, unknown>;

function findPosting(node: unknown): Json | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findPosting(n);
      if (found) return found;
    }
    return null;
  }
  const o = node as Json;
  const type = o["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return o;
  return findPosting(o["@graph"]);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function locationOf(loc: unknown): string | null {
  const first = Array.isArray(loc) ? loc[0] : loc;
  const addr = first && typeof first === "object" ? ((first as Json).address as Json | string | undefined) : undefined;
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  return [str(addr.addressLocality), str(addr.postalCode) ? `(${str(addr.postalCode)})` : null, str(addr.addressCountry) && !/^(fr|france)$/i.test(String(addr.addressCountry)) ? str(addr.addressCountry) : null].filter(Boolean).join(" ") || null;
}

const CONTRACTS: Record<string, string> = { INTERN: "Stage", FULL_TIME: "CDI ou temps plein", PART_TIME: "Temps partiel", CONTRACTOR: "Prestataire", TEMPORARY: "CDD", OTHER: "Autre" };

/** The fields of a schema.org JobPosting found in the page. */
export function postingFields(html: string): Partial<OfferInput> | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const p = findPosting(data);
    if (!p) continue;
    const org = p.hiringOrganization as Json | string | undefined;
    const types = (Array.isArray(p.employmentType) ? p.employmentType : [p.employmentType]).map((t) => CONTRACTS[String(t)] ?? str(t)).filter(Boolean);
    const id = p.identifier as Json | string | undefined;
    return {
      title: str(p.title) ?? undefined,
      company: (typeof org === "string" ? org : str(org?.name)) ?? undefined,
      location: locationOf(p.jobLocation),
      contract: types.join(", ") || null,
      reference: typeof id === "object" && id ? str(id.value) : str(id),
      description: p.description ? htmlToText(String(p.description)) : "",
    };
  }
  return null;
}

export async function fetchOfferPage(rawUrl: string, fetchFn: FetchFn = fetch): Promise<PageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: "invalid", message: "Ce n'est pas un lien valide." };
  }
  if (!/^https?:$/.test(url.protocol) || BLOCK_HOSTS.test(url.hostname)) return { ok: false, reason: "invalid", message: "Seuls les liens publics en http ou https sont acceptés." };
  if (LOGIN_ONLY.test(url.hostname.replace(/^www\./, ""))) {
    return { ok: false, reason: "blocked", message: `${url.hostname} n'autorise pas la lecture automatique de ses offres. Collez le texte de l'annonce.` };
  }
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ORBIT/0.1 (outil personnel)", accept: "text/html,application/xhtml+xml", "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, reason: "network", message: "La page n'a pas pu être chargée. Vérifiez le lien et la connexion, ou collez le texte de l'annonce." };
  }
  if (res.status === 404 || res.status === 410) return { ok: false, reason: "not_found", message: "La page n'existe plus : l'offre a peut-être été retirée." };
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status === 999) {
    return { ok: false, reason: "blocked", message: "Le site refuse la lecture automatique. Collez le texte de l'annonce." };
  }
  if (!res.ok) return { ok: false, reason: "network", message: `Le site a répondu par une erreur (${res.status}). Collez le texte de l'annonce.` };
  const body = (await res.text()).slice(0, 3_000_000);
  const posting = postingFields(body);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? null;
  const text = posting?.description && posting.description.length > 200 ? posting.description : htmlToText(body).slice(0, 60_000);
  if (!posting && text.length < 300) {
    return { ok: false, reason: "empty", message: "La page ne contient presque pas de texte (elle s'affiche avec JavaScript). Collez le texte de l'annonce." };
  }
  return { ok: true, url: res.url || url.toString(), title: title ? htmlToText(title) : null, text, posting };
}
