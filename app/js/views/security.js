// Seguridad: cambiar el PIN, Face ID o huella, bloqueo automático y cómo se protegen los datos.

import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { section, list, row, toggleRow } from '../ui/components.js';
import { openSheet, confirmDialog } from '../ui/sheet.js';
import { pinPad } from '../ui/pinpad.js';
import { toast } from '../ui/toast.js';
import { rerender } from '../ui/shell.js';
import { lockNow, registerViewReset } from '../ui/session.js';
import {
  isBiometricAvailable, createPasskey, passkeySecret, forgetPasskey, biometricTexts,
  BiometricCancelledError, BiometricUnsupportedError,
} from '../ui/biometric.js';
import * as store from '../core/store.js';
import * as vault from '../core/vault.js';
import { AUTO_LOCK_OPTIONS } from '../core/catalog.js';

// Estado del desbloqueo biométrico (asíncrono): null mientras se consulta.
let bio = null;
registerViewReset(() => {
  bio = null;
});

async function loadBiometric() {
  const [available, status] = await Promise.all([isBiometricAvailable(), vault.biometricStatus().catch(() => ({ enabled: false }))]);
  bio = { available, enabled: status.enabled, credentialId: status.credentialId };
  rerender();
}

/** PIN → «Activar» (un toque nuevo, que el sistema exige para Face ID) → listo. */
function openEnableBiometric() {
  const t = biometricTexts();
  let dekRaw = null;
  let pending = null; // llave creada cuyo secreto falta pedir
  let done = false;
  const title = h('p', { class: 'alert-title', 'aria-live': 'polite' }, 'Escribe tu PIN');
  const content = h('div', { class: 'form' });
  const status = h('p', { class: 'help', role: 'status' });

  const finish = async (passkey) => {
    await vault.enableBiometric(dekRaw, passkey);
    dekRaw = null;
    done = true;
    sheet.close();
    toast(t.enabled);
    loadBiometric();
  };

  const activate = async (button) => {
    button.disabled = true;
    status.textContent = '';
    try {
      if (!pending) {
        const passkey = await createPasskey();
        if (passkey.secret) return await finish(passkey);
        pending = passkey; // este dispositivo pide confirmar otra vez para entregar el secreto
        title.textContent = `Confirma otra vez ${t.with}`;
        button.textContent = `Confirmar ${t.with}`;
        return;
      }
      await finish({ ...pending, secret: await passkeySecret(pending) });
    } catch (error) {
      if (error instanceof BiometricCancelledError) status.textContent = 'Cancelado. Pulsa el botón para intentarlo de nuevo.';
      else if (error instanceof BiometricUnsupportedError) status.textContent = `Este móvil no permite usar ${t.use} con apps web. En iPhone hace falta iOS 18 o posterior.`;
      else {
        console.error(error);
        status.textContent = `No se ha podido activar ${t.use}.`;
      }
    } finally {
      button.disabled = false;
    }
  };

  const pad = pinPad({
    onComplete: async (pin) => {
      pad.setBusy(true);
      try {
        dekRaw = await vault.dekForBiometric(pin);
      } catch (error) {
        pad.setBusy(false);
        if (error instanceof vault.LockedOutError || error?.lockedUntil) pad.error('Demasiados intentos. Espera unos minutos.');
        else if (error instanceof vault.WrongPinError) pad.error('PIN incorrecto.');
        else throw error;
        return;
      }
      title.textContent = `Ahora confirma ${t.with}`;
      const button = h('button', { type: 'button', class: 'btn primary', onClick: () => activate(button) }, `Activar ${t.name}`);
      replace(content,
        h('p', { class: 'help' }, `Se creará una llave de acceso para Nummo en este móvil. Solo sirve para abrir la app ${t.with}.`),
        button,
        status);
    },
  });
  replace(content, pad.el);
  const sheet = openSheet({
    title: `Activar ${t.name}`,
    tall: true,
    onClose: () => {
      dekRaw?.fill(0); // si se cancela a medias, la clave en claro no se queda en memoria
      if (pending && !done) forgetPasskey(pending.credentialId); // ni una llave sin usar en el llavero
    },
    body: [title, content],
  });
}

async function disableBiometric() {
  const t = biometricTexts();
  const confirmed = await confirmDialog({
    title: `¿Desactivar ${t.use}?`,
    text: 'La app volverá a pedirte siempre el PIN.',
    confirmLabel: 'Desactivar',
  });
  if (!confirmed) return rerender();
  await vault.disableBiometric();
  if (bio?.credentialId) forgetPasskey(bio.credentialId);
  toast(t.disabled);
  loadBiometric();
}

