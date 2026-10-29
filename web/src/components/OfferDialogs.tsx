import type { Offer } from "@shared/types";
import { ClipboardPaste, Link2, PenLine, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type FromUrlResult, type OfferInput } from "../lib/api";
import { useUi } from "../lib/store";
import { useAction } from "./bits";
import { Button, Dialog, Field, Segmented } from "./ui";

type Tab = "url" | "text" | "form";

const EMPTY: OfferInput = { company: "", title: "" };

/** Add an offer from its link, from copied text, or by hand. */
export function ImportOfferDialog() {
  const ui = useUi();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [form, setForm] = useState<OfferInput>(EMPTY);
  const [result, setResult] = useState<FromUrlResult | null>(null);

  useEffect(() => {
    if (ui.importOpen) {
      setTab("url");
      setUrl("");
      setText("");
      setForm(EMPTY);
      setResult(null);
    }
  }, [ui.importOpen]);

  const close = () => ui.set({ importOpen: false });
  const opened = (offer: Offer) => {
    close();
    ui.go("offers", offer.id);
  };

  const fromUrl = async () => {
    const r = await run(
      "url",
      () => api.fromUrl(url.trim()),
      (x) => (x.status === "created" ? "Offre ajoutée." : x.status === "known" ? `Offre déjà connue : source ajoutée${x.changes.length ? `, changements : ${x.changes.join(", ")}` : ""}.` : ""),
    );
    if (!r) return;
    setResult(r);
    if (r.status === "created" || r.status === "known") {
      opened(r.offer);
    } else if (r.status === "needs_text") {
      setTab("text");
    }
  };

  const askClaude = (body: string, link?: string) => {
    ui.ask(`Voici le texte d'une offre${link ? ` (lien : ${link})` : ""}. Crée la fiche sans inventer les champs absents, puis analyse-la avec ma grille.\n\n${body.trim()}`);
    close();
  };

  const createByHand = async (input: OfferInput, source: string) => {
    const r = await run(
      "create",
      () => api.createOffer({ ...input, source }),
      (x) => (x.created ? "Offre ajoutée." : "Offre déjà connue : la nouvelle source est ajoutée."),
    );
    if (r) opened(r.offer);
  };

  return (
    <Dialog open={ui.importOpen} onClose={close} title="Ajouter une offre" size="lg" labelledBy="import-title">
      <div className="dialog-body">
        <Segmented<Tab>
          label="Façon d'ajouter l'offre"
          value={tab}
          onChange={setTab}
          options={[
            { value: "url", label: "Lien", icon: <Link2 /> },
            { value: "text", label: "Texte copié", icon: <ClipboardPaste /> },
            { value: "form", label: "Formulaire", icon: <PenLine /> },
          ]}
        />

        {tab === "url" && (
          <>
            <Field
              label="Lien de l'offre"
              htmlFor="offer-url"
              hint="ORBIT lit la page une fois, sans connexion à un compte. LinkedIn, Indeed et les sites qui bloquent la lecture demandent de coller le texte."
            >
              <input
                id="offer-url"
                className="input"
                type="url"
                placeholder="https://..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && url.trim() && void fromUrl()}
                data-autofocus
              />
            </Field>
            {result && result.status === "not_found" && <div className="callout callout-danger">{result.message}</div>}
            {result && result.status === "needs_ai" && (
              <div className="callout callout-accent">
                <p>{result.message}</p>
                <div className="row-gap">
                  <Button size="sm" variant="primary" icon={<Sparkles />} onClick={() => askClaude(result.text, result.url)}>
                    Préparer la demande à Claude
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      setForm({ ...EMPTY, url: result.url, title: result.title ?? "", description: result.text });
                      setTab("form");
                    }}
                  >
                    Remplir moi-même
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {tab === "text" && (
          <>
            {result && result.status === "needs_text" && <div className="callout callout-warning">{result.message}</div>}
            <Field label="Texte de l'offre" htmlFor="offer-text" hint="Copiez la description depuis la page de l'offre.">
              <textarea id="offer-text" className="textarea" rows={10} value={text} onChange={(e) => setText(e.target.value)} data-autofocus />
            </Field>
            <div className="field-row">
              <Field label="Lien (facultatif)" htmlFor="text-url">
                <input id="text-url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} />
              </Field>
            </div>
            <div className="field-row">
              <Field label="Entreprise" htmlFor="text-company" hint="Nécessaire seulement pour créer sans Claude.">
                <input id="text-company" className="input" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </Field>
              <Field label="Poste" htmlFor="text-title">
                <input id="text-title" className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
            </div>
          </>
        )}

        {tab === "form" && <OfferFields value={form} onChange={setForm} />}
      </div>
      <div className="dialog-footer">
        <span className="dialog-note text-3">{tab === "text" ? "Rien n'est envoyé à Claude tant que vous n'avez pas validé la demande." : ""}</span>
        <Button variant="ghost" onClick={close}>
          Annuler
        </Button>
        {tab === "url" && (
          <Button variant="primary" loading={busy === "url"} disabled={!/^https?:\/\/\S+\.\S+/.test(url.trim())} onClick={() => void fromUrl()}>
            Importer
          </Button>
        )}
        {tab === "text" && (
          <>
            <Button
              loading={busy === "create"}
              disabled={!text.trim() || !form.company.trim() || !form.title.trim()}
              onClick={() => void createByHand({ ...form, url: url.trim() || null, description: text }, "texte collé")}
            >
              Créer sans Claude
            </Button>
            <Button variant="primary" icon={<Sparkles />} disabled={text.trim().length < 40} onClick={() => askClaude(text, url.trim() || undefined)}>
              Préparer pour Claude
            </Button>
          </>
        )}
        {tab === "form" && (
          <Button variant="primary" loading={busy === "create"} disabled={!form.company.trim() || !form.title.trim()} onClick={() => void createByHand(form, "manuel")}>
            Créer la fiche
          </Button>
        )}
      </div>
    </Dialog>
  );
}

export function OfferFields({ value, onChange }: { value: OfferInput; onChange: (v: OfferInput) => void }) {
  const set = (k: keyof OfferInput) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const v = (k: keyof OfferInput) => (value[k] as string | null | undefined) ?? "";
  return (
    <>
      <div className="field-row">
        <Field label="Entreprise *" htmlFor="f-company">
          <input id="f-company" className="input" value={v("company")} onChange={set("company")} data-autofocus />
        </Field>
        <Field label="Poste *" htmlFor="f-title">
          <input id="f-title" className="input" value={v("title")} onChange={set("title")} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Lieu" htmlFor="f-location">
          <input id="f-location" className="input" value={v("location")} onChange={set("location")} />
        </Field>
        <Field label="Contrat" htmlFor="f-contract">
          <input id="f-contract" className="input" placeholder="Stage, CDI..." value={v("contract")} onChange={set("contract")} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Durée" htmlFor="f-duration">
          <input id="f-duration" className="input" value={v("duration")} onChange={set("duration")} />
        </Field>
        <Field label="Date de début" htmlFor="f-start">
          <input id="f-start" className="input" value={v("startDate")} onChange={set("startDate")} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Référence" htmlFor="f-ref">
          <input id="f-ref" className="input" value={v("reference")} onChange={set("reference")} />
        </Field>
        <Field label="Langue" htmlFor="f-lang">
          <input id="f-lang" className="input" placeholder="fr, en" value={v("language")} onChange={set("language")} />
        </Field>
      </div>
      <Field label="Lien" htmlFor="f-url">
        <input id="f-url" className="input" value={v("url")} onChange={set("url")} />
      </Field>
      <Field label="Description" htmlFor="f-desc">
        <textarea id="f-desc" className="textarea" rows={8} value={v("description")} onChange={set("description")} />
      </Field>
    </>
  );
}

export function EditOfferDialog({ offer, open, onClose }: { offer: Offer; open: boolean; onClose: () => void }) {
  const { busy, run } = useAction();
  const [form, setForm] = useState<OfferInput>(EMPTY);
  useEffect(() => {
    if (open)
      setForm({
        company: offer.company,
        title: offer.title,
        location: offer.location,
        contract: offer.contract,
        duration: offer.duration,
        startDate: offer.startDate,
        reference: offer.reference,
        url: offer.url,
        language: offer.language,
        description: offer.description,
      });
  }, [open, offer]);
  const save = async () => {
    const clean = Object.fromEntries(Object.entries(form).map(([k, x]) => [k, typeof x === "string" && x.trim() === "" && k !== "description" ? null : x])) as OfferInput;
    if (await run("save", () => api.updateOffer(offer.id, clean), "Fiche mise à jour.")) onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Modifier la fiche" size="lg" labelledBy="edit-offer-title">
      <div className="dialog-body">
        <OfferFields value={form} onChange={setForm} />
      </div>
      <div className="dialog-footer">
        <Button variant="ghost" onClick={onClose}>
          Annuler
        </Button>
        <Button variant="primary" loading={busy === "save"} disabled={!form.company.trim() || !form.title.trim()} onClick={() => void save()}>
          Enregistrer
        </Button>
      </div>
    </Dialog>
  );
}
