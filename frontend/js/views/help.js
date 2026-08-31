import { esc, isPlatformAdmin } from '../utils.js';

// O texto da ajuda, por secao e por pergunta.
const AJUDA = {
  'activity.s1': 'Vá em Configurações e abra a aba Registro de atividades.',
  'activity.s2': 'Filtre por pessoa para ver só as ações de alguém.',
  'activity.s3': 'Visível apenas para o dono da conta.',
  'activity.title': 'Ver quem mexeu no quê',
  'contact_body': 'Se algo aqui não resolveu, fale com a gente:',
  'contact_title': 'Precisa de ajuda?',
  'display.s1': 'Instale o Loop Player no aparelho (APK) ou abra o player pelo navegador.',
  'display.s2': 'Informe o endereço do servidor quando o app pedir.',
  'display.s3': 'Anote o código de 6 dígitos que aparece na tela.',
  'display.s4': 'No painel, vá em Telas e clique em Adicionar tela.',
  'display.s5': 'Digite o código. A tela aparece na lista em segundos.',
  'display.title': 'Adicionar uma tela',
  'faq': 'Perguntas frequentes',
  'faq.devices.a': 'TV Box e tablets Android (pelo APK), e qualquer aparelho com navegador, usando o player web.',
  'faq.devices.q': 'Que aparelhos funcionam?',
  'faq.formats.a': 'MP4, WebM, AVI, MKV e MOV. Para compatibilidade máxima use MP4 com H.264.',
  'faq.formats.q': 'Quais formatos de vídeo posso enviar?',
  'faq.offline.a': 'A tela continua tocando normalmente: o conteúdo já está baixado no aparelho. As alterações que você fizer entram assim que a conexão voltar.',
  'faq.offline.q': 'O que acontece se a internet cair?',
  'faq.portrait.a': 'Pode. Na página da tela, mude a orientação para Retrato e o conteúdo gira sozinho — não precisa girar o vídeo antes de enviar.',
  'faq.portrait.q': 'Posso usar a tela em pé?',
  'faq.schedule_vs_expiry.a': 'Verifique se a playlist está publicada e se ela está atribuída a essa tela. Se o arquivo tiver agendamento, confira o relógio ao lado do nome dele em Arquivos: verde é no ar, cinza é fora do horário e vermelho já encerrou.',
  'faq.schedule_vs_expiry.q': 'Publiquei e a tela não mudou. O que houve?',
  'faq.update.a': 'Sozinho, a cada 30 minutos ele verifica se há versão nova. Também dá para forçar pela página da tela no painel.',
  'faq.update.q': 'Como o aplicativo se atualiza?',
  'layouts.s1': 'Vá em Layouts e crie um layout ou use um modelo.',
  'layouts.s2': 'Arraste as zonas para posicioná-las na tela.',
  'layouts.s3': 'Redimensione pelo canto da zona.',
  'layouts.s4': 'Atribua o layout a uma tela.',
  'layouts.s5': 'Cada zona recebe uma playlist inteira.',
  'layouts.title': 'Layouts com várias zonas',
  'playlist.s1': 'Vá em Playlists e clique em Nova playlist.',
  'playlist.s2': 'Clique em Adicionar conteúdo e escolha os arquivos.',
  'playlist.s3': 'Arraste para reordenar e ajuste a duração de cada item.',
  'playlist.s4': 'Em Telas, escolha qual tela recebe esta playlist.',
  'playlist.s5': 'Clique em Publicar. Nada chega às telas antes disso.',
  'playlist.title': 'Montar uma playlist',
  'schedule.s1': 'Em Arquivos, clique no nome do arquivo.',
  'schedule.s2': 'Em "Quando pode ser exibido", escolha um tipo de agendamento.',
  'schedule.s3': 'Regras do mesmo tipo somam; de tipos diferentes, todas precisam valer.',
  'schedule.s4': 'A frase abaixo das regras diz em português o que você montou.',
  'schedule.s5': 'Vale para todas as playlists que contêm o arquivo. Publique para enviar.',
  'schedule.title': 'Agendar quando um arquivo aparece',
  'subtitle': 'Guias rápidos e perguntas frequentes',
  'title': 'Central de ajuda',
  'upload.s1': 'Vá em Arquivos e clique em Adicionar arquivos.',
  'upload.s2': 'Arraste os arquivos ou clique para escolher no computador.',
  'upload.s3': 'Aceita MP4, WebM, JPEG, PNG, GIF e WebP.',
  'upload.s4': 'A duração dos vídeos é detectada sozinha e a miniatura é gerada.',
  'upload.s5': 'Clique no nome do arquivo para renomear, pré-visualizar ou agendar.',
  'upload.title': 'Enviar arquivos',
};

