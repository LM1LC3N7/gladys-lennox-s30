// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the buttons and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** The start of a fingerprint, enough to recognize it. */
export const shortFingerprint = (fingerprint) => String(fingerprint ?? '').slice(0, 23);

export const FEATURE_NAMES = {
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.HUMIDITY]: both('Humidity', 'Humidité'),
  [FEATURES.MODE]: both('Mode', 'Mode'),
  [FEATURES.HEAT_SETPOINT]: both('Heating setpoint', 'Consigne de chauffage'),
  [FEATURES.COOL_SETPOINT]: both('Cooling setpoint', 'Consigne de climatisation'),
  [FEATURES.OPERATING_STATE]: both('Running', 'Fonctionnement'),
  [FEATURES.FAN_MODE]: both('Fan mode', 'Mode du ventilateur'),
  [FEATURES.FAN_RUNNING]: both('Fan running', 'Ventilateur en marche'),
  [FEATURES.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [FEATURES.ALERT_LEVEL]: both('Alert level', "Niveau d'alerte"),
  [FEATURES.ALERT_COUNT]: both('Active alerts', 'Alertes actives'),
  [FEATURES.ALERTS]: both('Alerts', 'Alertes'),
};

export const MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  heat: both('Heating', 'Chauffage'),
  cool: both('Cooling', 'Climatisation'),
  auto: both('Heating and cooling', 'Chauffage et climatisation'),
};

export const FAN_NAMES = {
  auto: both('Automatic', 'Automatique'),
  on: both('On', 'Marche'),
  circulate: both('Circulate', 'Brassage'),
};

export const ALERT_NAMES = {
  none: both('None', 'Aucune'),
  info: both('Information', 'Information'),
  minor: both('Minor', 'Mineure'),
  moderate: both('Moderate', 'Modérée'),
  critical: both('Critical', 'Critique'),
};

export const NO_ALERT = both('No alert', 'Aucune alerte');

