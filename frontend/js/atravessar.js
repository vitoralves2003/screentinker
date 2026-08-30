'use strict';

/*
 * ATRAVESSAR PARA A GESTÃO — uma implementação, dois lugares que precisam dela.
 *
 * A barra tem itens que levam à Gestão, e agora a fileira de configurações também. As duas
 * precisam exatamente do mesmo cuidado, e ele não é óbvio: um href direto levaria o navegador
 * até lá SEM sessão, porque o login próprio da Gestão está fechado — a pessoa cairia numa tela
 * que recusa. O clique pede um token de troca de 60 segundos e leva o destino junto.
 *
 * Estava dentro de app.js, escrito para a barra. Quando as abas passaram a precisar do mesmo,
 * a escolha era importar de app.js — o que fecharia um ciclo, já que app.js importa as views —
 * ou copiar. Copiar é como uma das duas um dia deixa de mandar o destino, ou passa a mandar o
 * token na query em vez de no fragmento, e ninguém nota.
 *
 * O TOKEN VAI NO FRAGMENTO da URL: fragmento não é enviado ao servidor, não entra em log de
 * acesso e não viaja no cabeçalho Referer. A página de destino lê e apaga na mesma hora.
 */

/*
 * @param {string} destino   caminho dentro da Gestão (ex.: '/configuracoes')
 * @param {function} [ocupar] avisa quem chamou que a travessia começou; deve devolver a função
 *                            que desfaz o aviso. Sem sinal nenhum, o clique parece não ter
 *                            funcionado e a pessoa clica de novo.
 */
export async function atravessarParaGestao(destino, ocupar) {
  const soltar = typeof ocupar === 'function' ? (ocupar() || (() => {})) : (() => {});

  try {
    const cfg = await (await fetch('/api/auth/config')).json();
    if (!cfg || !cfg.gestao_url) {
      alert('Gestão não configurada neste servidor.');
      return;
    }

    const r = await fetch('/api/auth/federation/gestao', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
    });
    const data = await r.json();
    if (!r.ok) {
      /*
       * A MENSAGEM DO SERVIDOR É A ÚTIL: ela diz se falta a segunda etapa, se o plano não
       * inclui a Gestão, ou se a federação está desligada neste servidor. Uma mensagem
       * genérica aqui transformaria três problemas diferentes — dois deles com solução na
       * mão de quem clicou — num "não deu certo".
       */
      alert(data.error || 'Não foi possível abrir a Gestão.');
      return;
    }

    window.location.href = cfg.gestao_url + '/entrar#t=' + encodeURIComponent(data.token)
      + '&d=' + encodeURIComponent(destino || '/dashboard');
  } catch (err) {
    alert('Não foi possível abrir a Gestão.');
  } finally {
    soltar();
  }
}

/*
 * O caminho dentro da Gestão a partir do endereço absoluto que o servidor mandou.
 *
 * O menu e a lista de abas trazem href completo; quem atravessa precisa só do caminho, porque
 * ele viaja como destino ao lado do token. Cai em '/dashboard' quando o endereço não se deixa
 * interpretar — um destino inválido no fragmento levaria a pessoa a uma tela vazia depois de
 * ter atravessado com sucesso, que é a pior hora para descobrir que algo estava errado.
 */
export function caminhoNaGestao(href) {
  try {
    return new URL(href, window.location.href).pathname || '/dashboard';
  } catch (e) {
    return '/dashboard';
  }
}
