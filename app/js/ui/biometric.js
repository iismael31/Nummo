// Face ID o huella mediante una llave de acceso (WebAuthn) del propio dispositivo.
// Solo se usa su extensión PRF: tras verificar a la persona, el dispositivo entrega un secreto de
// 32 bytes que depende de la llave y de una «sal» guardada en la app. No hay servidor ni firmas que
// comprobar: lo que protege los datos es ese secreto, que el dispositivo solo da tras Face ID o la huella.
// Necesita iOS 18 o posterior, o un Android con Chrome y el gestor de contraseñas de Google.

import { pwa } from './pwa.js';
import { randomBytes, toBase64 } from '../core/crypto.js';
import { BIO_SALT_BYTES } from '../core/vault.js';

/** La persona canceló o dejó pasar el tiempo (no es un error que haya que explicar). */
export class BiometricCancelledError extends Error {
  constructor() {
    super('Cancelado');
    this.name = 'BiometricCancelledError';
  }
}

/** El dispositivo o el navegador no admiten llaves de acceso con PRF. */
export class BiometricUnsupportedError extends Error {
  constructor() {
    super('Este dispositivo no permite usar el desbloqueo biométrico con apps web');
    this.name = 'BiometricUnsupportedError';
  }
}

/** Textos e icono según el dispositivo: «Face ID» en iPhone, «huella» en el resto. */
export const biometricTexts = () => (pwa.isIOS
  ? { title: 'Face ID', name: 'Face ID', use: 'Face ID', with: 'con Face ID', enabled: 'Face ID activado', disabled: 'Face ID desactivado', icon: 'face-id' }
  : { title: 'Huella', name: 'huella', use: 'la huella', with: 'con tu huella', enabled: 'Huella activada', disabled: 'Huella desactivada', icon: 'fingerprint' });

/** ¿Merece la pena ofrecerlo? (hay verificación biométrica y, si el navegador lo dice, PRF). */
export async function isBiometricAvailable() {
  try {
    if (!globalThis.PublicKeyCredential || !navigator.credentials?.create) return false;
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
    const capabilities = await PublicKeyCredential.getClientCapabilities?.();
    // Si el navegador no informa, se comprueba de verdad al activarlo.
    return capabilities?.['extension:prf'] !== false;
  } catch {
    return false;
  }
}

const translate = (error) => (error?.name === 'NotAllowedError' || error?.name === 'AbortError' ? new BiometricCancelledError() : error);
const copy = (buffer) => new Uint8Array(buffer.slice(0));
const prfResults = (credential) => credential.getClientExtensionResults?.().prf;

/**
 * Crea la llave de acceso (pide Face ID o la huella). Devuelve { credentialId, salt, secret }.
 * `secret` es null si el dispositivo no lo entrega al crearla: entonces hay que pedirlo con passkeySecret.
 */
export async function createPasskey() {
  const salt = randomBytes(BIO_SALT_BYTES);
  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Nummo' },
        user: { id: randomBytes(16), name: 'Nummo', displayName: 'Nummo' },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (error) {
    throw translate(error);
  }
  const prf = prfResults(credential);
  if (!prf?.enabled) {
    forgetPasskey(new Uint8Array(credential.rawId)); // no sirve: que no quede en el llavero
    throw new BiometricUnsupportedError();
  }
  return { credentialId: new Uint8Array(credential.rawId), salt, secret: prf.results?.first ? copy(prf.results.first) : null };
}

/** Pide Face ID o la huella y devuelve el secreto de la llave para esa sal. */
export async function passkeySecret({ credentialId, salt }) {
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
  } catch (error) {
    throw translate(error);
  }
  const first = prfResults(assertion)?.results?.first;
  if (!first) throw new BiometricUnsupportedError();
  return copy(first);
}

/** Avisa al llavero de que la llave ya no se usa, para que la quite (si el navegador lo permite). */
export function forgetPasskey(credentialId) {
  try {
    const id = toBase64(credentialId).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    PublicKeyCredential.signalUnknownCredential?.({ rpId: location.hostname, credentialId: id })?.catch(() => {});
  } catch {
    // Opcional: si no se puede, la llave se borra a mano en Contraseñas.
  }
}
