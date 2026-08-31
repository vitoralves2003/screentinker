import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc, hydrateAuthImages } from '../utils.js';

// O catalogo de widgets: nome, unidade e as perguntas de cada um.
export const CATALOGO = {
  'clock': 'Relógio',
  'clock_desc': 'Hora e data atuais. Sem configuração.',
  'football': 'Futebol',
  'football_desc': 'Jogos e tabela do Brasileirão Série A.',
  'football_matches': 'Jogos da rodada',
  'football_table': 'Tabela do campeonato',
  'lot_diadesorte': 'Dia de Sorte',
  'lot_duplasena': 'Dupla Sena',
  'lot_federal': 'Federal',
  'lot_lotofacil': 'Lotofácil',
  'lot_lotomania': 'Lotomania',
  'lot_maismilionaria': '+Milionária',
  'lot_megasena': 'Mega-Sena',
  'lot_quina': 'Quina',
  'lot_supersete': 'Super Sete',
  'lot_timemania': 'Timemania',
  'lottery': 'Loteria',
  'lottery_desc': 'Resultados da Caixa — escolha a modalidade.',
  'lottery_pick_one': 'Escolha ao menos uma modalidade',
  'modalities': 'modalidades',
  'news': 'Notícias',
  'news_agro': 'Agronegócios',
  'news_carros': 'Carros',
  'news_desc': 'Letreiro de manchetes.',
  'news_economia': 'Economia',
  'news_entretenimento': 'Entretenimento',
  'news_esportes': 'Esportes',
  'news_geral': 'Geral',
  'news_mundo': 'Mundo',
  'news_pick_one': 'Escolha ao menos uma editoria',
  'news_politica': 'Política',
  'news_saude': 'Ciência e saúde',
  'news_tecnologia': 'Tecnologia',
  'sections': 'editorias',
  'weather': 'Previsão do Tempo',
  'weather_desc': 'Condições atuais de uma cidade.',
  'weather_load_failed': 'Não foi possível carregar as cidades',
  'weather_loading': 'Carregando cidades…',
  'weather_placeholder': 'Cidade (ex.: São Paulo)',
  'weather_required': 'Informe uma cidade primeiro',
};

/*
 * ADICIONAR ITENS -- a uma lista, ou a uma tela.
 *
 * Este modal morava em views/playlists.js e servia so a pagina de listas. A tela passou a ser
 * dona do proprio conteudo e precisava do mesmo seletor; o Vitor sugeriu copia-lo.
 *
 * Copiar resolveria hoje. Duas copias do mesmo seletor divergem no dia em que alguem acrescenta
 * um tipo de widget numa e esquece a outra -- e o sintoma seria "existe na playlist e nao existe
 * na tela", que ninguem liga a uma copia feita meses antes. Entao ele mudou de casa, e os dois
 * chamadores passam o que os diferencia.
 *
 * A ABA FERRAMENTAS SAIU. Ela oferecia URL remota e YouTube, e as duas ja existem em Arquivos --
 * "soltar arquivo, colar URL, colar link do YouTube" -- que e onde uma biblioteca se alimenta.
 * Aqui eram um atalho para o mesmo lugar.
 */

/*
 * Loop OS: the FIXED widget catalogue.
 *
 * The standalone widget manager is no longer the tenant's entry point (its nav item is hidden),
 * because "build a widget" is not a job a shop owner wants — "put the weather on that screen" is.
 * So this is a closed list of four things, each of which creates the widget and drops it into the
 * playlist in one click.
 *
 * `ask` is the only configuration any of them takes: null means zero-config, otherwise it is the
 * single field collected before the widget is created. Anything more elaborate belongs in the
 * widget editor, which still exists for whoever needs it.
 *
 * diag-smoothness is deliberately absent — it is an internal frame-rate diagnostic and must never
 * be offered to a customer. Keeping the catalogue a closed list (rather than filtering the full
 * type set) is what guarantees that: a new internal type cannot leak in by being forgotten.
 */
