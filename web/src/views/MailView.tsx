import { STATUS_LABELS, type MailItem, type MailReview, type Status } from "@shared/types";
import { CheckCheck, CircleAlert, Inbox, KeyRound, Link2, LogOut, Mail, Pencil, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import { ConfirmationCard, Section, StatusBadge, ViewHeader, useAction } from "../components/bits";
import { Badge, Button, ErrorState, Field, Spinner, confirmAction } from "../components/ui";
import { api } from "../lib/api";
import { MAIL_LABELS, fmtDate, fmtDateTime, relative } from "../lib/format";
import { errorMessage, useApplications, useDashboard, useGmail, useMailReviews, useMails, useSettings } from "../lib/queries";
import { useUi } from "../lib/store";

export function MailView() {
  const gmail = useGmail();
  const g = gmail.data;
  return (
    <>
      <ViewHeader title="Gmail" sub={g?.email ? `${g.email}, lecture seule` : "Non connecté"} />
      <div className="view-body">
        <div className="view-inner">
          {gmail.isLoading && <Spinner label="Chargement" />}
          {gmail.error && <ErrorState message={errorMessage(gmail.error)} onRetry={() => void gmail.refetch()} />}
          {g && (g.email ? <Connected /> : <Connect />)}
        </div>
      </div>
    </>
  );
}

function Connect() {
  const { busy, run } = useAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const clean = password.replace(/\s+/g, "");
  return (
    <div className="settings-card">
      <div className="settings-card-title">Connecter Gmail en lecture seule</div>
      <p className="settings-card-hint">
        ORBIT cherche les e-mails liés à vos candidatures : accusés de réception, tests, entretiens, refus et offres. Il n'envoie rien, ne supprime rien, ne déplace rien et ne change pas l'état lu ou
        non lu de vos messages. Chaque changement de statut qu'il en déduit attend votre confirmation.
      </p>
      <ol className="settings-steps">
        <li>Activez la validation en deux étapes sur ce compte Google, si ce n'est pas déjà fait.</li>
        <li>
          Ouvrez{" "}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer noopener">
            myaccount.google.com/apppasswords
          </a>
          , connectez-vous vous-même, et créez un mot de passe d'application nommé ORBIT.
        </li>
        <li>Collez ici les 16 lettres affichées par Google.</li>
      </ol>
      <div className="settings-card-body">
        <div className="field-row">
          <Field label="Adresse Gmail" htmlFor="gm-email">
            <input id="gm-email" className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Mot de passe d'application" htmlFor="gm-pass" hint="Chiffré avec la protection Windows de votre session, jamais écrit en clair ni dans les journaux.">
            <input id="gm-pass" className="input" type="password" autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} data-autofocus />
          </Field>
        </div>
        <div>
          <Button
            variant="primary"
            icon={<KeyRound />}
            disabled={!email.includes("@") || clean.length !== 16}
            loading={busy === "connect"}
            onClick={async () => {
              if (await run("connect", () => api.gmailConnect(email.trim(), clean), "Gmail connecté en lecture seule.")) setPassword("");
            }}
          >
            Vérifier et connecter
          </Button>
        </div>
      </div>
    </div>
  );
}