/*
 * The help page, rewritten to describe THIS product.
 *
 * It used to be nine cards and eleven answers, typed in English straight into the markup, and six
 * of the nine described screens a customer cannot open: Widgets, the AI designer, Kiosk, Video
 * Walls, Remote Control and a Schedule page that is not in the menu. The FAQ promised a 14-day
 * trial that no longer exists and explained how to export proof-of-play from a Reports page the
 * nav does not show. Help that names features the reader cannot find does not merely fail to
 * help — it makes them doubt they are looking at the right screen.
 *
 * So a guide appears only when the reader can reach the thing it describes, decided the same way
 * the menu decides: isPlatformAdmin for the staff-only pages, and for the activity log the server
 * itself is asked, because that rule lives in routes/activity.js and a copy here would be free to
 * drift from the one that actually refuses.
 *
 * Everything is a translation key. The previous version could not be translated at all.
 */

// A guide is { key, when } — `when` decides whether the reader can actually reach it. The keys
// resolve to help.<key>.title and help.<key>.s1..sN.
const GUIDES = [
  { key: 'display', icon: '&#128250;', steps: 5 },
  { key: 'upload', icon: '&#128228;', steps: 5 },
  { key: 'playlist', icon: '&#9776;', steps: 5 },
  { key: 'schedule', icon: '&#128197;', steps: 5 },
  { key: 'activity', icon: '&#128203;', steps: 3, when: (ctx) => ctx.isOwner },
  // Layouts is in the nav only for platform staff today; it appears here on the same rule, so the
  // two can never disagree about whether the page exists for this reader.
  { key: 'layouts', icon: '&#128465;', steps: 5, when: (ctx) => ctx.isStaff },
];

const FAQ = ['devices', 'formats', 'offline', 'portrait', 'update', 'schedule_vs_expiry'];

function stepsOf(key, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(AJUDA[`${key}.s${i}`]);
  return out;
}

export async function render(container) {
  /*
   * Owner-only guidance is asked about, not guessed. The activity log is gated on org_owner in
   * routes/activity.js, and reproducing that rule here from the cached user would be a second
   * opinion free to drift from the one that decides.
   */
  // The router does not await this, so paint something before the probe: otherwise the page keeps
  // whatever the previous view left on screen until the request comes back.
  container.innerHTML = `<div class="page-header"><div><h1>Central de ajuda</h1><div class="subtitle">Guias rápidos e perguntas frequentes</div></div></div>`;

  let isOwner = false;
  try {
    const res = await fetch('/api/activity/available', {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    });
    isOwner = res.ok ? !!(await res.json()).available : false;
  } catch { /* not reachable: leave the owner-only card out rather than promise it */ }

  let user = {};
  try { user = JSON.parse(localStorage.getItem('user') || '{}'); } catch { /* fall through */ }
  const ctx = { isOwner, isStaff: isPlatformAdmin(user) };

  const guides = GUIDES.filter((g) => !g.when || g.when(ctx));

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Central de ajuda</h1>
        <div class="subtitle">Guias rápidos e perguntas frequentes</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:24px">
      ${guides.map((g) => `
        <div class="settings-section" style="margin:0">
          <h3 style="font-size:15px">${g.icon} ${esc(AJUDA[`${g.key}.title`])}</h3>
          <ol style="padding-left:20px;list-style:decimal;margin-top:8px">
            ${stepsOf(g.key, g.steps).map((s) => `<li style="color:var(--text-secondary);font-size:13px;line-height:1.8">${esc(s)}</li>`).join('')}
          </ol>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>Perguntas frequentes</h3>
      ${FAQ.map((k) => `
        <div style="border-bottom:1px solid var(--border);padding:12px 0">
          <div style="font-weight:600;font-size:14px;margin-bottom:4px">${esc(AJUDA[`faq.${k}.q`])}</div>
          <div style="color:var(--text-secondary);font-size:13px">${esc(AJUDA[`faq.${k}.a`])}</div>
        </div>
      `).join('')}
    </div>

    <div class="settings-section">
      <h3>Precisa de ajuda?</h3>
      <p style="color:var(--text-secondary);font-size:13px">
        ${esc('Se algo aqui não resolveu, fale com a gente:')}
        <a href="mailto:contato@loopplayer.com.br" style="color:var(--accent-ink)">contato@loopplayer.com.br</a>
      </p>
    </div>
  `;
}

export function cleanup() {}