/*
 * Name a widget after what it is AND what it was set to.
 *
 * Four lottery widgets all called "Loteria" is what a playlist looked like before this, and it is
 * genuinely impossible to tell from the list which one shows which draw. The same rule runs on
 * create and on edit, so the name never contradicts the setting.
 */
export function widgetName(entry, value) {
  const base = CATALOGO[entry.key];
  if (!value || !entry.ask) return base;
  if (Array.isArray(value)) {
    if (!value.length) return base;
    // One game reads as itself; several read as a count, because six labels in a list row is not
    // a name anybody can scan. The unit is the widget's own word — a news widget reading four
    // sections is not showing "4 modalidades".
    if (value.length === 1) return widgetName(entry, value[0]);
    return `${base} — ${value.length} ${CATALOGO[(entry.unitKey || 'modalities')]}`;
  }
  if (entry.ask.options) {
    const opt = entry.ask.options.find(o => o.value === value);
    return opt ? `${base} — ${CATALOGO[opt.labelKey]}` : base;
  }
  // A free-text or remote-picked value (a city id) is not a label; the caller supplies one.
  return `${base} — ${value}`;
}

export const WIDGET_CATALOGUE = [
  {
    type: 'clock',
    key: 'clock',
    icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    ask: null,
    config: () => ({ format: '24h', show_date: true, font_size: 64, color: '#FFFFFF', background: 'transparent' }),
  },
  {
    type: 'weather',
    key: 'weather',
    icon: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    // A picked CITY, not typed text. The old free-text field fed a name straight to the weather
    // API, which resolves ambiguity by guessing — "Pinheiros" is a town in ES and a district of
    // São Paulo, and the wrong one produces a perfectly plausible temperature for the wrong
    // place. The list carries coordinates (lib/cities-br.js) so there is nothing to guess.
    ask: { field: 'city_id', required: true, remote: 'cities' },
    config: (v) => ({ city_id: v, show_forecast: true }),
    current: (cfg) => cfg.city_id || '',
  },
  {
    type: 'football',
    key: 'football',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M12 7l4.2 3-1.6 5h-5.2L7.8 10z"/>',
    ask: { field: 'view', required: false, options: [
      { value: 'matches', labelKey: 'football_matches' },
      { value: 'table', labelKey: 'football_table' },
    ] },
    config: (v) => ({ view: v || 'matches', max_rows: v === 'table' ? 10 : 6 }),
    current: (cfg) => cfg.view || 'matches',
  },
  {
    type: 'rss',
    key: 'news',
    icon: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    /*
     * A category picker rather than a feed URL — nobody wants to paste an RSS endpoint into a
     * signage tool — and MULTI, because one source repeats itself. A single portal publishes a
     * dozen stories a day; a widget reading only that shows the same handful over and over. Pick
     * several and the server interleaves them, so consecutive cards come from different newsrooms.
     */
    ask: { field: 'feed_urls', required: false, multi: true, options: [
      { value: 'https://g1.globo.com/rss/g1/', labelKey: 'news_geral' },
      { value: 'https://ge.globo.com/rss/ge/', labelKey: 'news_esportes' },
      { value: 'https://g1.globo.com/rss/g1/economia/', labelKey: 'news_economia' },
      { value: 'https://g1.globo.com/rss/g1/politica/', labelKey: 'news_politica' },
      { value: 'https://g1.globo.com/rss/g1/mundo/', labelKey: 'news_mundo' },
      { value: 'https://g1.globo.com/rss/g1/tecnologia/', labelKey: 'news_tecnologia' },
      { value: 'https://g1.globo.com/rss/g1/ciencia-e-saude/', labelKey: 'news_saude' },
      { value: 'https://g1.globo.com/rss/g1/pop-arte/', labelKey: 'news_entretenimento' },
      { value: 'https://g1.globo.com/rss/g1/carros/', labelKey: 'news_carros' },
      { value: 'https://g1.globo.com/rss/g1/economia/agronegocios/', labelKey: 'news_agro' },
    ] },
    // No scroll_speed/font_size/colour here any more: those configure the crawling ticker, which
    // is now opt-in via mode: 'ticker'. A new news widget is a full-screen card — one headline
    // over its own photograph — and takes none of them.
    unitKey: 'sections',
    /*
     * item_seconds is written EXPLICITLY, not left to the renderer's default, because a widget
     * created before this carried item_seconds: 9 and the edit merge preserved it — so a 15s slot
     * still showed one headline and a slice of the next. A value the catalogue owns has to be
     * (re)stated every time, or the old one silently wins forever.
     */
    config: (v) => ({
      feed_urls: (Array.isArray(v) && v.length) ? v : ['https://g1.globo.com/rss/g1/'],
      item_seconds: 25,
    }),
    // Dead weight from the crawling-ticker era. background:'#000000' in particular was still
    // being applied, painting the card black instead of its themed backdrop.
    drops: ['scroll_speed', 'font_size', 'color', 'background', 'max_items', 'feed_url'],
    // Widgets made before the multi-select carry a single feed_url; read as a list of one.
    current: (cfg) => (Array.isArray(cfg.feed_urls) && cfg.feed_urls.length
      ? cfg.feed_urls : [cfg.feed_url || 'https://g1.globo.com/rss/g1/']),
  },
  {
    type: 'lottery',
    key: 'lottery',
    icon: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    // Ten modalities, one widget. Each carries its own colour, ball count and result SHAPE
    // server-side (lib/lottery.js) — Federal is a prize table, Super Sete is columns, +Milionária
    // adds clovers — so the only thing chosen here is which draw to show.
    // MULTI: pick several and the widget cycles through them, so one playlist slot covers the
    // draws a customer follows instead of needing a widget per game.
    ask: { field: 'games', required: false, multi: true, options: [
      { value: 'megasena',       labelKey: 'lot_megasena' },
      { value: 'lotofacil',      labelKey: 'lot_lotofacil' },
      { value: 'quina',          labelKey: 'lot_quina' },
      { value: 'lotomania',      labelKey: 'lot_lotomania' },
      { value: 'duplasena',      labelKey: 'lot_duplasena' },
      { value: 'timemania',      labelKey: 'lot_timemania' },
      { value: 'diadesorte',     labelKey: 'lot_diadesorte' },
      { value: 'maismilionaria', labelKey: 'lot_maismilionaria' },
      { value: 'supersete',      labelKey: 'lot_supersete' },
      { value: 'federal',        labelKey: 'lot_federal' },
    ] },
    // game_seconds stated explicitly for the same reason as the news widget: a value the catalogue
    // owns must be rewritten on every save or a stale one outlives every change.
    config: (v) => ({ games: (Array.isArray(v) && v.length) ? v : ['megasena'], game_seconds: 25 }),
    // The old catalogue stamped these into every lottery widget it made; none is read any more,
    // and background:'transparent' fights the themed backdrop.
    drops: ['font_size', 'color', 'accent', 'background', 'game'],
    // Widgets created before the multi-select carry a single `game`; read them as a list of one so
    // the dialog opens on what they actually show rather than on nothing.
    current: (cfg) => (Array.isArray(cfg.games) && cfg.games.length ? cfg.games : [cfg.game || 'megasena']),
  },
];

