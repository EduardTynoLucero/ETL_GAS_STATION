// Nivel actual de los tanques y recomendación de pedido. La existencia sale de la toma física más cercana
// (mart.existencia_en) con las compras y las ventas cargadas; la capacidad y los parámetros de pedido, de
// dw.tanque (versión 1.3.0). La decisión del semáforo está en evaluarTanque, sin base de datos, para probarla.
import type { Cliente } from '../db.js';

export interface ParametrosTanque {
  capacidad_galones: number;
  tiempo_entrega_dias: number;
  dias_seguridad: number;
  nivel_minimo_pct: number;
  llenado_maximo_pct: number;
  multiplo_pedido: number;
  horizonte_dias: number;
  dias_consumo: number;
}

export const PARAMETROS_POR_DEFECTO: Omit<ParametrosTanque, 'capacidad_galones'> = {
  tiempo_entrega_dias: 1,
  dias_seguridad: 1,
  nivel_minimo_pct: 15,
  llenado_maximo_pct: 95,
  multiplo_pedido: 500,
  horizonte_dias: 7,
  dias_consumo: 14,
};

/** Días que se agregan al punto de pedido para avisar con tiempo ("pedir pronto") */
const VENTANA_PRONTO_DIAS = 2;
/** Con menos horas que estas sin ventas cargadas no se estima nada: los datos están al día */
const HORAS_SIN_ESTIMAR = 1;

export type EstadoTanque = 'URGENTE' | 'PRONTO' | 'PROGRAMAR' | 'ESTABLE' | 'REVISAR' | 'SIN_TOMA' | 'SIN_CAPACIDAD';

export interface EntradaTanque {
  /** Existencia con los datos cargados (null si no hay toma física del producto) */
  galonesDatos: number | null;
  /** Horas desde la última venta cargada de la estación hasta ahora */
  horasSinVentas: number | null;
  /** Galones vendidos por día, en promedio */
  consumoDiario: number;
  parametros: ParametrosTanque | null;
  /** Ahora, 'aaaa-mm-dd hh:mm' en hora local */
  ahora: string;
}

export interface Evaluacion {
  estado: EstadoTanque;
  titulo: string;
  recomendacion: string;
  /** Existencia estimada ahora: la de los datos menos lo que se habrá vendido desde la última venta cargada */
  galones: number | null;
  estimado: boolean;
  porcentaje: number | null;
  coberturaDias: number | null;
  /** Cuándo se acaba al ritmo de venta actual */
  agotamiento: string | null;
  /** Cuándo hay que hacer el pedido para que llegue con la reserva de seguridad */
  fechaPedido: string | null;
  diasParaPedir: number | null;
  /** Galones a pedir, en múltiplos del pedido, para llenar hasta el llenado máximo cuando llegue */
  pedidoSugerido: number | null;
  /** Lo que cabe hoy hasta el llenado máximo */
  espacioLibre: number | null;
  /** Porcentajes donde cambia el semáforo: por debajo de urgente es rojo, de pronto amarillo */
  umbrales: { urgente: number; pronto: number; programar: number; llenado: number } | null;
  avisos: string[];
}

const redondear = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const miles = (n: number) => Math.round(n).toLocaleString('en-US');
/** '1 día', '2.5 días' */
const dias = (n: number) => {
  const r = redondear(n);
  return `${r} ${r === 1 ? 'día' : 'días'}`;
};

/** 'aaaa-mm-dd hh:mm' más n días (n puede tener decimales) */
export function sumarDias(momento: string, dias: number): string {
  const d = new Date(`${momento.replace(' ', 'T')}:00Z`);
  const r = new Date(d.getTime() + dias * 86400000);
  return r.toISOString().slice(0, 16).replace('T', ' ');
}

const diaLegible = (momento: string) => {
  const [a, m, d] = momento.slice(0, 10).split('-');
  return `${Number(d)}/${Number(m)}/${a}`;
};

