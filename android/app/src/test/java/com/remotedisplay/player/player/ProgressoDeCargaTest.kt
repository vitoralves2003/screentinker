package com.remotedisplay.player.player

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A BARRA DE CARREGAMENTO NÃO PODE MENTIR.
 *
 * Um painel ligando mostrava uma roda girando sobre "Conectando…" enquanto os vídeos desciam — o
 * trecho mais longo do arranque, e o único sem resposta para a pergunta de quem está instalando:
 * "isto está baixando ou travou?". A barra responde, e por isso ela tem de estar certa. Uma barra
 * que chega a 100% com arquivo faltando, ou que fica em 0% enquanto o disco enche, engana pior do
 * que a roda que ela substituiu.
 *
 * O que está preso aqui:
 *
 *   - mede por BYTES, não por arquivo — quatro arquivos dariam saltos de 25%
 *   - widget não entra: é HTML servido na hora, não há bytes para esperar
 *   - item desligado não entra: ele não vai ao ar, esperar por ele é esperar por nada
 *   - item SEM tamanho conhecido entra, com peso nominal — excluí-lo faria a barra bater
 *     100% com arquivo ainda descendo, que é a mentira mais cara das duas
 *   - nada para carregar devolve null, e a tela volta para a roda
 *
 * A lista entra pelo MESMO caminho do produto (updatePlaylist com o JSON do servidor), e não por
 * uma porta de teste: se o parse mudar, esta trava sente.
 */
class ProgressoDeCargaTest {

    private fun json(
        id: String,
        bytes: Long,
        widget: Boolean = false,
        ligado: Boolean = true,
        remoto: Boolean = false,
    ) = JSONObject().apply {
        put("id", id.hashCode())
        put("content_id", if (widget) JSONObject.NULL else id)
        put("filename", "$id.mp4")
        put("mime_type", "video/mp4")
        put("duration_sec", 10)
        put("file_size", bytes)
        put("enabled", if (ligado) 1 else 0)
        if (widget) put("widget_id", "w-$id")
        if (remoto) put("remote_url", "https://exemplo.invalid/$id.mp4")
    }

    private fun com(vararg itens: JSONObject): PlaylistController {
        val c = PlaylistController(
            onItemChanged = {},
            onPlaylistEmpty = {},
        )
        c.updatePlaylist(JSONArray().apply { itens.forEach { put(it) } })
        return c
    }

    private fun pct(p: Pair<Long, Long>?): Int {
        val (prontos, total) = p!!
        return ((prontos * 100) / total).toInt()
    }

    @Test
    fun `mede por bytes, e nao por quantidade de arquivos`() {
        /*
         * O caso que motiva a medida: um arquivo pequeno pronto e um grande faltando. Contando
         * ARQUIVOS isto seria 50%; em bytes é 9%, que é o que a pessoa de fato está esperando.
         */
        val c = com(json("pequeno", 10_000_000), json("grande", 100_000_000))

        assertEquals(9, pct(c.progressoDeCarga { it.contentId == "pequeno" }))
    }

    @Test
    fun `widget nao entra na conta`() {
        /*
         * Widget é HTML servido na hora — não há download. Se ele contasse, a barra ficaria presa
         * abaixo de 100% para sempre numa lista que já pode rodar.
         */
        val c = com(json("video", 50_000_000), json("clima", 0, widget = true))

        assertEquals("com o vídeo em disco a lista está pronta", 100, pct(c.progressoDeCarga { it.contentId == "video" }))
    }

    @Test
    fun `item desligado nao entra na conta`() {
        val c = com(json("no ar", 20_000_000), json("desligado", 80_000_000, ligado = false))

        assertEquals(100, pct(c.progressoDeCarga { it.contentId == "no ar" }))
    }

    @Test
    fun `item sem tamanho conhecido ENTRA, com peso nominal`() {
        /*
         * A escolha que mais importa, e a menos óbvia.
         *
         * `file_size` viaja no payload, mas nem todo item o traz — mídia antiga do servidor, por
         * exemplo. Excluí-lo faria a barra bater 100% com o arquivo ainda descendo, e o painel
         * ficaria "pronto" numa tela preta. Incluí-lo com peso nominal deixa a barra menos suave
         * naquele trecho e a mantém HONESTA, que é o que ela existe para ser.
         */
        val c = com(json("conhecido", 5_000_000), json("sem tamanho", 0))

        assertTrue("não pode dizer 100% com um arquivo faltando",
            pct(c.progressoDeCarga { it.contentId == "conhecido" }) < 100)
        assertEquals(100, pct(c.progressoDeCarga { true }))
    }

    @Test
    fun `nada para carregar devolve null`() {
        /* Só widgets: a tela volta para a roda em vez de desenhar uma barra sem significado. */
        assertNull(com(json("clima", 0, widget = true)).progressoDeCarga { false })

        /* Lista vazia. */
        assertNull(com().progressoDeCarga { false })
    }

    @Test
    fun `disco vazio e zero, disco cheio e cem`() {
        /*
         * A guarda dos extremos. Sem ela, uma implementação que devolvesse sempre 50% passaria em
         * boa parte do resto — as outras afirmações comparam faixas, não pontas.
         */
        val c = com(json("a", 30_000_000), json("b", 70_000_000))

        assertEquals(0, pct(c.progressoDeCarga { false }))
        assertEquals(100, pct(c.progressoDeCarga { true }))
    }
}
