#!/usr/bin/env python3
"""
INSTALA A NOSSA FOLHA DENTRO DO QUADRO DO CHAT.

    sudo python3 deploy/atendimento/instalar-folha-do-chat.py

── por que um roteiro, e nao um `cp` ────────────────────────────────────────────────────
O arquivo deste repositorio tem so o bloco `listen 80`. O que esta em producao foi
REESCRITO pelo certbot: ele ganhou o bloco 443 com o certificado e um segundo `server`
que redireciona. Copiar por cima apagaria tudo isso e derrubaria o HTTPS do atendimento.

Entao o trecho da folha e RECORTADO do arquivo do repositorio, entre os marcadores
`# >>> FOLHA DO CHAT` e `# <<< FOLHA DO CHAT`, e INSERIDO no de producao, logo antes do
`location /`. Recortar por marcador e nao por contagem de chaves e deliberado: o CSS ali
dentro tem chaves, e contar chaves levaria o bloco pela metade.

── idempotente, e volta sozinho se errar ───────────────────────────────────────────────
Rodar duas vezes nao duplica: um trecho ja instalado e substituido. E a conf so fica de pe
se `nginx -t` aceitar -- se nao aceitar, o arquivo volta ao que era antes de o roteiro
mexer. Conf de nginx quebrada nao derruba so este endereco: derruba TODOS os da maquina.
"""

import os
import shutil
import subprocess
import sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'nginx-ajuda.loopplayer.com.br.conf')
PRODUCAO = '/etc/nginx/sites-available/ajuda.loopplayer.com.br'

ABRE = '# >>> FOLHA DO CHAT'
FECHA = '# <<< FOLHA DO CHAT'
ANCORA = '    location / {'


def recortar(texto, arquivo):
    i = texto.find(ABRE)
    f = texto.find(FECHA)
    if i == -1 or f == -1 or f < i:
        sys.exit(f'{arquivo}: nao achei os marcadores da folha ({ABRE} ... {FECHA})')
    return texto[i:f + len(FECHA)]


def main():
    if not os.path.exists(PRODUCAO):
        sys.exit(f'{PRODUCAO} nao existe -- este roteiro roda na VPS')

    trecho = recortar(open(REPO, encoding='utf-8').read(), REPO)
    atual = open(PRODUCAO, encoding='utf-8').read()

    # Tira uma instalacao anterior, para rodar de novo nao empilhar copias.
    if ABRE in atual:
        i = atual.find(ABRE)
        f = atual.find(FECHA)
        if f == -1:
            sys.exit(f'{PRODUCAO}: achei a abertura da folha e nao o fechamento -- conserte a mao')
        atual = atual[:i] + atual[f + len(FECHA):]
        atual = atual.replace('\n\n\n', '\n\n')
        print('  trecho anterior removido')

    if ANCORA not in atual:
        sys.exit(f'{PRODUCAO}: nao achei `{ANCORA.strip()}` para ancorar a insercao')

    novo = atual.replace(ANCORA, trecho + '\n\n' + ANCORA, 1)

    salvo = PRODUCAO + '.antes-da-folha'
    shutil.copy2(PRODUCAO, salvo)
    open(PRODUCAO, 'w', encoding='utf-8').write(novo)

    teste = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
    if teste.returncode != 0:
        shutil.copy2(salvo, PRODUCAO)
        print(teste.stderr.strip())
        sys.exit('nginx recusou a conf -- o arquivo foi RESTAURADO e nada mudou')

    print('  nginx -t aceitou')
    print(f'  copia do estado anterior em {salvo}')
    print(f'  linhas: {len(atual.splitlines())} -> {len(novo.splitlines())}')
    print('PRONTO -- falta `systemctl reload nginx`')


if __name__ == '__main__':
    main()
