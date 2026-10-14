import { test, assert } from './runner.js';
import { sampleState } from './fixtures.js';
import * as idb from '../app/js/core/idb.js';
import * as vault from '../app/js/core/vault.js';
import * as store from '../app/js/core/store.js';
import { MIN_ITERATIONS } from '../app/js/core/crypto.js';
import { normalizeData, ValidationError } from '../app/js/core/model.js';
import { computeBalances, summarize, netWorthSeries } from '../app/js/core/finance.js';
import { addDays } from '../app/js/core/dates.js';
import {
  planBoxes, autoBigCount, bigRange, goalRange, chooseBoxes, groupBoxes, piggyStatus, analyzePiggy,
} from '../app/js/core/piggy.js';

const E = 100; // 1 € en céntimos
const isValidation = (e) => e instanceof ValidationError;

/** Generador pseudoaleatorio con semilla (repartos reproducibles en los tests). */
function seeded(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

test('huchas: reparto exacto de las casillas', () => {
  const denominations = [5, 10, 20, 50, 100, 200].map((x) => x * E);
  assert.equal(autoBigCount(10_000 * E, 365, denominations), 6, 'unas 6 casillas de 200 € (≈ 12 %)');
  for (let seed = 1; seed <= 25; seed += 1) {
    const plan = planBoxes({ goal: 10_000 * E, count: 365, denominations, random: seeded(seed) });
    assert.ok(plan, `semilla ${seed}`);
    assert.equal(plan.boxes.length, 365);
    assert.equal(sum(plan.boxes), 10_000 * E, 'suman justo el objetivo');
    assert.ok(plan.boxes.every((b) => denominations.includes(b)), 'solo los importes elegidos');
    assert.equal(plan.boxes.filter((b) => b === 200 * E).length, 6);
  }
  const fixed = planBoxes({ goal: 1000 * E, count: 100, denominations: [2, 5, 10, 20].map((x) => x * E), bigCount: 10, random: seeded(3) });
  assert.equal(fixed.boxes.filter((b) => b === 20 * E).length, 10, 'respeta las casillas grandes pedidas');
  assert.equal(sum(fixed.boxes), 1000 * E);
  const a = planBoxes({ goal: 1000 * E, count: 100, denominations: [2, 5, 10, 20].map((x) => x * E), random: seeded(1) });
  const b = planBoxes({ goal: 1000 * E, count: 100, denominations: [2, 5, 10, 20].map((x) => x * E), random: seeded(2) });
  assert.ok(a.boxes.join() !== b.boxes.join(), '«Otra distribución» da otra');
  // Imposibles: no cabe, o no hay suma exacta.
  assert.equal(planBoxes({ goal: 50_000 * E, count: 52, denominations: [5 * E, 10 * E], random: seeded(1) }), null);
  assert.equal(planBoxes({ goal: 1001 * E, count: 100, denominations: [10 * E, 20 * E], random: seeded(1) }), null, 'con 10 y 20 € no se llega a 1.001 €');
  assert.equal(bigRange(100 * E, 10, [20 * E]), null);
  assert.deepEqual(goalRange(52, [5 * E, 50 * E]), { min: 260 * E, max: 2600 * E });
  assert.equal(planBoxes({ goal: 520 * E, count: 52, denominations: [10 * E], random: seeded(1) }).boxes.length, 52, 'un solo importe');
});

test('huchas: qué casillas tacha cada ingreso', () => {
  const boxes = [20, 5, 20, 10, 2, 20, 5].map((x) => x * E);
  assert.deepEqual(chooseBoxes(boxes, new Set(), 45 * E), { indexes: [0, 2, 1], sum: 45 * E }, 'las más grandes que caben');
  assert.deepEqual(chooseBoxes(boxes, new Set([0, 2, 5]), 13 * E), { indexes: [3, 4], sum: 12 * E }, 'sobra 1 € suelto');
  assert.deepEqual(chooseBoxes(boxes, new Set(), 1 * E), { indexes: [], sum: 0 });
  assert.deepEqual(groupBoxes(boxes, [0, 2, 1]), [{ amount: 20 * E, count: 2 }, { amount: 5 * E, count: 1 }]);
});

test('huchas: análisis como el de un reto de 1.000 € en 91 días', () => {
  const piggy = { id: 'piggyPS5x', name: 'Ps5', goal: 1000 * E, startDate: '2026-09-28', deadline: '2026-12-28', boxes: Array(100).fill(10 * E) };
  const movements = [{ id: 'mov00001', type: 'piggy', piggyId: piggy.id, flow: 'in', amount: 350 * E, boxes: Array.from({ length: 35 }, (_, i) => i), date: '2026-10-05', ts: 1, accountId: null }];
  const status = piggyStatus(piggy, movements);
  assert.equal(status.saved, 350 * E);
  assert.equal(status.paidCount, 35);
  const a = analyzePiggy(piggy, status, '2026-10-11');
  assert.equal(a.totalDays, 91);
  assert.equal(a.expected, 143 * E - 14, 'hoy tocaba llevar unos 143 €');
  assert.equal(a.diff, 350 * E - a.expected, '+207 € sobre el plan');
  assert.equal(a.level, 'ok');
  assert.equal(a.planWeekly, 7692, 'el plan era de 77 €/semana');
  assert.equal(a.daysLeft, 79, 'contando hoy');
  assert.equal(a.neededDaily, 823, 'te bastan 8,23 € al día');
  assert.equal(a.neededWeekly, 5759, '≈ 58 €/semana');
  assert.equal(a.streak, 1);
  assert.ok(a.projection.daysVsDeadline < 0, 'a este ritmo acaba antes de tiempo');

  const late = analyzePiggy(piggy, piggyStatus(piggy, []), '2026-11-20');
  assert.equal(late.level, 'behind');
  assert.equal(analyzePiggy(piggy, piggyStatus(piggy, []), '2027-01-02').level, 'late');

  const tips = analyzePiggy(piggy, status, '2026-10-11', { avgMonthlySaving: 100 * E, monthNet: 300 * E, topCategory: { name: 'Restaurantes', amount: 240 * E } }).tips;
  assert.deepEqual(tips.map((t) => t.kind), ['saving-short', 'month-left', 'cut']);
  assert.equal(tips[2].cut, 24 * E);
});

async function setup(extra = {}) {
  const data = { ...sampleState(), ...extra };
  idb.useDatabase('nummo-test');
  await idb.deleteDatabase();
  idb.useDatabase('nummo-test');
  vault.setIterationsForTests(MIN_ITERATIONS);
  await vault.create('112233', store.allBuckets(data));
  store.setState(data);
}

async function reload() {
  await store.flush();
  vault.lock();
  store.unload();
  assert.equal(store.loadFromBuckets(await vault.unlock('112233')), 0, 'no debe haber datos dañados');
  return store.getState();
}

test('huchas: meter dinero desde una cuenta, suelto, casilla suelta, deshacer y vaciar', async () => {
  await setup();
  const today = '2026-10-11';
  const piggy = store.addPiggy({ name: 'Ps5', goal: 60 * E, deadline: '2026-12-31', boxes: [20, 20, 10, 5, 5].map((x) => x * E) }, today);
  const before = summarize(store.getState());
  const balanceBefore = computeBalances(store.getState()).get('accountAAA');

  store.depositToPiggy(piggy.id, { amount: 33 * E, accountId: 'accountAAA', date: today });
  let info = store.piggyInfo(piggy.id);
  assert.deepEqual([...info.paid.keys()].sort(), [0, 2], '20 + 10');
  assert.equal(info.loose, 3 * E, 'sobran 3 € sueltos');
  assert.equal(computeBalances(store.getState()).get('accountAAA'), balanceBefore - 33 * E, 'sale de la cuenta');
  assert.equal(summarize(store.getState()).netWorth, before.netWorth, 'el patrimonio no cambia: el dinero solo se mueve');

  store.depositToPiggy(piggy.id, { amount: 2 * E, date: today }); // 3 + 2 = 5 € → una casilla de 5
  info = store.piggyInfo(piggy.id);
  assert.equal(info.paidCount, 3);
  assert.equal(info.loose, 0);
  assert.equal(summarize(store.getState()).netWorth, before.netWorth + 2 * E, 'lo metido sin cuenta sí suma');

  assert.throws(() => store.depositToPiggy(piggy.id, { amount: 5 * E, boxes: [0], date: today }), isValidation, 'casilla ya pagada');
  store.depositToPiggy(piggy.id, { amount: 20 * E, boxes: [1], date: today });
  let state = await reload();
  assert.equal(store.piggyInfo(piggy.id).paidCount, 4);

  const undone = store.undoLastPiggyMovement(piggy.id);
  assert.equal(undone.amount, 20 * E);
  assert.equal(store.piggyInfo(piggy.id).paid.has(1), false);
  store.restoreMovement(undone); // «Deshacer» del aviso
  assert.equal(store.piggyInfo(piggy.id).paid.has(1), true);

  const bbbBefore = computeBalances(store.getState()).get('accountBBB');
  store.emptyPiggy(piggy.id, { accountId: 'accountBBB', date: today });
  info = store.piggyInfo(piggy.id);
  assert.ok(info.closed);
  assert.equal(info.saved, 0);
  assert.equal(computeBalances(store.getState()).get('accountBBB'), bbbBefore + 55 * E, 'todo lo metido vuelve a una cuenta');
  assert.throws(() => store.depositToPiggy(piggy.id, { amount: E, date: today }), isValidation, 'ya vaciada');
  state = await reload();
  assert.equal(netWorthSeries(state, '2026-10', 1).at(-1).value, summarize(state).netWorth, 'la serie cuadra con el patrimonio');

  // Borrar la cuenta deja el dinero de la hucha sin cuenta; borrar la hucha, sus movimientos.
  store.deleteAccount('accountAAA');
  assert.equal(store.getState().movements.filter((m) => m.type === 'piggy').length, 4);
  assert.ok(store.getState().movements.filter((m) => m.type === 'piggy').every((m) => m.accountId !== 'accountAAA'));
  store.deletePiggy(piggy.id);
  state = await reload();
  assert.deepEqual(state.piggies, []);
  assert.ok(!state.movements.some((m) => m.type === 'piggy'));
});

test('huchas: datos incoherentes se rechazan y los antiguos ganan el panel de Inicio', () => {
  const piggy = { id: 'piggyAAAA', name: 'Viaje', icon: 'plane', color: 'blue', goal: 30 * E, startDate: '2026-10-01', deadline: '2026-12-01', boxes: [10 * E, 20 * E], order: 0 };
  const base = { id: 'movPig001', date: '2026-10-02', type: 'piggy', piggyId: 'piggyAAAA', accountId: null, note: '' };
  const withMoves = (moves) => ({ ...sampleState(), piggies: [piggy], movements: moves });
  assert.equal(normalizeData(withMoves([{ ...base, flow: 'in', amount: 30 * E, boxes: [0, 1], ts: 1 }])).data.movements.length, 1);
  const bad = [
    [{ ...base, flow: 'in', amount: 10 * E, boxes: [0], ts: 1 }, { ...base, id: 'movPig002', flow: 'in', amount: 10 * E, boxes: [0], ts: 2 }], // casilla pagada dos veces
    [{ ...base, flow: 'in', amount: 5 * E, boxes: [1], ts: 1 }], // 20 € tachados con 5 € metidos
    [{ ...base, flow: 'in', amount: 30 * E, boxes: [], ts: 1 }, { ...base, id: 'movPig002', flow: 'out', amount: 10 * E, boxes: [], ts: 2 }], // vaciar a medias
    [{ ...base, flow: 'in', amount: 10 * E, boxes: [5], ts: 1 }], // casilla que no existe
  ];
  for (const moves of bad) assert.throws(() => normalizeData(withMoves(moves)), isValidation, JSON.stringify(moves));
  const repaired = normalizeData(withMoves(bad[0]), { strict: false });
  assert.equal(repaired.dropped, 1, 'al cargar los datos propios se descarta solo lo incoherente');
  assert.throws(() => normalizeData({ ...withMoves([]), piggies: [{ ...piggy, boxes: [10 * E] }] }), isValidation, 'las casillas deben sumar el objetivo');
  assert.throws(() => normalizeData({ ...withMoves([]), recurring: [{ id: 'recPig001', frequency: 'weekly', startDate: '2026-10-01', template: { ...base, flow: 'in', amount: E } }] }), isValidation, 'no se programan');

  const v2 = { ...sampleState(), version: 2, settings: { ...sampleState().settings, homePanels: ['networth', 'budgets', 'recent'] } };
  assert.deepEqual(normalizeData(v2).data.settings.homePanels, ['networth', 'budgets', 'piggies', 'recent']);
});
