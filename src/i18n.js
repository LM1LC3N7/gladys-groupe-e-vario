// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (the connection status). Every text is a
// { en, fr } object: Gladys picks the user's language.
// -----------------------------------------------------------------------------

import { localText } from './time.js';

const reasons = {
  rate_limited: {
    en: 'the API asked to slow down (429)',
    fr: 'l’API demande de ralentir (429)',
  },
  server: { en: 'the API is unavailable (5xx)', fr: 'l’API est indisponible (5xx)' },
  retired: {
    en: 'the API v2 is gone (404/410): Groupe E may have retired it, update the integration',
    fr: 'l’API v2 a disparu (404/410) : Groupe E l’a peut-être retirée, mettez l’intégration à jour',
  },
  http: { en: 'unexpected HTTP answer', fr: 'réponse HTTP inattendue' },
  network: { en: 'network error', fr: 'erreur réseau' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  too_large: { en: 'answer too large', fr: 'réponse trop grande' },
  invalid: { en: 'unreadable answer', fr: 'réponse illisible' },
};
const reason = (code, lang) => (reasons[code] ?? reasons.invalid)[lang];

const calendarNames = {
  integrated: { en: 'integrated', fr: 'intégré' },
  grid: { en: 'grid', fr: 'réseau' },
};

export const T = {
  starting: {
    en: 'Reading the saved Groupe E Vario prices…',
    fr: 'Lecture des prix Groupe E Vario gardés…',
  },
  storeUnreadable: {
    en: 'The saved data in /data cannot be read: read again every 10 seconds, nothing asked from Groupe E meanwhile (check the volume of the integration).',
    fr: 'Les données gardées dans /data sont illisibles : relues toutes les 10 secondes, rien n’est demandé à Groupe E en attendant (vérifiez le volume de l’intégration).',
  },

  /**
   * The status: whether today is known, the last day held, the publication
   * time of Groupe E, the last check and its error, the calendars not fed,
   * the contracts whose inputs do not read, a /data that cannot be written.
   */
  status({
    todayPartial,
    through,
    tomorrowMissing,
    publication,
    checkedAt,
    error,
    retryAt,
    calendars = {},
    invalid = 0,
    dataError,
  }) {
    const out = {};
    for (const lang of ['en', 'fr']) {
      const en = lang === 'en';
      const parts = [];
      if (through) {
        parts.push(
          en
            ? `Groupe E Vario prices known through ${through}.`
            : `Prix Groupe E Vario connus jusqu’au ${through}.`,
        );
      } else if (!todayPartial) {
        parts.push(
          en
            ? 'No Groupe E Vario price for today yet.'
            : 'Pas encore de prix Groupe E Vario pour aujourd’hui.',
        );
      }
      if (todayPartial) {
        parts.push(
          en
            ? 'Today is not complete: its missing quarter hours stay without a cost.'
            : 'Aujourd’hui est incomplet : ses quarts d’heure manquants restent sans coût.',
        );
      }
      if (tomorrowMissing) {
        parts.push(
          en
            ? 'Tomorrow is not published yet: asked again every 30 minutes.'
            : 'Demain n’est pas encore publié : redemandé toutes les 30 minutes.',
        );
      }
      if (publication) {
        parts.push(
          en
            ? `Last publication: ${localText(Date.parse(publication))} (Swiss time).`
            : `Dernière publication : ${localText(Date.parse(publication))} (heure suisse).`,
        );
      }
      if (checkedAt) {
        parts.push(
          en
            ? `Last check: ${localText(checkedAt)}.`
            : `Dernière vérification : ${localText(checkedAt)}.`,
        );
      }
      if (error) {
        const next = retryAt ? localText(retryAt) : undefined;
        parts.push(
          en
            ? `Last attempt failed: ${reason(error, lang)}${next ? `, next one about ${next}` : ''}.`
            : `Dernière tentative en échec : ${reason(error, lang)}${next ? `, prochaine vers ${next}` : ''}.`,
        );
      }
      for (const [kind, issue] of Object.entries(calendars)) {
        const name = calendarNames[kind]?.[lang] ?? kind;
        parts.push(
          issue === 'refused'
            ? en
              ? `The ${name} calendar is fed by another integration (refused by Gladys).`
              : `Le calendrier ${name} est alimenté par une autre intégration (refusé par Gladys).`
            : en
              ? `The ${name} calendar could not be fed: tried again at the next check.`
              : `Le calendrier ${name} n’a pas pu être alimenté : nouvel essai à la prochaine vérification.`,
        );
      }
      if (invalid > 0) {
        parts.push(
          en
            ? `${invalid} contract(s) with an input out of bounds: not priced.`
            : `${invalid} contrat(s) avec une saisie hors bornes : non tarifé(s).`,
        );
      }
      if (dataError) {
        parts.push(
          en
            ? '/data cannot be written: the prices stay in memory until the next restart.'
            : '/data ne peut pas être écrit : les prix restent en mémoire jusqu’au prochain redémarrage.',
        );
      }
      parts.push(en ? 'Source: Groupe E.' : 'Source : Groupe E.');
      out[lang] = parts.join(' ').slice(0, 1000);
    }
    return out;
  },
};
