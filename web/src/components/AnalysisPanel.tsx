import type { Analysis, Offer } from "@shared/types";
import { CircleAlert, Info, OctagonAlert, Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { VERDICT_LABELS, fmtDate, verdictTone } from "../lib/format";
import { Markdown } from "../lib/markdown";
import { useUi } from "../lib/store";
import { ScoreChip, useAction } from "./bits";
import { Badge, Button } from "./ui";

const PARTS: { key: keyof Analysis["breakdown"]; label: string; max: number }[] = [
  { key: "skills", label: "Compétences techniques", max: 45 },
  { key: "education", label: "Formation et niveau", max: 20 },
  { key: "experience", label: "Expérience et missions", max: 35 },
];

const LISTS: { key: "pros" | "gaps" | "toVerify" | "highlight" | "cvAdjustments" | "nextActions"; label: string }[] = [
  { key: "pros", label: "Points forts" },
  { key: "gaps", label: "Lacunes" },
  { key: "toVerify", label: "Critères à vérifier" },
  { key: "highlight", label: "À mettre en avant" },
  { key: "cvAdjustments", label: "Ajustements du CV" },
  { key: "nextActions", label: "Prochaines actions" },
];

export const analyzePrompt = (o: Pick<Offer, "id" | "company" | "title">) =>
  `Analyse l'offre « ${o.title} » chez ${o.company} (fiche ${o.id}) avec ma grille, en comparant à mes CV, puis enregistre l'analyse. Sépare ce qui est vérifié, déduit et manquant.`;

export const documentsPrompt = (o: Pick<Offer, "id" | "company" | "title">, applicationId?: string | null) =>
  `Prépare un CV et une lettre de motivation adaptés à l'offre « ${o.title} » chez ${o.company} (fiche ${o.id}${applicationId ? `, candidature ${applicationId}` : ""}), en suivant mes règles de rédaction. Ne remplace aucune lettre déjà validée.`;

export function AnalysisPanel({ offer }: { offer: Offer }) {
  const ui = useUi();
  const { busy, run } = useAction();
  const [showImported, setShowImported] = useState(!offer.analysis || offer.analysis.by === "import");
  const a = offer.analysis;

  return (
    <div className="analysis">
      {a ? (
        <>
          <div className="analysis-head">
            <div className="analysis-score">
              <ScoreChip score={a.score} by={a.by} />
              <span className="text-3">/ 100</span>
            </div>
            <div className="analysis-verdict">
              <Badge tone={verdictTone(a.verdict)}>{VERDICT_LABELS[a.verdict]}</Badge>
              <span className="text-3">
                {a.by === "claude" ? `Analyse de Claude${a.model ? ` (${a.model})` : ""}` : a.by === "local" ? "Estimation locale par mots-clés, sans Claude" : "Analyse importée"} · {fmtDate(a.at)}
              </span>
            </div>
            <div className="analysis-redo">
              <Button size="sm" variant="ghost" icon={<Sparkles />} onClick={() => ui.ask(analyzePrompt(offer))}>
                {a.by === "claude" ? "Refaire avec Claude" : "Analyser avec Claude"}
              </Button>
            </div>
          </div>

          {PARTS.some((p) => a.breakdown[p.key] > 0) && (
            <div className="analysis-parts">
              {PARTS.map((p) => (
                <div key={p.key} className="analysis-part">
                  <span className="analysis-part-label">{p.label}</span>
                  <span className="perf-meter" role="img" aria-label={`${a.breakdown[p.key]} sur ${p.max}`}>
                    <span style={{ width: `${Math.max(0, Math.min(100, (a.breakdown[p.key] / p.max) * 100))}%` }} />
                  </span>
                  <span className="tnum text-2">
                    {a.breakdown[p.key]} / {p.max}
                  </span>
                </div>
              ))}
            </div>
          )}

          {a.practical.length > 0 && (
            <ul className="practical">
              {a.practical.map((p, i) => (
                <li key={i} className={`practical-item is-${p.severity}`}>
                  {p.severity === "blocking" ? <OctagonAlert /> : p.severity === "warning" ? <CircleAlert /> : <Info />}
                  <span>
                    {p.severity === "blocking" && <strong>Bloquant : </strong>}
                    {p.label}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="analysis-lists">
            {LISTS.filter((l) => a[l.key].length > 0).map((l) => (
              <div key={l.key} className="analysis-list">
                <h4>{l.label}</h4>
                <ul>
                  {a[l.key].map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {(a.facts.verified.length > 0 || a.facts.inferred.length > 0 || a.facts.missing.length > 0) && (
            <div className="facts">
              <FactList title="Vérifié" tone="success" items={a.facts.verified} />
              <FactList title="Déduit" tone="accent" items={a.facts.inferred} />
              <FactList title="Manquant" tone="warning" items={a.facts.missing} />
            </div>
          )}
        </>
      ) : (
        <div className="analysis-empty">
          <p>Pas encore d'analyse pour cette offre.</p>
          <div className="row-gap">
            <Button variant="primary" icon={<Sparkles />} onClick={() => ui.ask(analyzePrompt(offer))}>
              Analyser avec Claude
            </Button>
            <Button loading={busy === "local"} onClick={() => void run("local", () => api.localScore(offer.id), "Estimation locale enregistrée.")}>
              Estimation locale
            </Button>
          </div>
          <p className="text-3 small">L'estimation locale compte seulement des mots-clés de vos CV dans l'offre. Elle ne remplace pas une analyse.</p>
        </div>
      )}

      {offer.analysisMd && (
        <div className="imported-analysis">
          <button type="button" className="link" onClick={() => setShowImported((v) => !v)} aria-expanded={showImported}>
            {showImported ? "Masquer" : "Afficher"} l'analyse d'origine (OFFRE.md)
          </button>
          {showImported && <Markdown text={offer.analysisMd} />}
        </div>
      )}
    </div>
  );
}

function FactList({ title, tone, items }: { title: string; tone: "success" | "accent" | "warning"; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="fact-list">
      <Badge tone={tone}>{title}</Badge>
      <ul>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}
