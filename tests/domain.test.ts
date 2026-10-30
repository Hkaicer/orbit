import { describe, expect, it } from "vitest";
import { Database } from "../server/db/database";
import {
  addDeadline,
  confirmEvidence,
  createApplication,
  decideExternalAction,
  getApplicationDetail,
  proposeStatus,
  requestExternalAction,
  setDeadlineStatus,
  setStatus,
} from "../server/domain/applications";
import { createOffer, dedupKey, normalize, resolveSimilar, titleSimilarity, urlKey } from "../server/domain/offers";

const db = () => {
  const d = new Database(":memory:");
  d.migrate();
  return d;
};

const WAVESTONE = { company: "Wavestone", title: "Stage - Intelligence Artificielle & Cybersécurité H/F", source: "manuel", description: "x".repeat(300) };

describe("offers and duplicates", () => {
  it("normalizes accents, gender marks and tracking parameters", () => {
    expect(normalize("Stage Cybersécurité (H/F) · Consultant·e")).toBe("stage cybersecurite consultant");
    expect(urlKey("https://www.example.com/jobs/123/?utm_source=x&id=4#top")).toBe("example.com/jobs/123?id=4");
    expect(dedupKey("Wavestone SA", "Stage Cybersécurité Cloud F/H")).toBe(dedupKey("wavestone", "Cloud cybersecurite"));
    expect(titleSimilarity("Stage Intelligence Artificielle & Cybersécurité", "Stagiaire Intelligence artificielle et cybersécurité")).toBe(1);
  });

  it("adds a source to a known offer instead of a duplicate, and records changed dates", () => {
    const d = db();
    const first = createOffer(d, { ...WAVESTONE, url: "https://www.welcometothejungle.com/fr/companies/wavestone/jobs/ia?utm_source=x", startDate: "Février 2027" }, "user");
    expect(first.created).toBe(true);
    const again = createOffer(d, { ...WAVESTONE, url: "https://welcometothejungle.com/fr/companies/wavestone/jobs/ia", source: "lien", startDate: "Juillet 2027" }, "agent");
    expect(again).toMatchObject({ created: false, changes: ["date de début : « Février 2027 » → « Juillet 2027 »"] });
    expect(again.offer.sources.map((s) => s.source)).toEqual(["manuel", "lien"]);
    expect(again.offer.startDate).toBe("Juillet 2027");
    // Same company and title without a link: recognized too.
    expect(createOffer(d, { ...WAVESTONE, source: "import" }, "import").created).toBe(false);
    // A close title is a new offer marked as a probable duplicate.
    const close = createOffer(d, { ...WAVESTONE, title: "Stage Intelligence Artificielle Cybersécurité Paris" }, "user");
    expect(close.created).toBe(true);
    expect(close.offer.similarTo?.id).toBe(first.offer.id);
    expect(resolveSimilar(d, close.offer.id, "merge")).toBeNull();
    expect(d.all("SELECT id FROM offers")).toHaveLength(1);
  });
});

describe("application statuses", () => {
  it("never marks an application as sent without proof or the user's word", () => {
    const d = db();
    const offer = createOffer(d, WAVESTONE, "user").offer;
    expect(() => createApplication(d, offer.id, { actor: "agent", status: "sent" })).toThrow(/preuve/);
    const app = createApplication(d, offer.id, { actor: "agent" });
    expect(app.status).toBe("prepared");
    expect(() => setStatus(d, app.id, "sent", { actor: "agent" })).toThrow(/preuve/);
    expect(() => setStatus(d, app.id, "validated", { actor: "agent" })).toThrow();

    // Gmail finds an acknowledgment: proposed, then confirmed by the user.
    const ev = proposeStatus(d, app.id, { kind: "email", messageId: "m1", mailSubject: "Nous avons bien reçu votre candidature", suggests: "received" }, "gmail");
    expect(ev.confirmed).toBe(false);
    expect(getApplicationDetail(d, app.id).status).toBe("prepared");
    // The same email is not proposed twice.
    expect(proposeStatus(d, app.id, { kind: "email", messageId: "m1", suggests: "received" }, "gmail").id).toBe(ev.id);
    expect(confirmEvidence(d, ev.id).status).toBe("received");

    // The user's own statement is enough.
    expect(setStatus(d, app.id, "sent", { actor: "user" }).sentAt).not.toBeNull();
  });

  it("lets only the user say a test is done, and keeps external actions waiting for validation", () => {
    const d = db();
    const app = createApplication(d, createOffer(d, WAVESTONE, "user").offer.id, { actor: "user" });
    const test = addDeadline(d, app.id, { kind: "test", title: "Test AssessFirst", dueAt: "2026-11-05" }, "gmail");
    expect(() => setDeadlineStatus(d, test.id, "done", "agent")).toThrow(/Seul vous/);
    expect(setDeadlineStatus(d, test.id, "done", "user").status).toBe("done");

    const action = requestExternalAction(
      d,
      app.id,
      { kind: "Envoi de candidature", description: "Déposer le CV CV_Martin_Wavestone.pdf sur le site carrières de Wavestone pour le poste IA et cybersécurité." },
      "agent",
    );
    expect(action.status).toBe("pending");
    expect(() => decideExternalAction(d, action.id, "done")).toThrow(/Validez/);
    expect(decideExternalAction(d, action.id, "approved").status).toBe("approved");
    expect(() => decideExternalAction(d, action.id, "approved")).toThrow(/déjà/);
    expect(decideExternalAction(d, action.id, "done").status).toBe("done");
    const history = getApplicationDetail(d, app.id).history.map((h) => h.summary);
    expect(history.some((h) => h.includes("pour cette action seulement"))).toBe(true);
  });
});
