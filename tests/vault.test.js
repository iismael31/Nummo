import { test, assert } from './runner.js';
import * as idb from '../app/js/core/idb.js';
import * as vault from '../app/js/core/vault.js';
import { MIN_ITERATIONS } from '../app/js/core/crypto.js';

async function freshVault(pin = '135790') {
  idb.useDatabase('nummo-test');
  await idb.deleteDatabase();
  idb.useDatabase('nummo-test');
  vault.setIterationsForTests(MIN_ITERATIONS);
  await vault.create(pin, new Map([['core', { hola: 'mundo secreto' }], ['mov-2026', { movements: [1, 2] }]]));
}

test('vault: crear, bloquear y desbloquear', async () => {
  assert.equal(await (async () => { idb.useDatabase('nummo-test'); await idb.deleteDatabase(); idb.useDatabase('nummo-test'); return vault.status(); })(), 'new');
  await freshVault();
  assert.ok(vault.isUnlocked());
  assert.equal(await vault.status(), 'locked');
  vault.lock();
  assert.ok(!vault.isUnlocked());
  const buckets = await vault.unlock('135790');
  assert.deepEqual(buckets.get('core'), { hola: 'mundo secreto' });
  assert.deepEqual(buckets.get('mov-2026'), { movements: [1, 2] });
});

test('vault: en el almacenamiento no hay nada legible', async () => {
  await freshVault();
  // 'revision' es una marca aleatoria sin datos (sirve para detectar escrituras de otra ventana).
  const meta = (await idb.entries('meta')).filter(([key]) => key !== 'revision');
  assert.ok(typeof (await idb.get('meta', 'revision')) === 'string');
  const rows = [...(await idb.entries('vault')), ...meta];
  const text = new TextDecoder().decode(new Uint8Array(rows.flatMap(([, v]) => [...(v.ct ?? v.dek?.ct ?? [])])));
  assert.ok(!text.includes('secreto') && !text.includes('mundo'));
  assert.ok(rows.every(([, v]) => v.ct instanceof Uint8Array || v.dek?.ct instanceof Uint8Array));
});

test('vault: PIN incorrecto y bloqueo progresivo tras 5 intentos', async () => {
  await freshVault();
  vault.lock();
  for (let i = 1; i < vault.FREE_ATTEMPTS; i += 1) {
    await assert.rejects(() => vault.unlock('000000'), (e) => e instanceof vault.WrongPinError && e.lockedUntil === 0, `intento ${i}`);
  }
  await assert.rejects(() => vault.unlock('000000'), (e) => e instanceof vault.WrongPinError && e.lockedUntil > Date.now(), 'quinto intento: espera');
  await assert.rejects(() => vault.unlock('135790'), (e) => e instanceof vault.LockedOutError, 'bloqueado incluso con el PIN bueno');
  assert.equal(vault.delayAfter(5), 30_000);
  assert.equal(vault.delayAfter(6), 60_000);
  assert.equal(vault.delayAfter(30), 15 * 60_000, 'máximo 15 minutos');
  // Adelantar la hora del dispositivo no acorta la espera (también se mide con un reloj monotónico).
  await idb.put('meta', 'lockout', { failures: 5, until: Date.now() - 1 });
  await assert.rejects(() => vault.unlock('135790'), (e) => e instanceof vault.LockedOutError, 'cambiar la hora no sirve');
  assert.ok((await vault.getLockout()).until > Date.now(), 'la cuenta atrás sigue a la vista');
  // Simula que ha pasado de verdad el tiempo de espera: el PIN correcto entra y pone el contador a cero.
  vault.expireLockoutForTests();
  await vault.unlock('135790');
  assert.deepEqual(await vault.getLockout(), { failures: 0, until: 0 });
});

test('vault: cambiar el PIN', async () => {
  await freshVault();
  await assert.rejects(() => vault.changePin('999999', '246810'), (e) => e instanceof vault.WrongPinError);
  await idb.put('meta', 'lockout', { failures: 0, until: 0 });
  await vault.changePin('135790', '246810');
  vault.lock();
  await assert.rejects(() => vault.unlock('135790'), (e) => e instanceof vault.WrongPinError, 'el PIN antiguo ya no sirve');
  const buckets = await vault.unlock('246810');
  assert.deepEqual(buckets.get('core'), { hola: 'mundo secreto' }, 'los datos siguen intactos');
});

test('vault: guardar, borrar bloques y destruir', async () => {
  await freshVault();
  await vault.saveBuckets(new Map([['mov-2025', { movements: [9] }], ['mov-2026', null]]));
  vault.lock();
  const buckets = await vault.unlock('135790');
  assert.deepEqual([...buckets.keys()].sort(), ['core', 'mov-2025']);
  await assert.rejects(() => vault.saveBuckets(new Map([['malo', {}]])), null, 'nombre de bloque no permitido');
  await vault.destroy();
  assert.equal(await vault.status(), 'new');
  assert.ok(!vault.isValidPin('12345') && !vault.isValidPin('12345a') && vault.isValidPin('012345'));
});

test('vault: varios intentos de PIN a la vez cuentan todos', async () => {
  await freshVault();
  vault.lock();
  await Promise.allSettled([vault.unlock('000001'), vault.unlock('000002'), vault.unlock('000003')]);
  assert.equal((await vault.getLockout()).failures, 3);
});

test('vault: Face ID o huella abren con el secreto de su llave y el PIN se pide cada 7 días', async () => {
  await freshVault();
  const salt = new Uint8Array(32).fill(7);
  const secret = () => new Uint8Array(32).fill(42); // lo que entregaría la llave de acceso tras Face ID
  await assert.rejects(() => vault.dekForBiometric('000000'), (e) => e instanceof vault.WrongPinError, 'activarlo exige el PIN');
  const dekRaw = await vault.dekForBiometric('135790');
  const given = secret();
  await vault.enableBiometric(dekRaw, { credentialId: new Uint8Array([1, 2, 3]), salt, secret: given });
  assert.ok(dekRaw.every((b) => b === 0) && given.every((b) => b === 0), 'la clave y el secreto en claro se borran de memoria');
  assert.deepEqual(await vault.biometricStatus(), { enabled: true, pinDue: false, credentialId: new Uint8Array([1, 2, 3]), salt });

  vault.lock();
  await assert.rejects(() => vault.unlockWithBiometric(new Uint8Array(32).fill(1)), (e) => e instanceof vault.BiometricError, 'otro secreto no sirve');
  const buckets = await vault.unlockWithBiometric(secret());
  assert.deepEqual(buckets.get('core'), { hola: 'mundo secreto' });

  // Pasados 7 días (o si la hora retrocede) hay que escribir el PIN, que vuelve a contar el plazo.
  for (const pinAt of [Date.now() - vault.PIN_REMINDER_MS - 1, Date.now() + 60_000]) {
    const bio = await idb.get('meta', 'biometric');
    await idb.put('meta', 'biometric', { ...bio, pinAt });
    vault.lock();
    assert.equal((await vault.biometricStatus()).pinDue, true);
    await assert.rejects(() => vault.unlockWithBiometric(secret()), (e) => e instanceof vault.BiometricError);
    await vault.unlock('135790');
    assert.equal((await vault.biometricStatus()).pinDue, false, 'el PIN reinicia el plazo');
  }

  // Cambiar el PIN no lo estropea (la clave de los datos es la misma); desactivarlo lo borra.
  await vault.changePin('135790', '246810');
  vault.lock();
  await vault.unlockWithBiometric(secret());
  await vault.disableBiometric();
  assert.equal((await vault.biometricStatus()).enabled, false);
});
