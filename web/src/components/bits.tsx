// Small pieces shared by the pages.

import { PROOF_STATUSES, STATUSES, STATUS_LABELS, type Confirmation, type PendingAction, type Status } from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, CircleAlert, ExternalLink, FolderOpen, Mail, Menu as MenuIcon, PanelRight, ShieldCheck, Sparkles } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { dueLabel, fmtDate, fmtDateTime } from "../lib/format";
import { errorMessage, refreshAll } from "../lib/queries";
import { useUi } from "../lib/store";
import { toast } from "../lib/toast";
import { Badge, Button, IconButton, Menu, confirmAction } from "./ui";

export function ViewHeader({ title, sub, actions, leading }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; leading?: ReactNode }) {
  const ui = useUi();
  return (
    <header className="view-header">
      <IconButton label="Menu" className="menu-toggle" onClick={() => ui.set({ sidebarOpen: true })}>
        <MenuIcon />
      </IconButton>
      {leading}
      <div className="view-heading">
        <h1 className="view-title">{title}</h1>
        {sub && <span className="view-sub">{sub}</span>}
      </div>
      <div className="view-actions">
        {actions}
        {!ui.assistantOpen && (
          <IconButton label="Assistant" onClick={() => ui.set({ assistantOpen: true })} tipPos="left">
            <PanelRight />
          </IconButton>
        )}
      </div>
    </header>
  );
}

/** Run a change, refresh the lists, and report the result in a toast. */
export function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        await refreshAll(qc);
        const message = typeof success === "function" ? success(r) : success;
        if (message) toast.success(message);
        return r;
      } catch (err) {
        toast.error(errorMessage(err));
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [qc],
  );
  return { busy, run };
}

const STATUS_TONE: Partial<Record<Status, "neutral" | "accent" | "success" | "warning" | "danger" | "outline">> = {
  prepared: "outline",
  validated: "neutral",
  sent: "accent",
  received: "accent",
  waiting: "neutral",
  followup: "warning",
  test_todo: "warning",
  test_done: "accent",
  interview_proposed: "warning",
  interview_confirmed: "success",
  offer: "success",
  refused: "danger",
  closed: "neutral",
};

export const StatusBadge = ({ status }: { status: Status }) => (
  <Badge tone={STATUS_TONE[status] ?? "neutral"} dot>
    {STATUS_LABELS[status]}
  </Badge>
);

/** Change an application's status by hand, with the same confirmation everywhere. */
export function useChangeStatus() {
  const { busy, run } = useAction();
  const change = async (app: { id: string; status: Status }, next: Status) => {
    if (next === app.status) return;
    const { ok } = await confirmAction({
      title: `Passer à « ${STATUS_LABELS[next]} » ?`,
      body: PROOF_STATUSES.includes(next)
        ? "Ce statut dit que quelque chose s'est passé à l'extérieur. Sans e-mail qui le prouve, il sera noté comme déclaré par vous."
        : next === "validated"
          ? "Vous validez le dossier. Cela n'envoie rien."
          : undefined,
      confirmLabel: "Changer le statut",
    });
    if (ok) await run(`status-${app.id}`, () => api.setStatus(app.id, next), "Statut mis à jour.");
  };
  return { busy, change };
}

/** The status badge, as a button that opens the thirteen statuses. */
export function StatusPicker({ app }: { app: { id: string; status: Status } }) {
  const { busy, change } = useChangeStatus();
  return (
    <Menu
      label="Changer le statut"
      align="end"
      items={STATUSES.map((s) => ({ label: STATUS_LABELS[s], icon: s === app.status ? <Check /> : <span style={{ width: 15 }} />, onSelect: () => void change(app, s) }))}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          className="status-picker"
          disabled={busy !== null}
          aria-label={`Statut : ${STATUS_LABELS[app.status]}. Changer le statut`}
          data-tip="Changer le statut"
          data-tip-pos="left"
          onClick={(e) => {
            e.stopPropagation();
            p.onClick();
          }}
        >
          <StatusBadge status={app.status} />
          <ChevronDown className="status-picker-caret" />
        </button>
      )}
    />
  );
}

export function ScoreChip({ score, by }: { score: number | null | undefined; by?: string | null }) {
  if (score === null || score === undefined) return <span className="score-chip is-none">–</span>;
  const tone = score >= 75 ? "high" : score >= 55 ? "mid" : score >= 40 ? "low" : "min";
  return (
    <span className={`score-chip is-${tone}`} title={by === "local" ? "Estimation locale par mots-clés, sans Claude" : "Adéquation du profil, sur 100"}>
      {score}
      {by === "local" && <span className="score-est">≈</span>}
    </span>
  );
}

export function DueBadge({ due }: { due: string | null | undefined }) {
  const d = dueLabel(due);
  if (!d) return null;
  return <Badge tone={d.tone === "neutral" ? "outline" : d.tone}>{d.text}</Badge>;
}