function biometricSection() {
  if (bio === null) {
    loadBiometric();
    return null;
  }
  if (!bio.available && !bio.enabled) return null;
  const t = biometricTexts();
  return section({ title: t.title, caption: `Aunque uses ${t.use}, cada 7 días te pediré el PIN para que no lo olvides: sin él no se pueden recuperar los datos.` },
    list([toggleRow(`Desbloquear ${t.with}`, bio.enabled, (checked) => {
      if (checked) {
        rerender(); // el interruptor refleja el estado real hasta terminar la activación
        openEnableBiometric();
      } else {
        disableBiometric();
      }
    })], { plain: true }));
}

function openChangePin() {
  let step = 'current';
  let current = null;
  let fresh = null;
  const title = h('p', { class: 'alert-title', 'aria-live': 'polite' }, 'Escribe tu PIN actual');
  const pad = pinPad({
    onComplete: async (pin) => {
      if (step === 'current') {
        pad.setBusy(true);
        try {
          await vault.verifyPin(pin);
          current = pin;
          step = 'new';
          title.textContent = 'Elige el nuevo PIN';
          pad.info('');
        } catch (error) {
          if (error instanceof vault.LockedOutError || error?.lockedUntil) pad.error('Demasiados intentos. Espera unos minutos.');
          else if (error instanceof vault.WrongPinError) pad.error('PIN incorrecto.');
          else throw error;
        } finally {
          pad.setBusy(false);
          pad.reset();
        }
        return;
      }
      if (step === 'new') {
        if (pin === current) return pad.error('El nuevo PIN debe ser distinto del actual.');
        if (vault.isWeakPin(pin)) return pad.error('Ese PIN es muy fácil de adivinar. Elige otro.');
        fresh = pin;
        step = 'confirm';
        title.textContent = 'Repite el nuevo PIN';
        pad.info('');
        return pad.reset();
      }
      if (pin !== fresh) {
        step = 'new';
        title.textContent = 'Elige el nuevo PIN';
        return pad.error('No coinciden. Vuelve a elegir el nuevo PIN.');
      }
      pad.setBusy(true);
      pad.info('Guardando…');
      try {
        await vault.changePin(current, fresh);
        sheet.close();
        toast('PIN cambiado');
      } catch (error) {
        console.error(error);
        pad.setBusy(false);
        pad.error('No se ha podido cambiar el PIN.');
      }
    },
  });
  const sheet = openSheet({ title: 'Cambiar PIN', tall: true, body: [title, pad.el] });
}

export function securityView() {
  const state = store.getState();
  return {
    title: 'Seguridad',
    back: { label: 'Más', path: '/mas' },
    body: [
      section({ title: 'PIN' }, list([
        row({ lead: icon('key'), title: 'Cambiar PIN', chevron: true, onClick: openChangePin }),
        row({ lead: icon('lock'), title: 'Bloquear ahora', onClick: () => lockNow() }),
      ])),
      biometricSection(),
      section({ title: 'Bloqueo automático', caption: 'Cuánto tiempo puede estar la app en segundo plano antes de volver a pedir el PIN.' },
        list(AUTO_LOCK_OPTIONS.map((option) => {
          const selected = option.seconds === state.settings.autoLockSec;
          return row({
            title: option.label,
            trailing: selected ? icon('check', { className: 'icon check' }) : null,
            label: `${option.label}${selected ? ', seleccionado' : ''}`,
            onClick: () => store.updateSettings({ autoLockSec: option.seconds }),
          });
        }), { plain: true })),
      section({ title: 'Cómo se protegen tus datos' },
        h('div', { class: 'card' },
          h('ul', { class: 'benefits' },
            h('li', null, icon('lock'), h('div', null, h('strong', null, 'Cifrado AES-256'), h('span', null, 'Todo se guarda cifrado en este dispositivo. Sin el PIN no se puede leer.'))),
            h('li', null, icon('shield-lock'), h('div', null, h('strong', null, 'Intentos limitados'), h('span', null, `Tras ${vault.FREE_ATTEMPTS} PIN incorrectos hay que esperar, cada vez más tiempo.`))),
            h('li', null, icon('eye-off'), h('div', null, h('strong', null, 'Privacidad'), h('span', null, 'Al salir de la app se ocultan tus datos y no se envía nada a internet.')))),
          h('p', { class: 'help' }, 'Un PIN de 6 cifras protege frente a quien coja tu móvil. La protección más fuerte la da el propio bloqueo del iPhone o Android: mantenlo activado.'))),
    ],
  };
}
