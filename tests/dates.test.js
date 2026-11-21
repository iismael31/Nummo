import { test, assert } from './runner.js';
import {
  daysInMonth, parseISO, isISODate, isMonthKey, addDays, addMonths, addYears, addMonthKey,
  monthBounds, periodBounds, periodOf, periodStart, currentPeriodKey, diffDays, todayISO, monthKey,
} from '../app/js/core/dates.js';

test('dates: días por mes y años bisiestos', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2100, 2), 28);
  assert.equal(daysInMonth(2000, 2), 29);
  assert.equal(daysInMonth(2026, 12), 31);
});

test('dates: validación de fechas y meses', () => {
  assert.ok(isISODate('2024-02-29'));
  for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '26-01-01', '2026-1-01', '', null, '1969-12-31', '2201-01-01']) {
    assert.ok(!isISODate(bad), `«${bad}»`);
  }
  assert.deepEqual(parseISO('2026-10-05'), { y: 2026, m: 10, d: 5 });
  assert.ok(isMonthKey('2026-10') && !isMonthKey('2026-13') && !isMonthKey('2026-1'));
});

test('dates: sumar días cruzando meses y años', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-03-28', 7), '2026-04-04'); // cambio de hora en marzo: sin efecto
});

test('dates: sumar meses con día de anclaje', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-11-15', 3), '2027-02-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addYears('2024-02-29', 1), '2025-02-28');
  assert.equal(addYears('2024-02-29', 4), '2028-02-29');
});

test('dates: claves de mes, límites y diferencias', () => {
  assert.equal(addMonthKey('2026-01', -1), '2025-12');
  assert.equal(addMonthKey('2026-12', 1), '2027-01');
  assert.equal(addMonthKey('2026-10', -12), '2025-10');
  assert.deepEqual(monthBounds('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.deepEqual(periodBounds('2024'), { start: '2024-01-01', end: '2024-12-31' });
  assert.deepEqual(periodBounds('2024-02'), monthBounds('2024-02'));
  assert.equal(diffDays('2026-01-01', '2026-03-01'), 59);
  assert.equal(diffDays('2026-03-01', '2026-01-01'), -59);
  assert.equal(todayISO(new Date(2026, 9, 5, 23, 59)), '2026-10-05');
  assert.equal(monthKey('2026-10-05'), '2026-10');
});

test('dates: meses que empiezan otro día (día de cobro)', () => {
  assert.deepEqual(periodBounds('2026-11', 24), { start: '2026-11-24', end: '2026-12-23' }, 'noviembre: 24 nov – 23 dic');
  assert.deepEqual(periodBounds('2026-12', 24), { start: '2026-12-24', end: '2027-01-23' }, 'cruza de año');
  assert.deepEqual(periodBounds('2026', 24), { start: '2026-01-24', end: '2027-01-23' }, 'el año son sus 12 meses');
  assert.deepEqual(periodBounds('2026-11', 1), monthBounds('2026-11'), 'con 1, el mes de siempre');
  assert.deepEqual(periodBounds('2200', 1), { start: '2200-01-01', end: '2200-12-31' }, 'también en el último año');
  // Día 31: en febrero empieza el último día y no hay huecos ni solapes.
  assert.equal(periodStart('2027-02', 31), '2027-02-28');
  assert.deepEqual(periodBounds('2027-01', 31), { start: '2027-01-31', end: '2027-02-27' });
  assert.deepEqual(periodBounds('2027-02', 31), { start: '2027-02-28', end: '2027-03-30' });
  assert.equal(periodOf('2026-11-23', 24), '2026-10');
  assert.equal(periodOf('2026-11-24', 24), '2026-11');
  assert.equal(periodOf('2027-01-10', 24), '2026-12');
  assert.equal(periodOf('2027-03-30', 31), '2027-02');
  assert.equal(currentPeriodKey(24, new Date(2026, 10, 21)), '2026-10', 'el 21 de noviembre aún es el mes de octubre');
  assert.equal(currentPeriodKey(1, new Date(2026, 10, 21)), '2026-11');
});