export const T = {
  noHost: both(
    'Enter the IP address of your Lennox thermostat (with "Home Automation" turned on in its settings), then save.',
    "Saisissez l'adresse IP de votre thermostat Lennox (avec « Home Automation » activé dans ses réglages), puis enregistrez.",
  ),
  invalidHost: (typed) =>
    both(
      `"${typed}" is not an IP address of a device nor a host name.`,
      `« ${typed} » n'est ni l'adresse IP d'un appareil ni un nom d'hôte.`,
    ),
  configRetry: (wait) =>
    both(
      `The configuration could not be read from Gladys: asked again in ${wait.en}.`,
      `La configuration n'a pas pu être lue auprès de Gladys : nouvelle demande dans ${wait.fr}.`,
    ),
  storageUnreadable: both(
    'The state kept in /data cannot be read: nothing is sent to the thermostat (its pinned certificate is unknown) until it can. It is read again at each interval.',
    "L'état gardé dans /data ne peut pas être lu : rien n'est envoyé au thermostat (son certificat épinglé est inconnu) tant que ce n'est pas possible. Il est relu à chaque intervalle.",
  ),
  connecting: both('Reading the thermostat…', 'Lecture du thermostat…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  summary: (name, zones, level) =>
    both(
      `${name}: ${zones} zone${zones > 1 ? 's' : ''}${level && level !== 'none' ? `, alert level ${ALERT_NAMES[level].en.toLowerCase()}` : ''}.`,
      `${name} : ${zones} zone${zones > 1 ? 's' : ''}${level && level !== 'none' ? `, niveau d'alerte ${ALERT_NAMES[level].fr.toLowerCase()}` : ''}.`,
    ),
  noIdentity: both(
    'The thermostat answers but has not sent its serial number yet: no device until it does.',
    "Le thermostat répond mais n'a pas encore envoyé son numéro de série : aucun appareil tant qu'il ne l'a pas fait.",
  ),
  unreachable: (host, wait) =>
    both(
      `No answer from ${host} (next try in ${wait.en}). Check the address, that the thermostat is on the network and that "Home Automation" is on in its settings.`,
      `Pas de réponse de ${host} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse, que le thermostat est sur le réseau et que « Home Automation » est activé dans ses réglages.`,
    ),
  failing: (reason, wait) =>
    both(
      `The thermostat answers with an error (${reason}): next try in ${wait.en}.`,
      `Le thermostat répond par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The thermostat asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `Le thermostat demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  serverError: (wait) =>
    both(
      `The thermostat answered with a server error (HTTP 5xx): pause of ${wait.en}.`,
      `Le thermostat a répondu par une erreur serveur (HTTP 5xx) : pause de ${wait.fr}.`,
    ),
  certificateChanged: (fingerprint) =>
    both(
      `The certificate of the thermostat changed (now ${shortFingerprint(fingerprint)}…): nothing is sent to it. If you replaced or updated the thermostat, click "Trust the new certificate".`,
      `Le certificat du thermostat a changé (maintenant ${shortFingerprint(fingerprint)}…) : rien ne lui est envoyé. Si vous avez remplacé ou mis à jour le thermostat, cliquez sur « Faire confiance au nouveau certificat ».`,
    ),
  storage: both(
    'The certificate of the thermostat could not be kept in /data: nothing is read until it can (check the storage of Gladys).',
    "Le certificat du thermostat n'a pas pu être gardé dans /data : rien n'est lu tant que ce n'est pas possible (vérifiez le stockage de Gladys).",
  ),
  notRead: (names) =>
    both(
      `Not read any more: ${names} (another thermostat answers at this address, or it was removed).`,
      `Plus lu : ${names} (un autre thermostat répond à cette adresse, ou il a été retiré).`,
    ),
  pendingStop: (zones) =>
    both(
      `Off not applied yet (zone ${zones}): kept and sent again every 30 seconds until the thermostat reads off.`,
      `Arrêt pas encore appliqué (zone ${zones}) : gardé et renvoyé toutes les 30 secondes jusqu'à ce que le thermostat soit lu à l'arrêt.`,
    ),
  awaitingStop: (zones) =>
    both(
      `Off accepted (zone ${zones}), not read off yet: read again, and sent again if a read shows the zone running.`,
      `Arrêt accepté (zone ${zones}), pas encore lu à l'arrêt : relu, et renvoyé si une lecture montre la zone en marche.`,
    ),
  verifyStop: (zones) =>
    both(
      `Off kept (zone ${zones}): sent once the new address shows the serial number of the thermostat.`,
      `Arrêt gardé (zone ${zones}) : envoyé dès que la nouvelle adresse montre le numéro de série du thermostat.`,
    ),
  stopRefused: (zone, status) =>
    both(
      `Off of zone ${zone} refused by the thermostat (${status}): sent again in 5 minutes, given up after 3 refusals in a row.`,
      `Arrêt de la zone ${zone} refusé par le thermostat (${status}) : renvoyé dans 5 minutes, abandonné après 3 refus de suite.`,
    ),
  stopDropped: (zones) =>
    both(
      `Off of zone ${zones} dropped: another thermostat answers at the address.`,
      `Arrêt de la zone ${zones} retiré : un autre thermostat répond à l'adresse.`,
    ),
  stopGivenUp: (zone, status) =>
    both(
      `Off of zone ${zone} given up (${status}, 3 times): the zone may still be heating or cooling.`,
      `Arrêt de la zone ${zone} abandonné (${status}, 3 fois) : la zone chauffe ou climatise peut-être encore.`,
    ),
  badgeStopGivenUp: (status) => both(`Off given up (${status})`, `Arrêt abandonné (${status})`),
  notDue: (wait) =>
    both(
      `The thermostat is read at most once per interval: next read in ${wait.en}.`,
      `Le thermostat est lu au plus une fois par intervalle : prochaine lecture dans ${wait.fr}.`,
    ),
  trust: {
    confirm: (fingerprint) =>
      both(
        `Certificate refused: ${fingerprint}. Compare it, then click again between 3 and 60 s from now to trust exactly this one.`,
        `Certificat refusé : ${fingerprint}. Comparez-le, puis cliquez de nouveau entre 3 et 60 s à partir de maintenant pour approuver exactement celui-ci.`,
      ),
    nothing: both(
      'No new certificate was refused: nothing to trust.',
      "Aucun nouveau certificat n'a été refusé : rien à approuver.",
    ),
    done: (fingerprint) =>
      both(
        `The certificate ${shortFingerprint(fingerprint)}… is trusted from now on.`,
        `Le certificat ${shortFingerprint(fingerprint)}… est désormais approuvé.`,
      ),
  },
};

const OFF_AVAILABLE = both('the mode Off stays available', 'le mode Arrêt reste disponible');

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both(
    'This value is not one the feature takes.',
    "Cette valeur n'est pas acceptée par la fonctionnalité.",
  ),
  noConfig: both(
    'The configuration is not read yet: nothing sent.',
    "La configuration n'est pas encore lue : rien envoyé.",
  ),
  disabled: both(
    `Commands are disabled in the configuration (option "Allow the commands"); ${OFF_AVAILABLE.en}. Nothing sent.`,
    `Les commandes sont désactivées dans la configuration (option « Autoriser les commandes ») ; ${OFF_AVAILABLE.fr}. Rien envoyé.`,
  ),
  noAddress: both(
    'No address of the thermostat: nothing sent.',
    'Pas d’adresse du thermostat : rien envoyé.',
  ),
  storageUnreadable: both(
    '/data cannot be read (the pinned certificate is unknown): nothing sent.',
    '/data ne peut pas être lu (le certificat épinglé est inconnu) : rien envoyé.',
  ),
  storageWrite: both(
    '/data cannot be written: nothing sent.',
    '/data ne peut pas être écrit : rien envoyé.',
  ),
  notReadYet: both(
    'The thermostat is not read yet (or not since its last connection): nothing sent.',
    "Le thermostat n'est pas encore lu (ou pas depuis sa dernière connexion) : rien envoyé.",
  ),
  otherThermostat: both(
    'Another thermostat answers at this address: nothing sent.',
    'Un autre thermostat répond à cette adresse : rien envoyé.',
  ),
  stillRunning: both(
    'A command of this zone (or of the thermostat) is under way: nothing sent, try again.',
    'Une commande de cette zone (ou du thermostat) est en cours : rien envoyé, réessayez.',
  ),
  stopMeanwhile: both(
    'An Off of this zone came meanwhile: this command was not sent.',
    "Un arrêt de cette zone est arrivé entre-temps : cette commande n'a pas été envoyée.",
  ),
  stopInProgress: both(
    'An Off of this zone is under way: only a mode can be set now. Nothing sent.',
    'Un arrêt de cette zone est en cours : seul un mode peut être réglé maintenant. Rien envoyé.',
  ),
  notSeenYet: both(
    'The previous command of this zone is not seen on the thermostat yet (90 s at most): nothing sent.',
    "La commande précédente de cette zone n'est pas encore visible sur le thermostat (90 s au plus) : rien envoyé.",
  ),
  configChanged: both(
    'The configuration changed: nothing sent.',
    'La configuration a changé : rien envoyé.',
  ),
  paused: (wait) =>
    both(
      `The thermostat asked to wait (${wait.en} left): nothing sent; ${OFF_AVAILABLE.en}.`,
      `Le thermostat a demandé d'attendre (encore ${wait.fr}) : rien envoyé ; ${OFF_AVAILABLE.fr}.`,
    ),
  tooSlow: both(
    'The thermostat did not answer in time: nothing sent.',
    "Le thermostat n'a pas répondu à temps : rien envoyé.",
  ),
  missing: both(
    'A value this command needs was not read from the thermostat: nothing sent.',
    "Une valeur nécessaire à cette commande n'a pas été lue sur le thermostat : rien envoyé.",
  ),
  unknownZone: both(
    'This zone is not in use on the thermostat: nothing sent.',
    "Cette zone n'est pas utilisée sur le thermostat : rien envoyé.",
  ),
  away: both(
    'The thermostat is in away mode: set it from the thermostat or the Lennox app. Nothing sent.',
    "Le thermostat est en mode absence : réglez-le depuis le thermostat ou l'application Lennox. Rien envoyé.",
  ),
  modeNotOffered: both(
    'The zone does not offer this mode: nothing sent.',
    'La zone ne propose pas ce mode : rien envoyé.',
  ),
  singleSetpoint: both(
    'The thermostat is in single setpoint mode, not handled: nothing sent.',
    'Le thermostat est en mode consigne unique, non pris en charge : rien envoyé.',
  ),
  outOfRange: (min, max, unit) =>
    both(
      `Outside the limits of the zone (${min} to ${max} °${unit}): nothing sent.`,
      `Hors des limites de la zone (${min} à ${max} °${unit}) : rien envoyé.`,
    ),
  deadband: both(
    'The other setpoint cannot move out of the way within its limits (heating stays below cooling): nothing sent.',
    "L'autre consigne ne peut pas s'écarter dans ses limites (le chauffage reste sous la climatisation) : rien envoyé.",
  ),
  readOutOfRange: both(
    'A value read from the thermostat, to be written back, is outside the limits of the zone: nothing sent.',
    'Une valeur lue sur le thermostat, à réécrire, est hors des limites de la zone : rien envoyé.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the zone is unknown (${reason}): nothing sent.`,
      `L'état de la zone est inconnu (${reason}) : rien envoyé.`,
    ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Rien envoyé (${reason}).`),
  refused: (reason) =>
    both(`Refused by the thermostat (${reason}).`, `Refusé par le thermostat (${reason}).`),
  notYetApplied: both(
    'Sent and accepted, but the thermostat still shows the value before: not applied yet (read again in 5 and 20 s).',
    "Envoyée et acceptée, mais le thermostat montre encore la valeur d'avant : pas encore appliquée (relue dans 5 et 20 s).",
  ),
  sentUnconfirmed: both(
    'Sent, without confirmation yet (read again in 5 and 20 s).',
    'Envoyée, sans confirmation pour le moment (relue dans 5 et 20 s).',
  ),
  stopSentUnconfirmed: both(
    'Off sent and accepted, not read off yet: kept, read again, and sent again if a read shows the zone running.',
    "Arrêt envoyé et accepté, pas encore lu à l'arrêt : gardé, relu, et renvoyé si une lecture montre la zone en marche.",
  ),
  stopKept: (reason) =>
    both(
      `Off not applied yet (${reason}): kept in /data and sent again every 30 s until the thermostat reads off.`,
      `Arrêt pas encore appliqué (${reason}) : gardé dans /data et renvoyé toutes les 30 s jusqu'à ce que le thermostat soit lu à l'arrêt.`,
    ),
  stopVerify: both(
    'Off kept in /data: sent once the new address shows the serial number of the thermostat.',
    'Arrêt gardé dans /data : envoyé dès que la nouvelle adresse montre le numéro de série du thermostat.',
  ),
  stopRefusedKept: (status) =>
    both(
      `Off refused by the thermostat (${status}): kept, sent again in 5 minutes, given up after 3 refusals in a row.`,
      `Arrêt refusé par le thermostat (${status}) : gardé, renvoyé dans 5 minutes, abandonné après 3 refus de suite.`,
    ),
  stopGivenUp: (status) =>
    both(
      `Off given up (${status}, 3 times): the zone may still be heating or cooling.`,
      `Arrêt abandonné (${status}, 3 fois) : la zone chauffe ou climatise peut-être encore.`,
    ),
  stopEnded: both(
    'Off replaced by a newer mode sent from Gladys.',
    'Arrêt remplacé par un mode plus récent envoyé depuis Gladys.',
  ),
};
