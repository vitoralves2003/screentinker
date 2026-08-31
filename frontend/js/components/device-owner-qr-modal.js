// #device-owner: the provisioning QR modal — factory-reset a panel, scan this during first-run
// setup, and Android silently installs the player as device owner. Shared by the device detail
// page and the Add Display flow so both show the exact same (always-current) QR. The checksum in
// the payload is computed server-side from the SERVED apk, so it can't drift from the build.
import { api } from '../api.js';
import { showToast } from './toast.js';
import { esc } from '../utils.js';

export async function showDeviceOwnerQRModal() {
  let info;
  try { info = await api.getDeviceOwnerQR(); }
  catch (e) { showToast(e.message || 'Falha ao carregar as informações de provisionamento', 'error'); return; }

  // Surface whether the checksum was derived from the live APK (the safe case) or fell back to a
  // constant because the server has no APK to read (the QR would then point at a missing download).
  const fromApk = info.checksum_source === 'apk';
  const verifyNote = fromApk
    ? 'Assinatura verificada a partir do APK atual do servidor — sempre corresponde à versão que será instalada.'
    : 'Ainda não há APK no servidor — usando a soma de verificação reserva. Envie o APK do player antes de provisionar.';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px;width:95vw">
      <div class="modal-header">
        <h3>Provisionar como proprietário do dispositivo</h3>
        <button class="modal-close" id="doClose">&times;</button>
      </div>
      <div class="modal-body">
        <p style="color:var(--text-muted);font-size:13px;line-height:1.5">Proprietário do dispositivo é um reforço opcional que libera atualização silenciosa, reinício limpo, trava de quiosque e controle de horário. Cadastre um painel novo ou recém-restaurado de fábrica por QR ou ADB.</p>
        <div style="text-align:center;margin:14px 0">
          <img src="${info.qr_data_url}" alt="provisioning QR" style="width:280px;height:280px;background:#fff;border-radius:8px;padding:8px"/>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Restaure o painel para o padrão de fábrica, toque 6× na tela de Boas-vindas do assistente e escaneie isto.</div>
          <div style="font-size:11px;color:${fromApk ? 'var(--success)' : 'var(--warning)'};margin-top:6px">${verifyNote}</div>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">Ou por ADB (aparelho novo, sem contas, depuração USB ligada):</div>
        <div style="display:flex;gap:6px;align-items:center">
          <code style="flex:1;background:var(--bg-input);padding:8px 10px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:nowrap">${esc(info.adb_command)}</code>
          <button class="btn btn-secondary btn-sm" id="doCopy">Copiar</button>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:12px;line-height:1.5">Exige um aparelho recém-configurado ou restaurado de fábrica, sem contas, e antes que outros apps proprietários se cadastrem. Se um MDM já for o proprietário, o app fica no Nível 0/1 e o MDM controla as atualizações.</p>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#doClose').onclick = close;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#doCopy').onclick = () => {
    navigator.clipboard?.writeText(info.adb_command)
      .then(() => showToast('Comando copiado', 'success')).catch(() => {});
  };
}
