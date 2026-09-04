/*
 * ESTA TELA MUDOU DE CASA — o redirecionador das views que a Etapa 9 reescreveu.
 *
 * Telas, Arquivos, Playlists, Layouts e a Central de ajuda vivem em React desde 02–04/09, e o
 * menu servido aponta todas para lá. Quem ainda chega aqui é DEEP-LINK ANTIGO: um `/app#/devices`
 * salvo nos favoritos, um link colado num grupo de mensagens, o histórico do navegador de alguém.
 *
 * A resposta certa para esses é levá-los para onde a tela mora agora — não desenhar uma segunda
 * versão dela. Duas telas para a mesma coisa divergem, e o sintoma ("mudei e não apareceu")
 * ninguém liga a uma cópia antiga que continuou funcionando.
 *
 * ── QUEM DECIDE É A LISTA SERVIDA, e não uma constante daqui ────────────────────────────────
 * O mesmo padrão de settings.js: o endereço sai de GET /api/menu, que é a fonte da verdade das
 * rotas. Se o servidor apontar o item para a casa nova, seguimos o href dele. Se apontar para cá
 * — uma instalação sem a Gestão no ar —, esta tela DIZ ISSO em vez de mandar a pessoa para um
 * lugar que não existe. Uma fonte, nenhuma segunda opinião.
 *
 * `location.replace`, e não assignment: o redirecionamento não vira degrau no histórico, então o
 * botão Voltar sai daqui em vez de quicar de volta para cá.
 */

/** O href que o menu servido dá para `id`, ou null quando ele não serve esse item. */
async function hrefDoMenu(id) {
  const r = await fetch('/api/menu', {
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
  });
  if (!r.ok) return null;
  const menu = await r.json();
  const listas = [
    ...(menu.secoes || []).flatMap((s) => s.itens || []),
    ...(menu.transversais || []),
    ...(menu.rodape || []),
  ];
  const item = listas.find((i) => i && i.id === id);
  if (!item || !item.href) return null;
  /* Um href que aponta de volta para o hash desta casa não é destino: seria um laço. */
  if (String(item.href).includes('/app#/')) return null;
  return item.href;
}

/**
 * Monta o redirecionador para `id` (o id do item no menu), com `sufixo` opcional — o pedaço da
 * rota nova que carrega o objeto, como `/<id da tela>` no detalhe.
 */
export function paraOItemDoMenu(id, sufixo = '') {
  return {
    async render(container) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>Levando você para a versão nova…</h3>
        </div>`;
      let destino = null;
      try { destino = await hrefDoMenu(id); } catch (e) { destino = null; }
      if (destino) {
        window.location.replace(destino + sufixo);
        return;
      }
      /*
       * Sem destino, DIZER — e não redesenhar a tela antiga nem mandar para lugar nenhum. Isto
       * acontece numa instalação sem a Gestão no ar, e a frase é o que separa "o produto está
       * quebrado" de "esta parte não está publicada aqui".
       */
      container.innerHTML = `
        <div class="empty-state">
          <h3>Esta tela mudou de lugar</h3>
          <p>Ela agora vive no painel unificado, e este servidor não está servindo o endereço novo.
             Entre pelo menu para chegar nela.</p>
        </div>`;
    },
    cleanup() {},
  };
}
