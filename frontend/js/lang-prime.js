// Render-blocking language primer.
//
// The sidebar labels are written into index.html as literal text, and app.js — which owns the
// translations — is `type="module"`, so it is DEFERRED: the browser paints the markup first and
// swaps the words afterwards. On a slow machine that is a visible flash of the wrong language on
// every single page load, which is the sort of thing that makes a product feel unfinished before
// the reader has done anything.
//
// So this runs the same way brand-prime.js does, and for the same reason: a plain same-origin
// <script> placed in the sidebar, executing DURING parse, before first paint. It writes the nav
// labels from the saved language, and app.js then re-applies the full dictionary as usual.
//
// It carries its own copy of ~16 short strings, and that duplication is the price of not
// flashing. A test asserts these match the real dictionaries, so the copy cannot rot in silence.
(function () {
  'use strict';

  var LABELS = {
    pt: {
      dashboard: 'Telas', content: 'Arquivos', playlists: 'Playlists', layouts: 'Layouts',
      widgets: 'Widgets', schedule: 'Agenda', walls: 'Paredes de vídeo', reports: 'Relatórios',
      kiosk: 'Quiosque', designer: 'Designer', teams: 'Equipes', members: 'Membros',
      help: 'Ajuda', settings: 'Configurações', billing: 'Assinatura', admin: 'Administração',
    },
    en: {
      dashboard: 'Displays', content: 'Files', playlists: 'Playlists', layouts: 'Layouts',
      widgets: 'Widgets', schedule: 'Schedule', walls: 'Video Walls', reports: 'Reports',
      kiosk: 'Kiosk', designer: 'Designer', teams: 'Teams', members: 'Members',
      help: 'Help', settings: 'Settings', billing: 'Subscription', admin: 'Administration',
    },
    es: {
      dashboard: 'Pantallas', content: 'Archivos', playlists: 'Listas de reproducción', layouts: 'Diseños',
      widgets: 'Widgets', schedule: 'Horario', walls: 'Muros de video', reports: 'Informes',
      kiosk: 'Kiosco', designer: 'Diseñador', teams: 'Equipos', members: 'Miembros',
      help: 'Ayuda', settings: 'Configuración', billing: 'Suscripción', admin: 'Administrador',
    },
  };

  try {
    /*
     * The same resolution i18n.js uses, and it has to stay that way: if this picked a different
     * language from the one app.js settles on, the flash would come back — just in a different
     * pair of languages.
     */
    var lang = localStorage.getItem('rd_lang')
      || (navigator.language ? navigator.language.split('-')[0] : 'en');
    var dict = LABELS[lang] || LABELS.en;

    // Only the label span, never the badge that sits beside it.
    var links = document.querySelectorAll('.nav-link');
    for (var i = 0; i < links.length; i++) {
      var view = links[i].getAttribute('data-view');
      var text = dict[view];
      if (!text) continue;
      var span = links[i].querySelector('span');
      if (span) span.textContent = text;
    }

    // The document language, which was declaring English on a Portuguese page — screen readers
    // and the browser's own translation prompt both read it.
    document.documentElement.setAttribute('lang', lang === 'pt' ? 'pt-BR' : lang);
  } catch (e) {
    // A blocked localStorage or a missing nav must never stop the page loading. The labels stay
    // as they are in the markup and app.js corrects them a moment later — the old behaviour.
  }
})();
