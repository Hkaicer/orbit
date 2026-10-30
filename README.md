<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/orbit-dark.svg">
    <img src="docs/orbit-light.svg" alt="ORBIT" width="120">
  </picture>
</p>

<h1 align="center">ORBIT</h1>

<p align="center">Un assistant local et privé pour une recherche de stage ou d'emploi : offres, candidatures, CV et lettres adaptés, réponses reçues dans Gmail. L'IA de votre choix (Claude, ChatGPT ou une clé d'API) fait le travail de fond, rien ne part sans votre accord.</p>

## Ce que fait ORBIT

- **Offres** : ajout par lien, par texte copié ou par formulaire. Les doublons sont reconnus (même lien, ou même entreprise avec un titre proche) et chaque nouvelle source est gardée.
- **Analyse** : score d'adéquation du profil sur 100 (compétences /45, formation /20, expérience /35), verdict, points forts, lacunes, critères à vérifier. Les points pratiques (date de début, lieu, langue) sont listés à part et un point bloquant reste toujours visible.
- **Candidatures** : treize statuts, vue par étapes ou en liste, prochaine action, tests, entretiens, échéances, notes et historique complet. Le statut se change d'un clic, depuis la liste des offres comme depuis celle des candidatures.
- **CV et lettre adaptés** : collez une offre dans l'assistant et il crée la fiche, l'analyse, la candidature, puis un CV et une lettre adaptés en DOCX et en PDF. Les fichiers se téléchargent sous la réponse, et le bouton « Ouvrir le dossier » les montre dans l'Explorateur.
- **Gmail en lecture seule** : accusés de réception, tests, entretiens, refus et offres sont repérés et rattachés aux candidatures. Un statut suggéré par un e-mail attend toujours votre confirmation.
- **Tri des e-mails par l'assistant** : le bouton « Trier avec l'assistant » de la page Gmail lui fait lire les e-mails que les règles n'ont pas su placer. Pour chacun, il propose la candidature (ou une nouvelle offre, une nouvelle candidature) et le statut, par exemple un test à passer avec sa date. Vous modifiez chaque proposition, l'écartez, ou acceptez tout d'un clic. Un statut qui ferait reculer une candidature n'est jamais appliqué par « Tout accepter ».
- **Résultats de tests** : l'assistant ouvre le lien d'un e-mail (par exemple « Voir mes résultats ») en lecture seule et résume vos scores. Une page faite en JavaScript est affichée par Edge ou Chrome, invisible, avec un profil vide supprimé aussitôt.
- **Images** : joignez, collez ou déposez une capture d'écran ou une photo dans l'assistant (quatre au plus par message).
- **Alertes d'offres** : les alertes e-mail de LinkedIn, Indeed, HelloWork, Welcome to the Jungle et APEC deviennent des fiches, filtrées par les mots de votre recherche.
- **Recherche à la demande** : demandez à l'assistant de vous trouver des offres. Il pose d'abord ses questions, puis lit LinkedIn, Welcome to the Jungle et HelloWork (sans compte), France Travail, Adzuna, plusieurs sites d'offres ouverts et les sites carrières des entreprises suivies, et ajoute les 50 meilleures au plus, classées selon votre profil et jamais selon le lieu.
- **Recherche Indeed** : avec le connecteur officiel Indeed de votre compte claude.ai, l'assistant cherche des offres et lit leur description.
- **Performance** : offres trouvées, envois, taux et délai de réponse, étapes franchies, sources des offres.
- **Documents** : vos dossiers de CV et de lettres sont lus sans jamais être modifiés. ORBIT repère les versions de référence, les versions adaptées et les copies identiques.
- **Exports** : tableau de suivi en Excel ou en CSV, sauvegardes de la base.
- **Apparence** : thème clair, sombre ou celui du système.

## Ce qu'ORBIT ne fait jamais

- Envoyer une candidature, un e-mail ou un formulaire. Une action externe est seulement préparée, puis validée par vous, une par une.
- Considérer une candidature comme envoyée parce qu'un dossier existe. Les statuts qui décrivent un fait extérieur demandent une preuve confirmée ou votre déclaration.
- Modifier, déplacer ou renommer vos documents.
- Écrire dans Gmail : pas d'envoi, pas de suppression, pas de déplacement, pas de changement de l'état lu.
- Transmettre à l'IA un document marqué privé.
- Se connecter à vos comptes LinkedIn, Indeed ou HelloWork, ou postuler à votre place.
- Écouter sur le réseau : le serveur n'accepte que les requêtes de cet ordinateur.

## Ce qu'il faut

- Windows 10 ou 11. Le chiffrement du mot de passe Gmail, l'ouverture des dossiers et le lanceur utilisent Windows.
- [Node.js](https://nodejs.org) 22.13 ou plus récent.
- Un service d'IA, au choix :
  - un abonnement Claude (Pro ou Max), avec [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) installé et connecté,
  - un abonnement ChatGPT, avec une connexion sur la page d'OpenAI,
  - une clé d'API Anthropic ou OpenAI, facturée à part selon la consommation.
- [LibreOffice](https://www.libreoffice.org), facultatif, pour les PDF. Sans lui, les CV et les lettres sont faits en DOCX seulement.
- Gmail, facultatif, avec un mot de passe d'application.

## Installer et démarrer

```bash
git clone https://github.com/Hkaicer/orbit.git
cd orbit
```

Double-cliquez ensuite sur `start-orbit.bat`. Le premier lancement installe les dépendances et construit l'interface, puis ORBIT s'ouvre sur http://127.0.0.1:4320. Fermer la fenêtre noire arrête ORBIT.

Pour l'ouvrir comme une application, avec une icône sur le Bureau et dans le menu Démarrer :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
```

L'icône démarre le serveur en arrière-plan et l'arrête environ 20 minutes après la fermeture de la fenêtre. Pour retirer les icônes, relancez le script avec `-Remove`.

## Premier démarrage

Un écran d'accueil vous guide en trois étapes :

1. **Vos documents** : les dossiers où sont vos CV et vos lettres. Ils sont lus, jamais modifiés.
2. **Assistant IA** : ORBIT vérifie le service choisi. C'est l'abonnement Claude par défaut, et le bouton « Choisir le service » mène aux deux autres.
3. **Votre profil** : remplissez-le vous-même, ou lancez la « Découverte par l'IA ». L'IA lit alors vos CV et vos lettres et écrit un premier profil (formation, expériences, compétences, ce que vous cherchez). Ce qu'elle déduit est marqué « à confirmer », ce qui manque « à compléter ». La découverte ne crée aucune offre.

Le profil se relit ensuite dans Réglages, partie Profil. L'IA le reçoit à chaque demande.

## L'assistant

Le service se choisit dans Réglages, partie Assistant IA :

- **Abonnement Claude** : ORBIT lance Claude Code (`claude -p`) avec votre abonnement. C'est le seul service qui peut utiliser les connecteurs claude.ai, comme Indeed.
- **Abonnement ChatGPT** : « Continuer avec ChatGPT » ouvre la page de connexion d'OpenAI, où vous autorisez ORBIT à utiliser votre abonnement. L'usage compte dans votre abonnement ChatGPT.
- **Clé d'API** : une clé Anthropic ou OpenAI, vérifiée puis enregistrée seulement après votre accord sur la facturation à part.

La clé d'API et la connexion ChatGPT sont chiffrées avec la protection Windows de votre session, comme le mot de passe Gmail. Quel que soit le service, l'IA reçoit votre message, le profil, la grille d'analyse et les derniers échanges. Elle ne lit le reste (offres, documents, e-mails) qu'avec les outils d'ORBIT, affichés sous chaque réponse, et n'a accès ni aux fichiers de l'ordinateur ni à internet en dehors de ces outils.

Le mode se choisit pour chaque demande :

- **Auto** : l'IA choisit elle-même. Elle fait tout de suite ce que vous demandez clairement et vous propose le reste avant de le faire.
- **A** : l'IA prépare les changements, rien n'est fait avant votre validation.
- **B** : les étapes locales (fiche, analyse, dossier) sont faites seules.
- **C** : l'IA enchaîne le plus d'étapes possible.

Dans tous les modes, un envoi ou un dépôt attend votre accord. L'assistant peut aussi lire vos e-mails (lecture seule), ouvrir le lien utile d'un e-mail (jamais un lien qui agit : se désinscrire, confirmer, accepter, se connecter), lire les images que vous joignez et changer le thème. Le modèle se change aussi pour chaque demande. Avec Claude : Haiku pour les questions simples, Sonnet pour le travail courant, Opus pour les CV, les lettres et les analyses fines. Avec un modèle OpenAI : Rapide, Équilibré ou Approfondi, selon la réflexion demandée.

## Trouver des offres

**Recherche à la demande.** Écrivez par exemple « Trouve-moi des offres » dans l'assistant :

1. L'assistant pose d'abord ses questions (postes visés, contrat, lieu ou télétravail, langues, entreprises à privilégier ou à éviter, nombre d'offres) et propose pour chacune une réponse tirée de votre profil. Il ne cherche rien avant votre réponse.
2. ORBIT lit ensuite toutes les sources actives de Réglages, partie Sources de recherche, écarte ce qui sort de la recherche (mots exclus, autre contrat, autre lieu, offres déjà connues) et classe le reste. Le score tient compte des mots de la recherche, de vos orientations, des compétences de vos CV demandées par l'offre, du contrat et de la fraîcheur, jamais du lieu, qui n'est qu'un filtre.
3. L'assistant relit le classement, écarte les faux positifs et ajoute les meilleures offres, 50 au plus. Chaque fiche garde le site d'où elle vient et le score de la recherche, en attendant une analyse complète.

| Source | Accès | Réglage |
| --- | --- | --- |
| LinkedIn | Recherche publique, sans compte, lente (pauses de 2 à 4 secondes, deux mots-clés et trois pages au plus) | Aucun |
| Welcome to the Jungle | Recherche publique du site, sans compte, avec des pauses | Aucun |
| HelloWork | Pages de résultats publiques, sans compte, lentes | Aucun |
| France Travail | API officielle | Clé gratuite sur francetravail.io (API « Offres d'emploi v2 ») |
| Adzuna | API officielle | Clé gratuite sur developer.adzuna.com |
| Remotive, Arbeitnow, RemoteOK | API ouvertes | Aucun |
| Sites carrières (Greenhouse, Lever, Ashby, SmartRecruiters, Workday) | Données publiques des entreprises | Collez le lien d'une de leurs offres |
| Sites carrières Yello (EY par exemple) | Recherche publique du site, sans compte, avec des pauses | Collez le lien du site carrières ou d'une offre |

Toutes les sources sont actives au départ, et chacune se coupe dans Réglages. Les clés sont vérifiées puis chiffrées sur l'ordinateur. Les conditions d'utilisation de LinkedIn, Welcome to the Jungle et HelloWork n'autorisent pas la collecte automatique : leur lecture reste volontairement lente, pour un usage personnel, et chacune peut être coupée. L'APEC n'est pas lue : sa protection anti-robots refuse toute lecture automatique, ses offres arrivent par ses alertes e-mail.

**Alertes e-mail.** Créez des alertes sur LinkedIn, Indeed, HelloWork, Welcome to the Jungle ou APEC, envoyées à l'adresse Gmail connectée. À chaque lecture de Gmail, ORBIT crée une fiche pour chaque offre dont le titre contient un mot de votre recherche et aucun mot exclu (Réglages, partie Alertes d'offres). Seul le lien propre de l'offre est gardé, jamais les jetons de connexion des e-mails.

**Connecteur Indeed.** Avec l'abonnement Claude, si le connecteur Indeed est activé sur votre compte claude.ai, demandez par exemple « Cherche sur Indeed des stages en cybersécurité à Lyon ». L'assistant ne peut pas postuler. Vos autres connecteurs claude.ai restent interdits à l'assistant. Leur état est visible dans Réglages, partie Connecteurs.

Il n'existe pas de connecteur claude.ai pour chercher des offres ou postuler sur LinkedIn ou HelloWork. Le connecteur « LinkedIn Hiring Pro » sert seulement aux recruteurs à publier une offre. Ces sites arrivent donc par leurs alertes e-mail.

## CV et lettre

L'IA rédige le contenu à partir de vos CV, de votre profil et de vos règles de rédaction (Réglages, partie CV et lettre). La mise en page vient du modèle intégré d'ORBIT : une page, une colonne et des titres standards, que les logiciels de tri des recruteurs lisent bien.

Les fichiers sont rangés dans `Applications/<Entreprise>/<Poste>/`. Une nouvelle version ne remplace jamais l'ancienne (suffixe `_v2`, `_v3`). Rien n'est inventé : un mot-clé de l'offre absent de votre parcours est signalé comme une lacune.

Vous avez déjà votre propre générateur de CV ? Indiquez son chemin dans Réglages, partie CV et lettre. C'est un module Node qui exporte `JOBS`, `ME` et `buildCV` avec la bibliothèque `docx`. Il est seulement lu, dans un processus séparé.

## Gmail

1. Activez la validation en deux étapes sur le compte Google.
2. Créez un mot de passe d'application nommé ORBIT sur https://myaccount.google.com/apppasswords.
3. Dans ORBIT, page Gmail, collez les 16 lettres et cliquez sur « Vérifier et connecter ».

Le mot de passe est chiffré avec la protection Windows de votre session (DPAPI) dans `data/secrets.json`. Il n'apparaît ni dans la base, ni dans les journaux, ni dans les exports. Pour couper l'accès, cliquez sur « Déconnecter » puis supprimez le mot de passe d'application chez Google.

## Données

| Emplacement | Contenu |
| --- | --- |
| `data/orbit.db` | La base SQLite, avec vos réglages et votre profil |
| `data/backups/` | Une sauvegarde à chaque démarrage (les 30 dernières) et les sauvegardes manuelles |
| `data/secrets.json` | Le mot de passe Gmail, la clé d'API et la connexion ChatGPT, chiffrés |
| `data/logs/` | Les journaux, sans mot de passe ni contenu de message |
| `Applications/` | Un dossier par candidature, avec les CV et les lettres |

Tout reste sur votre ordinateur, et ces dossiers ne sont pas suivis par git.

## Réglages avancés

Un fichier `.env` à la racine peut changer :

| Variable | Par défaut |
| --- | --- |
| `ORBIT_PORT` | `4320` |
| `ORBIT_DATA_DIR` | `data` |
| `ORBIT_APPLICATIONS_DIR` | `Applications` |
| `ORBIT_LOG_LEVEL` | `info` |
| `ORBIT_IDLE_EXIT_MIN` | `20` (lancement par l'icône seulement) |

## Développement

```bash
npm install
npm run dev        # serveur et interface avec rechargement
npm run typecheck
npm test
npm run build
```

- `shared/` : types communs
- `server/domain/` : règles des offres, candidatures et historique
- `server/services/` : documents, import, dossiers, exports, CV et lettres
- `server/mail/` : Gmail en lecture seule et alertes d'offres
- `server/ai/` : services d'IA (Claude Code, ChatGPT, clés d'API), outils et modes
- `web/` : interface React
- `tests/` : règles métier et tests d'acceptation, avec Claude, Gmail et pages web simulés

## Licence

ORBIT est publié sous licence MIT. Voir le fichier [LICENSE](LICENSE).
