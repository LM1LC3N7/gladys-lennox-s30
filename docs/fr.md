# Lennox S30 pour Gladys

Cette intégration affiche votre thermostat **Lennox S30, E30 ou M30** (iComfort) dans Gladys par son
**API locale**, sans le cloud Lennox ni l'application Lennox. Elle s'appuie sur ce que fait la bibliothèque
lennoxs30api (intégration Home Assistant), pour sa partie locale seulement.

> Jamais testé avec un vrai thermostat : tout a été vérifié sur un thermostat simulé, construit d'après la
> bibliothèque lennoxs30api et ses captures. Sans lien avec Lennox.

## Préparer le thermostat

1. Sur le thermostat : **Paramètres**, **Paramètres avancés**, activez **Home Automation** (l'API locale).
2. Donnez au thermostat une **adresse IP fixe** dans votre box.
3. Dans Gladys, saisissez cette adresse dans la configuration de l'intégration, enregistrez.
4. Ajoutez les appareils depuis l'onglet **Découverte**.

Le thermostat est joint en HTTPS. Son certificat est autosigné : il est **épinglé au premier contact**
(son empreinte est gardée dans `/data`) et vérifié à chaque connexion, avant tout envoi. S'il change (thermostat
remplacé ou mis à jour), rien n'est plus envoyé et l'état le dit : le bouton **Faire confiance au nouveau
certificat** (deux clics, 3 à 60 s d'écart) épingle exactement l'empreinte affichée.

L'API locale ne demande aucun identifiant : l'intégration n'en garde aucun.

## Appareils

- **Une zone** (une par zone utilisée) : température, humidité, mode (arrêt, chauffage, climatisation, les deux),
  consigne de chauffage, consigne de climatisation, fonctionnement (au repos, chauffe, climatise), mode du
  ventilateur (automatique, marche, brassage), ventilateur en marche.
- **Le système** : température extérieure, niveau d'alerte, nombre d'alertes actives, texte des alertes actives.

Les températures sont dans l'unité affichée par le thermostat (°F ou °C) au moment où l'appareil est ajouté. Une
mesure en °F est convertie exactement en °C (puis au dixième). Une mesure dont le thermostat dit qu'elle n'est pas
disponible n'est pas publiée. Le mode « chauffage d'urgence » s'affiche comme « chauffage ».

## Commandes

### Le mode Arrêt

Le mode **Arrêt** d'une zone ne demande aucune option : il part même avec l'option des commandes désactivée. Il écrit
« arrêt » dans le programme manuel de la zone, puis fait suivre ce programme à la zone (comme lennoxs30api) : rien
ne démarre entre les deux. Il passe devant une lecture ou une commande en cours, et part pendant une pause
demandée par le thermostat, avant la première lecture après un redémarrage, sans configuration lue (d'après
`/data`), même si `/data` ne peut pas être écrit.

Il est **refusé** seulement :

- sans adresse du thermostat (ni dans la configuration, ni dans `/data`) ;
- quand `/data` ne peut pas être lu (le certificat épinglé est alors inconnu) ;
- pour un appareil d'un autre thermostat que celui qui répond à l'adresse.

Tant que le thermostat n'est pas lu à l'arrêt, l'arrêt est **gardé dans `/data`** et renvoyé toutes les
30 secondes (et au redémarrage), sans limite de durée. Il prend fin quand une lecture montre la zone à l'arrêt,
quand un autre mode de la zone part depuis Gladys (un clic avec l'option), ou si un autre thermostat répond à
l'adresse. Le thermostat injoignable ou un certificat changé ne comptent pas comme un essai. S'il est refusé
trois fois de suite par le thermostat, ou accepté trois fois sans jamais être lu à l'arrêt, il est abandonné et
l'état, le badge de l'appareil et la réponse le disent. En mode absence, il vise le programme manuel, comme
lennoxs30api (non vérifié sur un vrai thermostat).

### Les autres commandes (option « Autoriser les commandes »)

Désactivées par défaut. Activées : le mode (chauffage, climatisation, les deux), les consignes de chauffage et de
climatisation et le mode du ventilateur.

- Décidées sur la file du thermostat vidée juste après le clic ; refusées si une valeur nécessaire n'a pas été
  lue, en mode absence, en mode consigne unique, pendant un arrêt en cours de la zone (sauf un mode, qui y met
  fin) et tant que la commande précédente de la zone n'est pas visible (90 s au plus).
- Les consignes sont arrondies au pas du thermostat (1 °F, 0,5 °C), l'autre unité est calculée exactement, et
  les deux valeurs doivent rester dans les limites de la zone lues sur le thermostat et dans les nôtres
  (chauffage 40 à 90 °F, climatisation 60 à 99 °F). Si la consigne de chauffage dépasserait la consigne de
  climatisation moins l'écart de la zone, l'autre consigne s'écarte dans le sens sûr (climatisation vers le haut,
  chauffage vers le bas), dans ses limites, sinon la commande est refusée.
- Une zone qui suit un programme reçoit une dérogation (copie de la période en cours, puis maintien jusqu'à la
  période suivante), comme dans l'application Lennox. Un changement de mode fait suivre le programme manuel à la
  zone.
- Une commande part dans les 3,5 s après le clic ou est refusée sans rien envoyer ; elle n'est un succès que si
  une lecture après l'envoi montre la valeur demandée. Sinon : « envoyée, sans confirmation » et relectures à 5 et
  20 s.

## Configuration

| Champ                          | Rôle                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| Adresse IP du thermostat       | IPv4 ou nom d'hôte, port 443 par défaut.                           |
| Autoriser les commandes        | Désactivé par défaut (voir plus haut).                             |
| Intervalle de rafraîchissement | 5 à 300 s (10 s par défaut) : lecture des changements mis en file. |
| Langue                         | Noms des fonctionnalités, textes d'état, erreurs.                  |

Tout est redemandé au thermostat toutes les 10 minutes. Un thermostat qui demande de ralentir (429) ou répond
par une erreur serveur (5xx) met en pause les lectures et les commandes (1 minute à 6 heures), pas l'arrêt.

## Limites connues

- Non vérifié sur un vrai thermostat ; le comportement en mode absence, en mode zoné central et la durée de
  l'attente de la file (`LongPollingTimeout=1`) viennent de lennoxs30api.
- Le S40 n'est pas pris en charge (son identité diffère).
- Pas de programmes, d'humidification ni de ventilation dans cette version.
