# O ROSTO DO ROBO, NUM ARQUIVO QUADRADO (20/09).
#
# O simbolo do infinito e 182x96 -- quase duas vezes mais largo que alto. O Chatwoot
# desenha qualquer rosto como CIRCULO e recorta pelas laterais, entao sobrava so o no
# do meio e parecia um X.
#
# Este roteiro poe o simbolo dentro de um QUADRADO com folga, sobre o verde-quase-preto
# do painel. Assim nada cai fora do circulo, em qualquer tamanho que o chat use.

#   powershell -File scripts/manutencao/gerar-rosto-do-robo.ps1
#
# Roda de qualquer lugar: os caminhos saem da posicao DESTE arquivo, nunca de uma pasta
# gravada a mao -- que so funcionaria na maquina de quem escreveu.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$raiz    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$origem  = Join-Path $raiz 'frontend\assets\loop-player-symbol.png'
$destino = Join-Path $raiz 'deploy\atendimento\rosto-do-robo.png'

$LADO = 512
# O simbolo ocupa 70% da largura. O canto do retangulo fica a 203px do centro, dentro
# do raio de 256 do circulo -- com 52px de folga.
$LARGURA = 358
$ALTURA  = 189   # 358 * (96/182), mantendo a proporcao do original
$FUNDO   = [System.Drawing.ColorTranslator]::FromHtml('#04231A')

$simbolo = [System.Drawing.Image]::FromFile($origem)
Write-Output ("origem: {0} x {1}" -f $simbolo.Width, $simbolo.Height)

$quadro = New-Object System.Drawing.Bitmap($LADO, $LADO, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($quadro)
$g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$pincel = New-Object System.Drawing.SolidBrush($FUNDO)
$g.FillRectangle($pincel, 0, 0, $LADO, $LADO)

$x = [int](($LADO - $LARGURA) / 2)
$y = [int](($LADO - $ALTURA) / 2)
$g.DrawImage($simbolo, $x, $y, $LARGURA, $ALTURA)

$g.Dispose()
$pincel.Dispose()
$simbolo.Dispose()

$quadro.Save($destino, [System.Drawing.Imaging.ImageFormat]::Png)
$quadro.Dispose()

$tamanho = (Get-Item $destino).Length
Write-Output ("destino: {0} x {0}   {1:N1} KB" -f $LADO, ($tamanho / 1024))
Write-Output ("simbolo dentro: {0} x {1}, em ({2}, {3})" -f $LARGURA, $ALTURA, $x, $y)

# A conferencia que importa: o canto do simbolo tem de caber no circulo.
$meia = [Math]::Sqrt([Math]::Pow($LARGURA / 2, 2) + [Math]::Pow($ALTURA / 2, 2))
$raio = $LADO / 2
Write-Output ("canto a {0:N0}px do centro, raio do circulo {1:N0}px -- folga {2:N0}px" -f $meia, $raio, ($raio - $meia))
if ($meia -ge $raio) { throw 'O SIMBOLO AINDA CAI FORA DO CIRCULO' }
Write-Output 'PRONTO'
