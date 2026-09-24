# 🔑 Accès SSH au VPS — CYRUS SUPER ASSISTANT

> **Archive — ne pas utiliser.** La VM Google Cloud ci-dessous n'est plus
> active selon l'utilisateur. Le backend cible est désormais Render; suivre
> `docs/DEPLOIEMENT-JARVIS.md`. Les coordonnées SSH sont conservées uniquement
> comme historique et ne donnent pas accès au service Render.

> **À lire avant toute tentative d'accès SSH au VPS.** Ce document est la source
> de référence pour se connecter au VPS sans jamais recréer de clé.

## VPS

| Champ | Valeur |
|---|---|
| VPS (IP publique) | `34.135.20.27` |
| Utilisateur SSH | `deploy` |
| Domaine public (Caddy/sslip.io) | `https://34-135-20-27.sslip.io` |
| Backend (port local conteneur) | `3000` |

## Clé SSH (paire dédiée, créée le 2026-09-12)

| Fichier | Chemin local (machine de l'utilisateur, HORS dépôt Git) |
|---|---|
| **Clé privée** (jamais à partager) | `C:\Users\HP\.ssh\vps_34_135_20_27` |
| Clé publique (configurée dans GCP) | `C:\Users\HP\.ssh\vps_34_135_20_27.pub` |

Clé publique actuellement autorisée pour l'utilisateur `deploy` dans Google Cloud :

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFxHHbK+hiZ5iFp3oLWu3mTVfBCLonTKdtmio2r4MVA4 cyrus-vps-34-135-20-27
```

## Commande de connexion de référence

```bash
ssh -i ~/.ssh/vps_34_135_20_27 deploy@34.135.20.27
```

Exemple de test en lecture seule :

```bash
ssh -i ~/.ssh/vps_34_135_20_27 -o ConnectTimeout=10 deploy@34.135.20.27 "echo CONNEXION_OK; hostname; whoami"
```

## 🔒 RÈGLE DE SÉCURITÉ ABSOLUE

- **NE JAMAIS** copier, committer ou pousser la **clé privée** (`vps_34_135_20_27`,
  ni aucune autre clé) dans ce dépôt ni sur GitHub. Elle vit uniquement hors du
  dépôt, dans `~/.ssh/`.
- **NE JAMAIS** afficher le contenu de la clé privée.
- Seule cette documentation (info publiques : IP, utilisateur, clé **publique**)
  appartient au dépôt.

## ⚠️ Avant de créer une nouvelle clé SSH

1. Vérifier **d'abord** que `C:\Users\HP\.ssh\vps_34_135_20_27` existe encore (sur
   la machine de l'utilisateur).
2. Vérifier que la clé publique ci-dessus figure toujours dans Google Cloud
   console → Compute Engine → instance `instance-20260909-074745` → **Modifier →
   Clés SSH**.
3. Ne générer une nouvelle paire QUE si la clé ci-dessus est perdue ou refusée
   (`Permission denied (publickey)`), et documenter alors le remplacement ici.

## Historique / contexte

- Ancienne clé `~/.ssh/gcp_deploy_key` (user `deploy`) **refusée** le
  2026-09-12 → d'où la création de la paire dédiée ci-dessus, ajoutée
  manuellement dans Google Cloud à cette date.
- Prochaines sessions (Claude/OpenCode/autres agents) : utiliser **uniquement**
  la commande de référence ci-dessus, jamais `gcp_deploy_key`.