function Connected() {
  const gmail = useGmail();
  const settings = useSettings();
  const dash = useDashboard();
  const reviews = useMailReviews();
  const ui = useUi();
  const { busy, run } = useAction();
  const unassigned = useMails({ unassigned: true });
  const g = gmail.data!;
  const confirmations = (dash.data?.confirmations ?? []).filter((c) => c.evidence.kind === "email");
  const proposed = reviews.data ?? [];
  const waiting = proposed.length + confirmations.length;

  const acceptAll = async () => {
    const { ok } = await confirmAction({
      title: `Tout accepter (${waiting}) ?`,
      body: "Chaque e-mail est rattaché à sa candidature et gardé comme preuve. Les nouvelles offres et candidatures sont créées, les statuts sont mis à jour. Un statut qui ferait reculer une candidature (un vieux mail lu tard) reste à décider ici.",
      confirmLabel: "Tout accepter",
    });
    if (!ok) return;
    await run(
      "all",
      () => api.acceptAllMail(),
      (r) =>
        [
          `${r.accepted + r.confirmed} appliqué${r.accepted + r.confirmed > 1 ? "s" : ""}`,
          r.left ? `${r.left} laissé${r.left > 1 ? "s" : ""} à décider` : "",
          r.errors.length ? `${r.errors.length} en erreur : ${r.errors.slice(0, 2).join(" · ")}` : "",
        ]
          .filter(Boolean)
          .join(", ") + ".",
    );
  };

  const disconnect = async () => {
    const { ok } = await confirmAction({
      title: "Déconnecter Gmail ?",
      body: "Le mot de passe chiffré est effacé de cet ordinateur. Pour couper l'accès complètement, supprimez aussi le mot de passe d'application ORBIT sur myaccount.google.com/apppasswords. Les e-mails déjà rattachés restent dans le suivi.",
      confirmLabel: "Déconnecter",
      danger: true,
    });
    if (ok) await run("disconnect", () => api.gmailDisconnect(), "Gmail déconnecté.");
  };

  return (
    <>
      <div className="settings-card gmail-card">
        <div className="gmail-head">
          <ShieldCheck className="gmail-icon" />
          <div className="grow">
            <div className="settings-card-title">{g.email}</div>
            <p className="settings-card-hint">
              Lecture seule · mot de passe protégé par {g.protectedBy === "dpapi" ? "Windows (DPAPI)" : "aucune protection (mode test)"} ·{" "}
              {g.lastSyncAt ? `dernière lecture ${relative(g.lastSyncAt)} (${fmtDateTime(g.lastSyncAt)})` : "jamais lu"} · recherche sur {settings.data?.mailLookbackDays ?? 120} jours
            </p>
          </div>
          <Button
            variant="primary"
            icon={<RefreshCw />}
            loading={busy === "sync"}
            onClick={() =>
              void run(
                "sync",
                () => api.gmailSync(),
                (r) =>
                  `${r.newMails} nouvel${r.newMails > 1 ? "s" : ""} e-mail${r.newMails > 1 ? "s" : ""}, ${r.matched} rattaché${r.matched > 1 ? "s" : ""}, ${r.proposals} statut${r.proposals > 1 ? "s" : ""} à confirmer. Alertes : ${r.alertOffers} nouvelle${r.alertOffers > 1 ? "s" : ""} offre${r.alertOffers > 1 ? "s" : ""}, ${r.alertSkipped} hors de votre recherche.`,
              )
            }
          >
            Lire maintenant
          </Button>
          <Button icon={<Sparkles />} onClick={() => ui.startTask("mail_review")}>
            Trier avec l'assistant
          </Button>
          <Button variant="ghost" icon={<LogOut />} loading={busy === "disconnect"} onClick={() => void disconnect()}>
            Déconnecter
          </Button>
        </div>
      </div>

      <Section
        title="À valider"
        hint="Ce que l'assistant et ORBIT ont lu dans vos e-mails. Rien ne change sans votre accord : modifiez une proposition, écartez-la, ou acceptez tout. « Trier avec l'assistant » lit les e-mails que ORBIT n'a pas su placer."
        actions={
          waiting > 1 && (
            <Button variant="primary" icon={<CheckCheck />} loading={busy === "all"} onClick={() => void acceptAll()}>
              Tout accepter ({waiting})
            </Button>
          )
        }
      >
        {waiting === 0 ? (
          <p className="text-3">Rien à valider. Lisez vos e-mails, puis laissez l'assistant trier ceux que ORBIT n'a pas su placer.</p>
        ) : (
          <div className="card-stack">
            {proposed.map((r) => (
              <ReviewCard key={r.id} review={r} />
            ))}
            {confirmations.map((c) => (
              <ConfirmationCard key={c.evidence.id} item={c} />
            ))}
          </div>
        )}
      </Section>

      <Section title="E-mails à rattacher" hint="Liés au recrutement, mais ORBIT n'a pas su dire à quelle candidature.">
        {unassigned.data && unassigned.data.length === 0 && <p className="text-3">Aucun.</p>}
        <ul className="mail-rows">
          {(unassigned.data ?? []).map((m) => (
            <MailRow key={m.id} mail={m} attach />
          ))}
        </ul>
      </Section>
    </>
  );
}