export function evaluarTanque(e: EntradaTanque): Evaluacion {
  const p = e.parametros;
  const vacia: Evaluacion = {
    estado: 'SIN_TOMA',
    titulo: '',
    recomendacion: '',
    galones: null,
    estimado: false,
    porcentaje: null,
    coberturaDias: null,
    agotamiento: null,
    fechaPedido: null,
    diasParaPedir: null,
    pedidoSugerido: null,
    espacioLibre: null,
    umbrales: null,
    avisos: [],
  };
  if (e.galonesDatos === null) {
    return { ...vacia, titulo: 'Sin toma física', recomendacion: 'Registra una toma física de este producto para saber cuánto hay en el tanque.' };
  }

  const avisos: string[] = [];
  const consumo = Math.max(0, e.consumoDiario);
  // Lo vendido desde la última venta cargada todavía no está en la base: se descuenta al ritmo promedio
  const horas = e.horasSinVentas ?? 0;
  const estimado = horas >= HORAS_SIN_ESTIMAR && consumo > 0;
  const galones = estimado ? e.galonesDatos - (consumo * horas) / 24 : e.galonesDatos;
  if (estimado) {
    avisos.push(
      `Las ventas cargadas terminan hace ${horas >= 48 ? dias(horas / 24) : `${redondear(horas)} horas`}: se descontaron unos ${miles((consumo * horas) / 24)} gal al ritmo promedio. Carga la Consulta de Tickets más reciente para el dato exacto.`,
    );
  }
  if (horas >= 72) avisos.push('Hace más de 3 días que no se cargan ventas: la estimación puede estar lejos de lo real.');

  const cobertura = consumo > 0 ? Math.max(0, galones) / consumo : null;
  const agotamiento = cobertura === null ? null : sumarDias(e.ahora, cobertura);
  if (consumo === 0) avisos.push('Sin ventas en los días de consumo: no se puede proyectar cuándo se acaba.');

  if (!p) {
    return {
      ...vacia,
      estado: 'SIN_CAPACIDAD',
      titulo: 'Falta la capacidad',
      recomendacion: 'Escribe la capacidad del tanque en "Configurar tanques" para ver el porcentaje y la recomendación de pedido.',
      galones,
      estimado,
      coberturaDias: cobertura,
      agotamiento,
      avisos,
    };
  }

  const cap = p.capacidad_galones;
  const pct = (100 * galones) / cap;
  const pctDe = (dias: number) => Math.min(100, (100 * consumo * dias) / cap);
  const diasUrgente = p.tiempo_entrega_dias + p.dias_seguridad;
  const umbrales = {
    urgente: Math.max(p.nivel_minimo_pct, pctDe(diasUrgente)),
    pronto: Math.max(p.nivel_minimo_pct, pctDe(diasUrgente + VENTANA_PRONTO_DIAS)),
    programar: Math.max(p.nivel_minimo_pct, pctDe(diasUrgente + p.horizonte_dias)),
    llenado: p.llenado_maximo_pct,
  };
  const llenadoMax = (cap * p.llenado_maximo_pct) / 100;
  const espacioLibre = Math.max(0, llenadoMax - galones);
  const base = { ...vacia, galones, estimado, porcentaje: pct, coberturaDias: cobertura, agotamiento, umbrales, espacioLibre, avisos };

  // Una existencia imposible es casi siempre una toma con la hora equivocada o una compra que no se cargó
  if (galones < 0 || galones > cap * 1.02) {
    return {
      ...base,
      estado: 'REVISAR',
      titulo: 'Revisar existencia',
      recomendacion:
        galones < 0
          ? `La existencia calculada es negativa (${miles(galones)} gal): falta cargar una compra o la última toma física tiene la hora o los galones equivocados.`
          : `La existencia calculada (${miles(galones)} gal) pasa la capacidad de ${miles(cap)} gal: revisa la última toma física, una compra repetida o la capacidad configurada.`,
    };
  }

  /** Pedido para que, al llegar dentro de diasHastaPedido + entrega, se llene hasta el llenado máximo */
  const pedidoPara = (diasHastaPedido: number) => {
    const alLlegar = Math.max(0, galones - consumo * (diasHastaPedido + p.tiempo_entrega_dias));
    return Math.max(0, Math.floor((llenadoMax - alLlegar) / p.multiplo_pedido) * p.multiplo_pedido);
  };
  const textoPedido = (g: number) =>
    g >= p.multiplo_pedido ? `Pedido sugerido: ${miles(g)} gal (llena hasta el ${redondear(p.llenado_maximo_pct, 0)}% al llegar).` : '';
  if (pct > p.llenado_maximo_pct) avisos.push(`Está arriba del llenado máximo (${redondear(p.llenado_maximo_pct, 0)}%): no cabe una descarga.`);

  const llegaCon = cobertura === null ? null : cobertura - p.tiempo_entrega_dias;
  if (pct <= p.nivel_minimo_pct || (cobertura !== null && cobertura <= diasUrgente)) {
    const g = pedidoPara(0);
    const motivo =
      cobertura !== null && cobertura <= p.tiempo_entrega_dias
        ? `Al ritmo actual se acaba el ${diaLegible(agotamiento!)}, antes de que llegue un pedido hecho hoy (${dias(p.tiempo_entrega_dias)} de entrega).`
        : pct <= p.nivel_minimo_pct
          ? `Está en el ${redondear(pct)}%, por debajo del mínimo de ${redondear(p.nivel_minimo_pct, 0)}%.`
          : `Un pedido hecho hoy llega con ${dias(Math.max(0, llegaCon!))} de venta, menos que la reserva de ${dias(p.dias_seguridad)}.`;
    return { ...base, estado: 'URGENTE', titulo: 'Orden urgente', recomendacion: `Pedir hoy. ${motivo} ${textoPedido(g)}`.trim(), fechaPedido: e.ahora, diasParaPedir: 0, pedidoSugerido: g };
  }
  // Cobertura nula (sin ventas) con nivel arriba del mínimo: estable
  if (cobertura === null) {
    return { ...base, estado: 'ESTABLE', titulo: 'Estable', recomendacion: `Sin ventas recientes; ${redondear(pct)}% de ocupación.` };
  }
  const diasParaPedir = cobertura - diasUrgente;
  const fechaPedido = sumarDias(e.ahora, diasParaPedir);
  if (diasParaPedir <= VENTANA_PRONTO_DIAS) {
    const g = pedidoPara(diasParaPedir);
    return {
      ...base,
      estado: 'PRONTO',
      titulo: 'Ordenar pronto',
      recomendacion: `Hacer el pedido a más tardar el ${diaLegible(fechaPedido)} (en ${dias(diasParaPedir)}); se acaba el ${diaLegible(agotamiento!)}. ${textoPedido(g)}`.trim(),
      fechaPedido,
      diasParaPedir,
      pedidoSugerido: g,
    };
  }
  if (diasParaPedir <= p.horizonte_dias) {
    const g = pedidoPara(diasParaPedir);
    return {
      ...base,
      estado: 'PROGRAMAR',
      titulo: `Programar orden en ${Math.floor(diasParaPedir)} días`,
      recomendacion: `Programar el pedido para el ${diaLegible(fechaPedido)}; alcanza para ${dias(cobertura)}. ${textoPedido(g)}`.trim(),
      fechaPedido,
      diasParaPedir,
      pedidoSugerido: g,
    };
  }
  return {
    ...base,
    estado: 'ESTABLE',
    titulo: 'Estable',
    recomendacion: `Alcanza para ${dias(cobertura)}; el próximo pedido sería hacia el ${diaLegible(fechaPedido)}.`,
    fechaPedido,
    diasParaPedir,
  };
}

