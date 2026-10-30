// An estimate without the AI, when Claude is unavailable: the share of the
// offer's technical keywords that appear in the user's own CVs. It is labeled
// as a local estimate and never replaces a real analysis.

import type { Analysis } from "../../shared/types";
import type { Database } from "../db/database";
import { normalize } from "../domain/offers";

export const KEYWORDS = [
  "siem",
  "soc",
  "edr",
  "xdr",
  "soar",
  "splunk",
  "elastic",
  "elk",
  "wazuh",
  "sysmon",
  "sentinel",
  "qradar",
  "mitre",
  "att&ck",
  "threat intelligence",
  "cti",
  "incident",
  "forensic",
  "detection",
  "pentest",
  "vulnerabilit",
  "owasp",
  "iso 27001",
  "iso 27005",
  "ebios",
  "nis2",
  "dora",
  "rgpd",
  "gdpr",
  "grc",
  "audit",
  "risque",
  "risk",
  "conformit",
  "compliance",
  "pci",
  "nist",
  "cis",
  "iam",
  "identit",
  "pki",
  "cloud",
  "azure",
  "aws",
  "gcp",
  "kubernetes",
  "docker",
  "terraform",
  "ansible",
  "devsecops",
  "python",
  "sql",
  "machine learning",
  "apprentissage",
  "ia ",
  "intelligence artificielle",
  "llm",
  "rag",
  "genai",
  "ia generative",
  "data",
  "power bi",
  "excel",
  "linux",
  "windows",
  "active directory",
  "reseau",
  "firewall",
  "pare-feu",
  "gouvernance",
  "strategie",
  "transformation",
  "conseil",
  "consulting",
  "banque",
  "finance",
  "anglais",
  "english",
];

export function localAnalysis(db: Database, description: string): Analysis {
  const offer = ` ${normalize(description)} `;
  const cvs = db
    .all<{ text: string | null }>("SELECT text FROM documents WHERE kind = 'cv' AND private = 0")
    .map((r) => normalize(r.text ?? ""))
    .join(" ");
  const asked = KEYWORDS.filter((k) => offer.includes(` ${normalize(k)}`));
  const have = asked.filter((k) => cvs.includes(normalize(k)));
  const missing = asked.filter((k) => !have.includes(k));
  const ratio = asked.length ? have.length / asked.length : 0;
  const score = asked.length ? Math.round(30 + ratio * 55) : 0;
  return {
    score,
    breakdown: { skills: Math.round(ratio * 45), education: 0, experience: 0 },
    verdict: score >= 75 ? "apply" : score >= 55 ? "check" : "skip",
    pros: have.length ? [`Mots-clés de l'offre présents dans vos CV : ${have.join(", ")}`] : [],
    gaps: missing.length ? [`Mots-clés de l'offre absents de vos CV : ${missing.join(", ")}`] : [],
    toVerify: ["Estimation locale par mots-clés, sans lecture réelle de l'offre : lancez l'analyse avec Claude pour un avis fiable."],
    highlight: have,
    cvAdjustments: [],
    nextActions: ["Analyser l'offre avec Claude"],
    practical: [],
    facts: { verified: [], inferred: [], missing: asked.length ? [] : ["L'offre ne cite aucun mot-clé technique reconnu"] },
    by: "local",
    at: new Date().toISOString(),
  };
}