/** What the assistant read in one email: applied only when the user accepts it, as it is or edited. */
function ReviewCard({ review: r }: { review: MailReview }) {
  const apps = useApplications();
  const ui = useUi();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [target, setTarget] = useState(r.applicationId ?? "new");
  const [company, setCompany] = useState(r.company ?? "");
  const [title, setTitle] = useState(r.title ?? "");
  const [status, setStatus] = useState<Status | "">(r.status ?? "");
  const [dueAt, setDueAt] = useState(r.dueAt?.slice(0, 10) ?? "");
  const save = async () => {
    const saved = await run(
      "save",
      () =>
        api.updateMailReview(r.id, {
          applicationId: target === "new" ? null : target,
          company: target === "new" ? company.trim() || null : null,
          title: target === "new" ? title.trim() || null : null,
          status: status || null,
          dueAt: dueAt || null,
        }),
      "Proposition modifiée.",
    );
    if (saved) setEditing(false);
  };
  return (
    <div className="confirm-card">
      <div className="confirm-icon">
        <Sparkles />
      </div>
      <div className="confirm-main">
        {r.application ? (
          <button type="button" className="confirm-app" onClick={() => ui.go("applications", r.application!.id)}>
            <strong>{r.application.company}</strong> · {r.application.title}
          </button>
        ) : (
          <span className="confirm-app">
            <Badge tone="accent">{r.status ? "Nouvelle candidature" : "Nouvelle offre"}</Badge> <strong>{r.company}</strong> · {r.title}
          </span>
        )}
        <div className="confirm-source">
          <span className="confirm-subject">{r.mail.subject || "(sans objet)"}</span>
          <span className="text-3">
            {r.mail.from} · {fmtDateTime(r.mail.date)}
          </span>
        </div>
        {r.note && <p className="confirm-excerpt">{r.note}</p>}
        <div className="confirm-suggest">
          {r.application && (
            <>
              <span className="text-3">Statut actuel</span> <StatusBadge status={r.application.status} />
            </>
          )}
          {r.status ? (
            <>
              <span className="text-3">{r.application ? "→ proposé" : "Statut proposé"}</span> <StatusBadge status={r.status} />
            </>
          ) : (
            <span className="text-3">{r.application ? "Rattacher l'e-mail, sans changer le statut" : "Offre seulement, sans candidature"}</span>
          )}
          {r.dueAt && (
            <Badge tone="warning">
              <CircleAlert /> date lue : {fmtDate(r.dueAt)}
            </Badge>
          )}
          {r.back && <Badge tone="danger">ferait reculer la candidature</Badge>}
        </div>
        {editing && (
          <div className="review-edit">
            <div className="field-row">
              <Field label="Candidature" htmlFor={`rv-app-${r.id}`}>
                <select id={`rv-app-${r.id}`} className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="new">Nouvelle offre...</option>
                  {(apps.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.offer.company} · {a.offer.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Statut" htmlFor={`rv-status-${r.id}`}>
                <select id={`rv-status-${r.id}`} className="select" value={status} onChange={(e) => setStatus(e.target.value as Status | "")}>
                  <option value="">{target === "new" ? "Aucun (offre seulement)" : "Aucun changement"}</option>
                  {(Object.keys(STATUS_LABELS) as Status[])
                    .filter((s) => s !== "prepared" && s !== "validated")
                    .map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Date (test, entretien)" htmlFor={`rv-due-${r.id}`}>
                <input id={`rv-due-${r.id}`} className="input" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </Field>
            </div>
            {target === "new" && (
              <div className="field-row">
                <Field label="Entreprise" htmlFor={`rv-co-${r.id}`}>
                  <input id={`rv-co-${r.id}`} className="input" value={company} onChange={(e) => setCompany(e.target.value)} />
                </Field>
                <Field label="Poste" htmlFor={`rv-ti-${r.id}`}>
                  <input id={`rv-ti-${r.id}`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
              </div>
            )}
            <div className="row-gap">
              <Button size="sm" variant="primary" loading={busy === "save"} disabled={target === "new" && (!company.trim() || !title.trim())} onClick={() => void save()}>
                Enregistrer
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="confirm-actions">
        <Button size="sm" variant="primary" loading={busy === "accept"} disabled={editing} onClick={() => void run("accept", () => api.acceptMailReview(r.id), "Proposition appliquée.")}>
          Accepter
        </Button>
        <Button size="sm" icon={<Pencil />} disabled={editing} onClick={() => setEditing(true)}>
          Modifier
        </Button>
        <Button size="sm" variant="ghost" loading={busy === "dismiss"} onClick={() => void run("dismiss", () => api.dismissMailReview(r.id), "Proposition écartée.")}>
          Écarter
        </Button>
      </div>
    </div>
  );
}

function MailRow({ mail: m, attach }: { mail: MailItem; attach?: boolean }) {
  const apps = useApplications();
  const { busy, run } = useAction();
  const [target, setTarget] = useState("");
  const linked = m.applicationId ? apps.data?.find((a) => a.id === m.applicationId) : null;
  return (
    <li className="mail-item">
      <Mail />
      <span className="mail-item-main">
        <span className="truncate">
          <strong>{m.subject || "(sans objet)"}</strong>
        </span>
        <span className="text-3 truncate">
          {m.from} · {fmtDateTime(m.date)}
          {linked && ` · ${linked.offer.company}`}
        </span>
        {m.snippet && <span className="mail-snippet">{m.snippet}</span>}
        {attach && (
          <span className="row-gap mail-attach-row">
            <select className="select select-sm grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Candidature à rattacher">
              <option value="">Rattacher à...</option>
              {(apps.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.offer.company} · {a.offer.title}
                </option>
              ))}
            </select>
            <Button size="sm" icon={<Link2 />} disabled={!target} loading={busy === "attach"} onClick={() => void run("attach", () => api.attachMail(m.id, target), "E-mail rattaché.")}>
              Rattacher
            </Button>
          </span>
        )}
      </span>
      <Badge tone={m.category === "refusal" ? "danger" : m.category === "other" ? "outline" : "accent"}>{MAIL_LABELS[m.category]}</Badge>
      {m.link && (
        <a className="icon-btn icon-btn-sm" href={m.link} target="_blank" rel="noreferrer noopener" aria-label="Ouvrir dans Gmail" data-tip="Ouvrir dans Gmail" data-tip-pos="left">
          <Inbox />
        </a>
      )}
    </li>
  );
}
