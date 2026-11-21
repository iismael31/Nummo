// El «mes» de la app puede empezar otro día que el 1 (p. ej. el de cobro): atajos para las vistas.
// Con el día 24, «Noviembre» va del 24 de noviembre al 23 de diciembre.

import * as store from '../core/store.js';
import { currentPeriodKey, periodBounds, periodOf } from '../core/dates.js';
import { dayMonth } from './format.js';

export const monthStartDay = () => store.getState()?.settings.monthStartDay ?? 1;

/** Mes 'AAAA-MM' de la app en el que estamos hoy. */
export const currentPeriod = () => currentPeriodKey(monthStartDay());

/** Primer y último día de un mes 'AAAA-MM' o de un año 'AAAA' de la app. */
export const periodRange = (key) => periodBounds(key, monthStartDay());

/** Mes de la app de una fecha. */
export const periodOfDate = (iso) => periodOf(iso, monthStartDay());

/** «24 nov – 23 dic», o null si el mes empieza el día 1 (no hace falta decirlo). */
export function periodRangeText(key, startDay = monthStartDay()) {
  if (startDay === 1) return null;
  const { start, end } = periodBounds(key, startDay);
  return `${dayMonth(start)} – ${dayMonth(end)}`;
}