export async function abrirModalDeItens(opts = {}) {
  /*
   * `adicionar` e a unica coisa que os dois chamadores fazem diferente: a pagina de listas manda
   * para a lista, a tela manda para a tela. Tudo o mais -- as abas, a busca, o catalogo de
   * widgets, a trava de plano -- e igual, e por isso mora aqui e nao em dois lugares.
   */
  const { titulo, adicionar, aoMudar, filtrarListas, playlistId = null } = opts;
  // #105: when opts.replaceItemId is set, picking an item REPLACES that item's
  // content/widget in place (preserving duration/schedule/zone) instead of adding.
  const replaceItemId = opts.replaceItemId || null;
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:1000';
  modal.innerHTML = `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;max-width:560px;width:95vw;max-height:80vh;display:flex;flex-direction:column">
      <h3 style="margin-bottom:16px;color:var(--text-primary)">${replaceItemId ? 'Substituir conteúdo' : (titulo || 'Adicionar conteúdo')}</h3>
      <div style="display:flex;gap:8px;margin-bottom:12px" id="addItemTabs">
        <button class="btn btn-primary btn-sm tab-btn active" data-tab="content">Conteúdo</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="widgets" style="display:none">Widgets</button>
        <button class="btn btn-secondary btn-sm tab-btn" data-tab="sublists" style="display:none">Sub-listas</button>
      </div>
      <input type="text" id="addItemSearch" class="input" placeholder="Buscar..." style="width:100%;margin-bottom:12px">
      <div id="addItemList" style="flex:1;overflow-y:auto;min-height:200px;max-height:400px"></div>
      <div style="display:flex;justify-content:flex-end;margin-top:16px">
        <button class="btn btn-secondary" id="closeAddModal">Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let activeTab = 'content';
  let allContent = [];
  let allPlaylists = [];
  let plan = {};

  try {
    // The plan decides which tabs exist at all (4.3). A failure to read it is treated as "no
    // paid features" by the `|| {}` below rather than as an error — the content tab still works,
    // which is the one every plan has.
    const [content, playlists, sub] = await Promise.all([
      api.getContent(),
      api.getPlaylists ? api.getPlaylists().catch(() => []) : Promise.resolve([]),
      api.getSubscription ? api.getSubscription().catch(() => null) : Promise.resolve(null),
    ]);
    allContent = content || [];
    // Only OTHER playlists can be sub-lists, and only ones that are not themselves nesting —
    // the server enforces this too (lib/sublists.js); filtering here just avoids offering a
    // choice that would be rejected.
    /*
     * Nunca a propria lista -- uma lista dentro de si mesma e o servidor recusa (lib/sublists.js),
     * e oferecer o que so pode dar erro e pior que nao oferecer.
     *
     * `filtrarListas` e o resto: a tela usa para tirar o espaco proprio das OUTRAS telas, que
     * sao listas automaticas e nao coisas que alguem reaproveita.
     */
    allPlaylists = (playlists || [])
      .filter(p => p.id !== playlistId)
      .filter(p => (filtrarListas ? filtrarListas(p) : true));
    plan = (sub && sub.plan) || {};
  } catch (err) {
    document.getElementById('addItemList').innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">${`Falha ao carregar playlists: ${esc(err.message)}`}</div>`;
  }

  // 4.3: reveal the paid tabs only when the plan allows them. Hidden rather than shown-disabled,
  // because a tab that exists only to say "upgrade" is noise in a tool someone uses daily.
  const tabs = modal.querySelector('#addItemTabs');
  if (plan.widgets_enabled) tabs.querySelector('[data-tab="widgets"]').style.display = '';
  // Sub-lists are a Corporativo feature and the whole tab hides below it: a tab that exists only
  // to say "upgrade" is noise in a tool someone uses daily. Ferramentas is NOT gated — remote URL
  // and YouTube are available on every plan.
  if (plan.sublists_enabled) tabs.querySelector('[data-tab="sublists"]').style.display = '';

  // Add (or replace) an item, then reflect it in the list. Shared by all three tabs so the
  // post-add behaviour cannot drift between them.
  async function commitItem(data, btn, label) {
    try {
      btn.disabled = true;
      if (replaceItemId) {
        btn.textContent = 'Substituindo…';
        await api.updatePlaylistItem(playlistId, replaceItemId, data);
        modal.remove();
        if (aoMudar) await aoMudar();
        showToast('Conteúdo substituído');
        return;
      }
      btn.textContent = 'Adicionando...';
      await adicionar(data);
      btn.textContent = 'Adicionado';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      if (aoMudar) await aoMudar();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = label;
      showToast(err.message, 'error');
    }
  }

  // The fixed four-widget catalogue (4.2). Each row creates the widget through the existing
  // POST /api/widgets and drops it straight into the playlist — two calls, one click.
  function renderWidgetCatalogue(list) {
    list.innerHTML = WIDGET_CATALOGUE.map(w => {
      let control = '';
      if (w.ask && w.ask.multi) {
        // Checkboxes, not a multi-select list box: on a touch panel a ctrl-click list is close to
        // unusable, and the whole point is that picking several is the normal thing to do here.
        control = `<div class="cat-multi" data-key="${w.key}" style="margin-top:6px;display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px 10px">
          ${w.ask.options.map((o, i) => `<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-primary);cursor:pointer">
             <input type="checkbox" value="${esc(o.value)}"${i === 0 ? ' checked' : ''}>
             ${esc(CATALOGO[o.labelKey])}
           </label>`).join('')}
        </div>`;
      } else if (w.ask && w.ask.options) {
        control = `<select class="input cat-input" data-key="${w.key}" style="width:100%;margin-top:6px;font-size:12px">
          ${w.ask.options.map(o => `<option value="${esc(o.value)}">${esc(CATALOGO[o.labelKey])}</option>`).join('')}
        </select>`;
      } else if (w.ask && w.ask.remote === 'cities') {
        // Filled in after render from /api/widgets/weather/cities — the list is server-owned so
        // the coordinates behind each entry stay in one place.
        control = `<select class="input cat-input" data-key="${w.key}" style="width:100%;margin-top:6px;font-size:12px">
          <option value="">${esc('Carregando cidades…')}</option>
        </select>`;
      } else if (w.ask) {
        control = `<input type="text" class="input cat-input" data-key="${w.key}" list="cat-list-${w.key}"
                     placeholder="${esc(CATALOGO[w.key + '_placeholder'])}"
                     style="width:100%;margin-top:6px;font-size:12px">
                   <datalist id="cat-list-${w.key}">${(w.ask.list || []).map(v => `<option value="${esc(v)}">`).join('')}</datalist>`;
      }
      return `
        <div class="catalogue-row" style="display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:var(--radius);border:1px solid var(--border);margin-bottom:8px">
          <div style="width:36px;height:36px;border-radius:8px;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--accent-ink)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${w.icon}</svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${esc(CATALOGO[w.key])}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${esc(CATALOGO[w.key + '_desc'])}</div>
            ${control}
          </div>
          <div style="flex-shrink:0;display:flex;align-items:center;gap:6px">
            <input type="number" class="input cat-dur" data-key="${w.key}" value="10" min="1" max="43200"
                   title="Por quantos segundos este widget fica na tela"
                   style="width:64px;font-size:12px;padding:4px 6px;text-align:right">
            <span style="font-size:11px;color:var(--text-muted)">seg</span>
            <button class="btn btn-primary btn-sm cat-add" data-key="${w.key}">${replaceItemId ? 'Substituir' : 'Adicionar'}</button>
          </div>
        </div>`;
    }).join('');

    // Populate the city picker. Failure is non-fatal: the select keeps its placeholder and the
    // required-field check below stops an empty submission, rather than the row vanishing.
    const citySel = list.querySelector('.cat-input[data-key="weather"]');
    if (citySel && citySel.tagName === 'SELECT') {
      api.getWeatherCities()
        .then(cities => {
          citySel.innerHTML = cities.map(c =>
            `<option value="${esc(c.id)}">${esc(c.label)} — ${esc(c.uf)}</option>`).join('');
        })
        .catch(() => { citySel.innerHTML = `<option value="">${esc('Não foi possível carregar as cidades')}</option>`; });
    }

    list.querySelectorAll('.cat-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const entry = WIDGET_CATALOGUE.find(w => w.key === btn.dataset.key);
        const multi = entry.ask && entry.ask.multi
          ? list.querySelector(`.cat-multi[data-key="${entry.key}"]`) : null;
        const input = list.querySelector(`.cat-input[data-key="${entry.key}"]`);
        const value = multi
          ? [...multi.querySelectorAll('input:checked')].map(cb => cb.value)
          : (input ? input.value.trim() : '');
        if (multi && !value.length) {
          showToast(CATALOGO[entry.key + '_pick_one'], 'error');
          return;
        }
        if (entry.ask && entry.ask.required && !value) {
          showToast(CATALOGO[entry.key + '_required'], 'error');
          if (input) input.focus();
          return;
        }
        const label = replaceItemId ? 'Substituir' : 'Adicionar';
        try {
          btn.disabled = true;
          btn.textContent = 'Adicionando...';
          // Name the widget after what it is plus its distinguishing input, so a playlist with
          // three weather widgets is readable in the item list. Same rule as the edit dialog uses.
          const name = widgetName(entry, value);
          const widget = await api.createWidget({ widget_type: entry.type, name, config: entry.config(value) });
          const campo = list.querySelector(`.cat-dur[data-key="${CSS.escape(entry.key)}"]`);
          await commitItem({
            widget_id: widget.id,
            duration_sec: Math.max(1, parseInt(campo && campo.value, 10) || 10),
          }, btn, label);
        } catch (err) {
          btn.disabled = false;
          btn.textContent = label;
          showToast(err.message, 'error');
        }
      });
    });
  }

  // Sub-lists (4.3): every other playlist in the workspace becomes a rotating slot. The server
  // rejects anything that would nest more than one level; this list is just the offer.
  /*
   * A ABA FERRAMENTAS SAIU, e o codigo dela veio junto na mudanca de casa.
   *
   * Eram TOOLS, renderTools e openTool: URL remota e YouTube, que criavam o conteudo e o
   * punham na lista numa tacada. As duas coisas existem em Arquivos -- "soltar arquivo, colar
   * URL, colar link do YouTube" -- que e onde uma biblioteca se alimenta; aqui eram um atalho.
   *
   * Saiu inteiro em vez de ficar inalcancavel: 120 linhas que ninguem chama sao 120 linhas que
   * a proxima pessoa vai ler achando que fazem parte do modal.
   */


  function renderSubLists(list, search) {
    if (!list) return;
    const filtered = allPlaylists.filter(p => (p.name || '').toLowerCase().includes(search));
    if (!filtered.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">Nenhuma outra playlist para usar como sub-lista</div>`;
      return;
    }
    list.innerHTML = filtered.map(p => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius)">
        <div style="width:40px;height:30px;border-radius:4px;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${`${p.item_count || 0} itens · um toca por rodada`}</div>
        </div>
        <select class="input btn-sm sub-order" data-id="${esc(p.id)}" style="width:auto;background:var(--bg-input)"
                title="${esc('Em sequência toca na ordem da lista. Aleatório embaralha, sem repetir um item antes de passar por todos.')}">
          <option value="sequence">${esc('Em sequência')}</option>
          <option value="random">${esc('Aleatório')}</option>
        </select>
        <button class="btn btn-primary btn-sm sub-add" data-id="${esc(p.id)}">${replaceItemId ? 'Substituir' : 'Adicionar'}</button>
      </div>`).join('');

    list.querySelectorAll('.sub-add').forEach(btn => {
      btn.addEventListener('click', () => {
        // Read the order off the row being added, not off some remembered global: two rows can be
        // added in one visit and they are separate decisions.
        const order = list.querySelector(`.sub-order[data-id="${CSS.escape(btn.dataset.id)}"]`)?.value || 'sequence';
        commitItem(
          { sub_playlist_id: btn.dataset.id, sub_order: order },
          btn,
          replaceItemId ? 'Substituir' : 'Adicionar',
        );
      });
    });
  }

  function renderTab() {
    const list = document.getElementById('addItemList');
    const search = (document.getElementById('addItemSearch')?.value || '').toLowerCase();

    // The catalogue is four fixed entries, and Ferramentas is two forms plus a short list — a
    // search box above either is furniture, and above Ferramentas it is worse than that: it
    // sits over the URL field and looks like it belongs to it.
    const searchBox = document.getElementById('addItemSearch');
    if (searchBox) searchBox.style.display = activeTab === 'widgets' ? 'none' : '';

    if (activeTab === 'widgets') return renderWidgetCatalogue(list);
    if (activeTab === 'sublists') return renderSubLists(list, search);

    const items = allContent;
    const filtered = items.filter(item => {
      const name = (item.filename || item.name || '').toLowerCase();
      return name.includes(search);
    });

    if (!filtered.length) {
      list.innerHTML = `<div style="color:var(--text-muted);padding:20px;text-align:center">Nenhum conteúdo encontrado</div>`;
      return;
    }

    list.innerHTML = filtered.map(item => {
      const name = item.filename || item.name || 'Desconhecido';
      // #237: the server gives a video item the clip's own length instead of the 10s default.
      // Show that length here so the duration the item lands with is something the operator
      // saw coming, rather than a number that appears in the list after the fact.
      const clipSec = Number(item.duration_sec) > 0 ? Math.ceil(item.duration_sec) : 0;
      const clip = clipSec ? ` · ${Math.floor(clipSec / 60)}:${String(clipSec % 60).padStart(2, '0')}` : '';
      const sub = (item.mime_type || '') + clip;
      const thumb = item.thumbnail_path ? `/api/content/${esc(item.id)}/thumbnail` : null;
      /*
       * SO IMAGEM PERGUNTA QUANTO TEMPO. Um video ja tem duracao propria, e oferecer um campo
       * ali seria oferecer um corte com cara de configuracao.
       */
      const pedeDuracao = !clipSec && !(item.mime_type || '').startsWith('video/');
      return `
        <div class="add-item-row" data-id="${esc(item.id)}" data-type="content" style="display:flex;align-items:center;gap:12px;padding:10px;border-radius:var(--radius);cursor:pointer;transition:background 0.1s">
          <div style="width:40px;height:30px;border-radius:4px;overflow:hidden;background:var(--bg-input);flex-shrink:0;display:flex;align-items:center;justify-content:center">
            ${thumb ? `<img data-auth-src="${thumb}" style="width:100%;height:100%;object-fit:cover">` : '<div style="color:var(--text-muted);opacity:0.4"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></div>'}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
            <div style="font-size:11px;color:var(--text-muted)">${esc(sub)}</div>
          </div>
          ${pedeDuracao ? `<input type="number" class="input add-item-dur" data-id="${esc(item.id)}" value="10" min="1" max="43200"
                 title="Por quantos segundos esta imagem fica na tela"
                 style="width:64px;font-size:12px;padding:4px 6px;text-align:right">
            <span style="font-size:11px;color:var(--text-muted);margin-left:-6px">seg</span>` : ''}
          <button class="btn btn-primary btn-sm add-item-btn" data-id="${esc(item.id)}">${replaceItemId ? 'Substituir' : 'Adicionar'}</button>
        </div>
      `;
    }).join('');
    hydrateAuthImages(list, { eager: true });

    list.querySelectorAll('.add-item-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // O campo so existe onde a duracao e uma escolha; sem ele, quem decide e o servidor --
        // que da ao video a duracao do proprio clipe.
        const campo = list.querySelector(`.add-item-dur[data-id="${CSS.escape(btn.dataset.id)}"]`);
        const dados = { content_id: btn.dataset.id };
        if (campo) dados.duration_sec = Math.max(1, parseInt(campo.value, 10) || 10);
        commitItem(dados, btn, replaceItemId ? 'Substituir' : 'Adicionar');
      });
    });
  }

  modal.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      modal.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('btn-primary', b.dataset.tab === activeTab);
        b.classList.toggle('btn-secondary', b.dataset.tab !== activeTab);
        b.classList.toggle('active', b.dataset.tab === activeTab);
      });
      renderTab();
    });
  });

  document.getElementById('addItemSearch').addEventListener('input', renderTab);

  document.getElementById('closeAddModal').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  renderTab();
}
