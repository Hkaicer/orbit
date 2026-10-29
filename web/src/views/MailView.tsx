import type { MailItem } from "@shared/types";
import { Inbox, KeyRound, Link2, LogOut, Mail, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { ConfirmationCard, Section, ViewHeader, useAction } from "../components/bits";
import { Badge, Button, Empty, ErrorState, Field, Spinner, confirmAction } from "../components/ui";
import { api } from "../lib/api";
import { MAIL_LABELS, fmtDateTime, relative } from "../lib/format";
import { errorMessage, useApplications, useDashboard, useGmail, useMails, useSettings } from "../lib/queries";

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
        ORBIT cherche les e-mails liés à vos candidatures : accusés de réception, tests, entretiens, refus et offres. Il n'envoie rien, ne supprime rien, ne déplace rien et ne change pas l'état lu
        ou non lu de vos messages. Chaque changement de statut qu'il en déduit attend votre confirmation.
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
  const { busy, run } = useAction();
  const [q, setQ] = useState("");
  const unassigned = useMails({ unassigned: true });
  const all = useMails({ q: q.trim() || undefined });
  const g = gmail.data!;
  const confirmations = (dash.data?.confirmations ?? []).filter((c) => c.evidence.kind === "email");

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
          <Button variant="ghost" icon={<LogOut />} loading={busy === "disconnect"} onClick={() => void disconnect()}>
            Déconnecter
          </Button>
        </div>
      </div>

      <Section title="Statuts à confirmer" hint="Déduits des e-mails. Rien ne change sans votre accord, et un e-mail n'est qu'un indice : un test mentionné n'est pas un test fait.">
        {confirmations.length === 0 ? (
          <p className="text-3">Rien à confirmer.</p>
        ) : (
          <div className="card-stack">
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

      <Section
        title="Tous les e-mails lus"
        actions={
          <div className="search-box search-sm">
            <Search />
            <input className="input input-bare" placeholder="Objet, expéditeur..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher un e-mail" />
          </div>
        }
      >
        {all.isLoading && <Spinner label="Chargement" />}
        {all.data && all.data.length === 0 && <Empty small icon={<Inbox />} title="Aucun e-mail" body="Lancez une lecture pour chercher les e-mails de recrutement." />}
        <ul className="mail-rows">
          {(all.data ?? []).map((m) => (
            <MailRow key={m.id} mail={m} />
          ))}
        </ul>
      </Section>
    </>
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