// ---------------------------------------------------------------------------------------------
// Consultas

async function instalado(c: Cliente): Promise<boolean> {
  const r = await c.query<{ ok: boolean }>(
    `SELECT to_regclass('dw.tanque') IS NOT NULL AND to_regprocedure('mart.existencia_en(int, int, timestamp)') IS NOT NULL AS ok`,
  );
  return r.rows[0]!.ok;
}

/** Ahora en la hora de esta PC (la misma de los tickets: Guatemala), 'aaaa-mm-dd hh:mm' */
function ahoraLocal(): string {
  const d = new Date();
  const dos = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

export async function nivelTanques(c: Cliente, estacion: string) {
  if (!(await instalado(c))) return { instalado: false as const };
  const ahora = ahoraLocal();
  const r = await c.query(
    `WITH e AS (SELECT estacion_key FROM dw.dim_estacion WHERE codigo = $1),
     v AS (SELECT max(f.fecha_hora) AS ultima, min(f.fecha_hora) AS primera
             FROM dw.fact_despacho f WHERE f.estacion_key = (SELECT estacion_key FROM e))
     SELECT p.nombre AS producto,
            t.capacidad_galones::float8, t.tiempo_entrega_dias::float8, t.dias_seguridad::float8, t.nivel_minimo_pct::float8,
            t.llenado_maximo_pct::float8, t.multiplo_pedido::float8, t.horizonte_dias::float8, t.dias_consumo,
            t.actualizado_en, t.actualizado_por,
            x.galones::float8 AS galones_datos,
            to_char(x.toma_fecha_hora, 'YYYY-MM-DD HH24:MI') AS toma_en, x.toma_galones::float8,
            to_char(v.ultima, 'YYYY-MM-DD HH24:MI') AS ultima_venta,
            extract(epoch FROM ($2::timestamp - v.ultima)) / 3600 AS horas_sin_ventas,
            -- Consumo: lo vendido en los últimos dias_consumo días hasta la última venta cargada, entre los días
            -- que de verdad hay datos (si la estación tiene menos historia, se divide entre menos días)
            (SELECT coalesce(sum(f.cantidad_gal), 0)
               FROM dw.fact_despacho f
              WHERE f.estacion_key = (SELECT estacion_key FROM e) AND f.producto_key = p.producto_key
                AND f.fecha_hora > v.ultima - make_interval(days => coalesce(t.dias_consumo, 14)))::float8 AS vendido_ventana,
            greatest(1, least(coalesce(t.dias_consumo, 14), extract(epoch FROM (v.ultima - v.primera)) / 86400))::float8 AS dias_ventana,
            (SELECT to_char(k.fecha_hora, 'YYYY-MM-DD HH24:MI') || '|' || k.cantidad::float8
               FROM dw.fact_compra k
              WHERE k.estacion_key = (SELECT estacion_key FROM e) AND k.producto_key = p.producto_key AND NOT k.anulada
              ORDER BY k.fecha_hora DESC LIMIT 1) AS ultima_compra
       FROM dw.dim_producto p
       CROSS JOIN e CROSS JOIN v
       LEFT JOIN dw.tanque t ON t.estacion_key = e.estacion_key AND t.producto_key = p.producto_key
       LEFT JOIN LATERAL mart.existencia_en(e.estacion_key, p.producto_key, $2::timestamp) x ON true
      WHERE p.familia = 'COMBUSTIBLE'
      ORDER BY p.producto_key`,
    [estacion, ahora],
  );
  const tanques = r.rows.map((f) => {
    const parametros: ParametrosTanque | null = f.capacidad_galones
      ? {
          capacidad_galones: f.capacidad_galones,
          tiempo_entrega_dias: f.tiempo_entrega_dias,
          dias_seguridad: f.dias_seguridad,
          nivel_minimo_pct: f.nivel_minimo_pct,
          llenado_maximo_pct: f.llenado_maximo_pct,
          multiplo_pedido: f.multiplo_pedido,
          horizonte_dias: f.horizonte_dias,
          dias_consumo: f.dias_consumo,
        }
      : null;
    const consumoDiario = f.dias_ventana > 0 ? f.vendido_ventana / f.dias_ventana : 0;
    const [compraEn, compraGal] = f.ultima_compra ? String(f.ultima_compra).split('|') : [null, null];
    return {
      producto: f.producto,
      parametros,
      actualizado: f.actualizado_en ? { en: f.actualizado_en, por: f.actualizado_por } : null,
      galonesDatos: f.galones_datos,
      toma: f.toma_en ? { en: f.toma_en, galones: f.toma_galones } : null,
      ultimaVenta: f.ultima_venta,
      ultimaCompra: compraEn ? { en: compraEn, galones: Number(compraGal) } : null,
      consumoDiario,
      diasConsumo: Math.round(f.dias_ventana ?? 0),
      ...evaluarTanque({
        galonesDatos: f.galones_datos,
        horasSinVentas: f.horas_sin_ventas === null ? null : Math.max(0, Number(f.horas_sin_ventas)),
        consumoDiario,
        parametros,
        ahora,
      }),
    };
  });
  return { instalado: true as const, estacion, ahora, tanques, porDefecto: PARAMETROS_POR_DEFECTO };
}

export class ErrorTanque extends Error {}

export async function guardarTanque(c: Cliente, estacion: string, producto: string, p: ParametrosTanque, usuario?: string) {
  if (!(await instalado(c))) throw new ErrorTanque('La base todavía no tiene la tabla de tanques. Ejecuta sql/actualizar_tanques.sql (o npm run instalar-bd).');
  const r = await c.query(
    `INSERT INTO dw.tanque AS t (estacion_key, producto_key, capacidad_galones, tiempo_entrega_dias, dias_seguridad, nivel_minimo_pct,
                                 llenado_maximo_pct, multiplo_pedido, horizonte_dias, dias_consumo, actualizado_en, actualizado_por)
     SELECT e.estacion_key, p.producto_key, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11
       FROM dw.dim_estacion e, dw.dim_producto p
      WHERE e.codigo = $1 AND e.estacion_key <> -1 AND p.nombre = $2 AND p.familia = 'COMBUSTIBLE'
     ON CONFLICT (estacion_key, producto_key) DO UPDATE
       SET capacidad_galones = EXCLUDED.capacidad_galones, tiempo_entrega_dias = EXCLUDED.tiempo_entrega_dias,
           dias_seguridad = EXCLUDED.dias_seguridad, nivel_minimo_pct = EXCLUDED.nivel_minimo_pct,
           llenado_maximo_pct = EXCLUDED.llenado_maximo_pct, multiplo_pedido = EXCLUDED.multiplo_pedido,
           horizonte_dias = EXCLUDED.horizonte_dias, dias_consumo = EXCLUDED.dias_consumo,
           actualizado_en = now(), actualizado_por = EXCLUDED.actualizado_por`,
    [
      estacion,
      producto,
      p.capacidad_galones,
      p.tiempo_entrega_dias,
      p.dias_seguridad,
      p.nivel_minimo_pct,
      p.llenado_maximo_pct,
      p.multiplo_pedido,
      p.horizonte_dias,
      p.dias_consumo,
      usuario?.trim() || null,
    ],
  );
  if (!r.rowCount) throw new ErrorTanque(`No conozco la estación ${estacion} o el combustible ${producto}.`);
  return { guardado: producto };
}
