import type { Offer, OfferStatus } from "@shared/types";
import { ArrowLeft, Briefcase, Copy, ExternalLink, FileText, OctagonAlert, Pencil, Plus, Search, SquareKanban } from "lucide-react";
import { useMemo, useState } from "react";
import { AnalysisPanel, documentsPrompt } from "../components/AnalysisPanel";
import { ScoreChip, Section, StatusPicker, ViewHeader, useAction } from "../components/bits";
import { EditOfferDialog } from "../components/OfferDialogs";
import { Badge, Button, Empty, ErrorState, IconButton, Segmented, Spinner } from "../components/ui";
import { api } from "../lib/api";
import { ACTOR_LABELS, fmtDate, fmtDateTime, relative } from "../lib/format";
import { errorMessage, useHistory, useOffer, useOffers } from "../lib/queries";
import { useUi } from "../lib/store";

export function OffersView() {
  const ui = useUi();
  return ui.id ? <OfferDetail id={ui.id} /> : <OfferList />;
}

type Sort = "score" | "date";

function OfferList() {
  const ui = useUi();
  const [status, setStatus] = useState<OfferStatus | "all">("all");
  const [q, setQ] = useState("");
  const [min, setMin] = useState("");
  const [sort, setSort] = useState<Sort>("score");
  const offers = useOffers({ status, q: q.trim() || undefined, minScore: min ? Number(min) : undefined });
  const rows = useMemo(() => {
    const list = [...(offers.data ?? [])];
    return sort === "score"
      ? list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.discoveredAt.localeCompare(a.discoveredAt))
      : list.sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt));
  }, [offers.data, sort]);

  return (
    <>
      <ViewHeader
        title="Offres"
        sub={offers.data ? `${offers.data.length} offre${offers.data.length > 1 ? "s" : ""}` : undefined}
        actions={
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => ui.set({ importOpen: true })}>
            Ajouter
          </Button>
        }
      />
      <div className="view-body">
        <div className="view-inner">
          <div className="toolbar">
            <div className="search-box">
              <Search />
              <input className="input input-bare" placeholder="Entreprise, poste, lieu..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une offre" />
            </div>
            <Segmented<OfferStatus | "all">
              label="Filtrer par état"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "Toutes" },
                { value: "new", label: "Nouvelles" },
                { value: "kept", label: "Retenues" },
                { value: "ignored", label: "Ignorées" },
              ]}
            />
            <select className="select select-sm" value={min} onChange={(e) => setMin(e.target.value)} aria-label="Score minimum">
              <option value="">Tous les scores</option>
              <option value="50">50 et plus</option>
              <option value="70">70 et plus</option>
              <option value="80">80 et plus</option>
            </select>
            <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Trier">
              <option value="score">Trier par score</option>
              <option value="date">Trier par date</option>
            </select>
          </div>

          {offers.isLoading && <Spinner label="Chargement" />}
          {offers.error && <ErrorState message={errorMessage(offers.error)} onRetry={() => void offers.refetch()} />}
          {offers.data && rows.length === 0 && (
            <Empty
              icon={<Briefcase />}
              title={q || min || status !== "all" ? "Aucune offre ne correspond" : "Aucune offre pour l'instant"}
              body="Ajoutez une offre par son lien, en collant son texte, ou à la main."
            >
              <Button variant="primary" icon={<Plus />} onClick={() => ui.set({ importOpen: true })}>
                Ajouter une offre
              </Button>
            </Empty>
          )}
          {rows.length > 0 && (
            <ul className="row-list">
              {rows.map((o) => (
                <li key={o.id}>
                  <OfferRow offer={o} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function OfferRow({ offer: o }: { offer: Offer }) {
  const ui = useUi();
  const blocking = o.analysis?.practical.some((p) => p.severity === "blocking");
  return (
    <div className={`list-row list-row-split ${o.status === "ignored" ? "is-muted" : ""}`}>
      <button type="button" className="list-open" onClick={() => ui.go("offers", o.id)}>
        <ScoreChip score={o.score} by={o.analysis?.by} />
        <span className="list-main">
          <span className="list-title truncate">
            <strong>{o.company}</strong> · {o.title}
          </span>
          <span className="list-meta truncate">{[o.location, o.contract, o.duration, o.source].filter(Boolean).join(" · ")}</span>
        </span>
      </button>
      <span className="list-badges">
        {blocking && (
          <Badge tone="danger">
            <OctagonAlert /> Bloquant
          </Badge>
        )}
        {o.similarTo && (
          <Badge tone="warning">
            <Copy /> Doublon probable
          </Badge>
        )}
        {o.applicationId && o.applicationStatus && <StatusPicker app={{ id: o.applicationId, status: o.applicationStatus }} />}
        {o.status === "new" && !o.applicationId && <Badge tone="outline">Nouvelle</Badge>}
        {o.status === "kept" && !o.applicationId && <Badge>Retenue</Badge>}
      </span>
      <span className="list-date text-3">{relative(o.discoveredAt)}</span>
    </div>
  );
}

function OfferDetail({ id }: { id: string }) {
  const ui = useUi();
  const offer = useOffer(id);
  const history = useHistory({ offerId: id, limit: 50 });
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [fullText, setFullText] = useState(false);
  const o = offer.data;

  const startApplication = async () => {
    const app = await run("app", () => api.startApplication(id), "Candidature créée, au statut Préparée.");
    if (app) ui.go("applications", app.id);
  };

  return (
    <>
      <ViewHeader
        leading={
          <IconButton label="Retour aux offres" onClick={() => ui.go("offers")}>
            <ArrowLeft />
          </IconButton>
        }
        title={o ? o.company : "Offre"}
        sub={o?.title}
        actions={
          o && (
            <>
              <IconButton label="Modifier la fiche" onClick={() => setEditing(true)}>
                <Pencil />
              </IconButton>
              {o.status !== "ignored" ? (
                <Button size="sm" variant="ghost" loading={busy === "ignore"} onClick={() => void run("ignore", () => api.offerStatus(id, "ignored"), "Offre ignorée.")}>
                  Ignorer
                </Button>
              ) : (
                <Button size="sm" variant="ghost" loading={busy === "new"} onClick={() => void run("new", () => api.offerStatus(id, "new"), "Offre remise en nouvelle.")}>
                  Ne plus ignorer
                </Button>
              )}
              {o.status === "new" && (
                <Button size="sm" loading={busy === "keep"} onClick={() => void run("keep", () => api.offerStatus(id, "kept"), "Offre retenue.")}>
                  Retenir
                </Button>
              )}
              <Button size="sm" icon={<FileText />} onClick={() => ui.ask(documentsPrompt(o, o.applicationId))}>
                CV et lettre
              </Button>
              {o.applicationId ? (
                <Button size="sm" variant="primary" icon={<SquareKanban />} onClick={() => ui.go("applications", o.applicationId)}>
                  Voir la candidature
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={<Plus />} loading={busy === "app"} onClick={() => void startApplication()}>
                  Créer la candidature
                </Button>
              )}
            </>
          )
        }
      />
      <div className="view-body">
        <div className="view-inner">
          {offer.isLoading && <Spinner label="Chargement" />}
          {offer.error && <ErrorState message={errorMessage(offer.error)} onRetry={() => void offer.refetch()} />}
          {o && (
            <>
              {o.similarTo && (
                <div className="callout callout-warning banner">
                  <Copy />
                  <span>
                    Cette offre ressemble à{" "}
                    <button type="button" className="link" onClick={() => ui.go("offers", o.similarTo!.id)}>
                      {o.similarTo.company} · {o.similarTo.title}
                    </button>
                    . Est-ce la même ?
                  </span>
                  <span className="row-gap">
                    <Button
                      size="sm"
                      loading={busy === "merge"}
                      onClick={() => void run("merge", () => api.resolveSimilar(id, "merge"), "Offres fusionnées : les sources sont gardées.").then((r) => r && ui.go("offers", r.offer.id))}
                    >
                      Oui, fusionner
                    </Button>
                    <Button size="sm" variant="ghost" loading={busy === "distinct"} onClick={() => void run("distinct", () => api.resolveSimilar(id, "distinct"), "Gardées séparées.")}>
                      Non, deux offres
                    </Button>
                  </span>
                </div>
              )}

              <div className="detail-grid">
                <div className="detail-main">
                  <Section title="Analyse" hint="Le score juge l'adéquation de votre profil. Les points pratiques (date, lieu, éligibilité) sont listés à part.">
                    <AnalysisPanel offer={o} />
                  </Section>
                  <Section
                    title="Description"
                    actions={
                      o.description.length > 1500 && (
                        <Button size="sm" variant="ghost" onClick={() => setFullText((v) => !v)}>
                          {fullText ? "Réduire" : "Tout afficher"}
                        </Button>
                      )
                    }
                  >
                    {o.description.trim() ? <div className={`offer-text ${fullText ? "" : "is-clamped"}`}>{o.description}</div> : <p className="text-3">Pas de description enregistrée.</p>}
                  </Section>
                </div>

                <aside className="detail-side">
                  <div className="side-card">
                    <h3 className="side-title">Fiche</h3>
                    <dl className="kv kv-tight">
                      <dt>Lieu</dt>
                      <dd>{o.location ?? <Missing />}</dd>
                      <dt>Contrat</dt>
                      <dd>{o.contract ?? <Missing />}</dd>
                      <dt>Durée</dt>
                      <dd>{o.duration ?? <Missing />}</dd>
                      <dt>Début</dt>
                      <dd>{o.startDate ?? <Missing />}</dd>
                      <dt>Référence</dt>
                      <dd>{o.reference ?? <Missing />}</dd>
                      <dt>Langue</dt>
                      <dd>{o.language ?? <Missing />}</dd>
                      <dt>Lien</dt>
                      <dd>
                        {o.url ? (
                          <a className="ext-link" href={o.url} target="_blank" rel="noreferrer noopener">
                            <ExternalLink /> <span className="truncate">{new URL(o.url, "https://x").hostname.replace(/^www\./, "")}</span>
                          </a>
                        ) : (
                          <Missing />
                        )}
                      </dd>
                      <dt>Trouvée le</dt>
                      <dd>{fmtDate(o.discoveredAt)}</dd>
                    </dl>
                    {o.missing.length > 0 && <p className="side-note">À compléter : {o.missing.join(", ")}.</p>}
                  </div>

                  <div className="side-card">
                    <h3 className="side-title">Sources ({o.sources.length})</h3>
                    <ul className="source-list">
                      {o.sources.map((s) => (
                        <li key={s.id}>
                          <span>{s.source}</span>
                          <span className="text-3">{fmtDate(s.seenAt)}</span>
                          {s.url && (
                            <a className="ext-link" href={s.url} target="_blank" rel="noreferrer noopener" aria-label="Ouvrir la source">
                              <ExternalLink />
                            </a>
                          )}
                          {s.note && <span className="text-3 source-note">{s.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="side-card">
                    <h3 className="side-title">Historique</h3>
                    <ul className="mini-history">
                      {(history.data ?? []).map((e) => (
                        <li key={e.id}>
                          <span className="text-3">
                            {fmtDateTime(e.at)} · {ACTOR_LABELS[e.actor]}
                          </span>
                          <span>{e.summary}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>
              </div>
              <EditOfferDialog offer={o} open={editing} onClose={() => setEditing(false)} />
            </>
          )}
        </div>
      </div>
    </>
  );
}

const Missing = () => <span className="text-3">non précisé</span>;