/** Shows a file or folder of the user's and opens it in Explorer, never anything else. */
export function PathLink({ path, label, folder }: { path: string | null | undefined; label?: string; folder?: boolean }) {
  if (!path) return <span className="text-3">Aucun</span>;
  const open = async () => {
    try {
      await api.open(path);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <button type="button" className="path-link" onClick={() => void open()} title={`${path}\nOuvrir dans l'Explorateur`}>
      {folder ? <FolderOpen /> : <ExternalLink />}
      <span className="truncate">{label ?? path}</span>
    </button>
  );
}

export function Section({ title, hint, actions, children, id }: { title: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id}>
      <div className="section-head">
        <div>
          <h2 className="section-heading">{title}</h2>
          {hint && <p className="section-hint">{hint}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Something found in an email or proposed by Claude: nothing changes until the user confirms it. */
export function ConfirmationCard({ item, showApplication = true }: { item: Confirmation; showApplication?: boolean }) {
  const { evidence: e, application: a } = item;
  const ui = useUi();
  const { busy, run } = useAction();
  const [other, setOther] = useState<Status | "">("");
  const fromMail = e.kind === "email";
  const confirm = async (status?: Status) => {
    const target = status ?? e.suggests;
    if (!target) return;
    const { ok } = await confirmAction({
      title: `Passer à « ${STATUS_LABELS[target]} » ?`,
      body: fromMail
        ? "Le courriel sera gardé comme preuve dans le suivi de cette candidature."
        : "Claude l'a seulement proposé : en confirmant, vous attestez que c'est vrai. Ce sera noté comme déclaré par vous.",
      confirmLabel: "Confirmer",
    });
    if (ok) await run("confirm", () => api.confirmEvidence(e.id, status), "Statut mis à jour.");
  };
  return (
    <div className="confirm-card">
      <div className="confirm-icon">{fromMail ? <Mail /> : <Sparkles />}</div>
      <div className="confirm-main">
        {showApplication && (
          <button type="button" className="confirm-app" onClick={() => ui.go("applications", a.id)}>
            <strong>{a.offer.company}</strong> · {a.offer.title}
          </button>
        )}
        {fromMail ? (
          <div className="confirm-source">
            <span className="confirm-subject">{e.mailSubject}</span>
            <span className="text-3">
              {e.mailFrom} · {fmtDateTime(e.mailDate)}
            </span>
          </div>
        ) : (
          <div className="confirm-source text-2">Proposé par Claude</div>
        )}
        {e.excerpt && <p className="confirm-excerpt">{e.excerpt}</p>}
        <div className="confirm-suggest">
          <span className="text-3">Statut actuel</span> <StatusBadge status={a.status} />
          {e.suggests && (
            <>
              <span className="text-3">→ suggéré</span> <StatusBadge status={e.suggests} />
            </>
          )}
          {e.dueAt && (
            <Badge tone="warning">
              <CircleAlert /> date lue : {fmtDate(e.dueAt)}
            </Badge>
          )}
        </div>
      </div>
      <div className="confirm-actions">
        {e.suggests && (
          <Button size="sm" variant="primary" loading={busy === "confirm"} onClick={() => void confirm()}>
            Confirmer
          </Button>
        )}
        <select className="select select-sm" value={other} aria-label="Choisir un autre statut" onChange={(ev) => setOther(ev.target.value as Status)} onBlur={() => undefined}>
          <option value="">Autre statut…</option>
          {(Object.keys(STATUS_LABELS) as Status[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        {other && (
          <Button size="sm" onClick={() => void confirm(other).then(() => setOther(""))}>
            Appliquer
          </Button>
        )}
        <Button size="sm" variant="ghost" loading={busy === "dismiss"} onClick={() => void run("dismiss", () => api.dismissEvidence(e.id), "Écarté.")}>
          Ignorer
        </Button>
      </div>
    </div>
  );
}

/** An action outside this computer (sending, submitting a form...): only ever done after the user's yes, one at a time. */
export function PendingActionCard({ action }: { action: PendingAction }) {
  const ui = useUi();
  const { busy, run } = useAction();
  const target = (action.details as { target?: string } | null)?.target;
  return (
    <div className={`action-card is-${action.status}`}>
      <div className="confirm-icon">
        <ShieldCheck />
      </div>
      <div className="confirm-main">
        <div className="action-head">
          <strong>{action.kind}</strong>
          <Badge tone={action.status === "pending" ? "warning" : action.status === "approved" ? "accent" : action.status === "done" ? "success" : "neutral"}>
            {action.status === "pending" ? "À valider" : action.status === "approved" ? "Approuvée, à faire" : action.status === "done" ? "Faite" : "Refusée"}
          </Badge>
          {action.applicationId && (
            <button type="button" className="link" onClick={() => ui.go("applications", action.applicationId)}>
              Voir la candidature
            </button>
          )}
        </div>
        <p className="action-desc">{action.description}</p>
        {target && <span className="text-3">Cible : {target}</span>}
        <span className="text-3">Demandée le {fmtDateTime(action.createdAt)}</span>
      </div>
      <div className="confirm-actions">
        {action.status === "pending" && (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "ok"}
              onClick={async () => {
                const { ok } = await confirmAction({
                  title: "Approuver cette action ?",
                  body: "Cet accord vaut pour cette action seulement. Dans cette version, ORBIT n'envoie rien lui-même : faites l'action, puis marquez-la comme faite.",
                  confirmLabel: "Approuver",
                });
                if (ok) await run("ok", () => api.decideAction(action.id, "approved"), "Action approuvée.");
              }}
            >
              Approuver
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "no"} onClick={() => void run("no", () => api.decideAction(action.id, "rejected"), "Action refusée.")}>
              Refuser
            </Button>
          </>
        )}
        {action.status === "approved" && (
          <>
            <Button size="sm" loading={busy === "done"} onClick={() => void run("done", () => api.decideAction(action.id, "done"), "Marquée comme faite.")}>
              Je l'ai faite
            </Button>
            <Button size="sm" variant="ghost" loading={busy === "no"} onClick={() => void run("no", () => api.decideAction(action.id, "rejected"), "Action annulée.")}>
              Annuler
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
