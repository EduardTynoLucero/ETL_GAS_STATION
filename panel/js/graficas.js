// Gráficas con Apache ECharts. Reglas: color fijo por producto (no por posición), barras delgadas con
// la punta redondeada, líneas de 2 px, un solo eje de valores, leyenda con 2 o más series,
// tooltip en todas y una vista de tabla por cada gráfica.
import { el, escapar, ICONOS } from './util.js';

const FUENTE = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const css = (nombre) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();

export function colores() {
  return {
    superficie: css('--superficie'),
    superficie2: css('--superficie-2'),
    tinta: css('--tinta'),
    tinta2: css('--tinta-2'),
    tinta3: css('--tinta-3'),
    ejes: css('--tinta-ejes'),
    rejilla: css('--rejilla'),
    base: css('--base'),
    borde: css('--borde-fuerte'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => css(`--s${i}`)),
    otro: css('--s-otro'),
    total: css('--s7'),
    secuencial: [1, 2, 3, 4, 5].map((i) => css(`--sec-${i}`)),
    bueno: css('--bueno'),
    critico: css('--critico'),
    aviso: css('--aviso'),
  };
}

// ---------------------------------------------------------------------------------------------
// Productos: siempre el mismo color y el mismo orden, aunque un filtro deje menos productos

const ORDEN = ['DIESEL', 'REGULAR', 'SUPER'];
const extras = [];
const posicion = (nombre) => {
  if (nombre === 'SIN PRODUCTO') return 99;
  const i = ORDEN.indexOf(nombre);
  if (i >= 0) return i;
  if (!extras.includes(nombre)) extras.push(nombre);
  return ORDEN.length + extras.indexOf(nombre);
};

// Un producto nuevo toma el siguiente color de la paleta (sin el amarillo, que junto al naranja
// no se distingue bien); a partir del sexto se juntan en gris
const COLOR_POR_POSICION = [0, 1, 2, 4, 5];
/** Índice en la paleta de series (0 = --s1), o null si va en gris */
const indiceColor = (nombre) => (nombre === 'SIN PRODUCTO' ? null : (COLOR_POR_POSICION[posicion(nombre)] ?? null));

export function colorProducto(nombre, c = colores()) {
  const i = indiceColor(nombre);
  return i === null ? c.otro : c.series[i];
}

/** El mismo color como variable CSS ('var(--s1)'), para el HTML de las tablas: cambia solo con el tema */
export function varProducto(nombre) {
  const i = indiceColor(nombre);
  return i === null ? 'var(--s-otro)' : `var(--s${i + 1})`;
}

export const ordenarProductos = (lista) => [...new Set(lista)].sort((a, b) => posicion(a) - posicion(b) || a.localeCompare(b));

/** Filas (x, producto, medida) -> categorías del eje x y una serie por producto */
export function pivotar(filas, claveX, medida, ordenX = (a, b) => (a < b ? -1 : a > b ? 1 : 0)) {
  const categorias = [...new Set(filas.map((f) => f[claveX]))].sort(ordenX);
  const productos = ordenarProductos(filas.map((f) => f.producto));
  const indice = new Map(categorias.map((x, i) => [x, i]));
  const series = productos.map((p) => ({ nombre: p, valores: categorias.map(() => 0) }));
  const porNombre = new Map(series.map((s) => [s.nombre, s]));
  for (const f of filas) porNombre.get(f.producto).valores[indice.get(f[claveX])] += f[medida] ?? 0;
  return { categorias, series };
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida: cada gráfica se redibuja al cambiar el tema y se ajusta al tamaño de su caja

const vivas = new Set();

export class Grafica {
  constructor(div) {
    liberarQuitadas();
    this.div = div;
    this.chart = window.echarts.init(div, null, { renderer: 'canvas' });
    this.construir = null;
    this.segunAncho = null;
    this.claveAncho = null;
    this.estuvoEnPagina = false;
    this.observador = new ResizeObserver(() => {
      if (div.isConnected) this.estuvoEnPagina = true;
      this.chart.resize();
      // Si cambió lo que depende del ancho (marcas del eje, espacio para los nombres), se vuelve a armar
      if (this.segunAncho && this.segunAncho(this.chart.getWidth()) !== this.claveAncho) this.redibujar();
    });
    this.observador.observe(div);
    vivas.add(this);
  }
  /** construir(c, ancho) arma las opciones; segunAncho(ancho), si se da, resume lo que depende del ancho */
  dibujar(construir, segunAncho = null) {
    this.construir = construir;
    this.segunAncho = segunAncho;
    this.redibujar();
  }
  redibujar() {
    if (!this.construir) return;
    // Ancho 0: la gráfica todavía no está en la página (o está oculta); se redibuja al aparecer
    const ancho = this.chart.getWidth();
    this.claveAncho = this.segunAncho ? this.segunAncho(ancho) : null;
    this.chart.setOption(this.construir(colores(), ancho), { notMerge: true });
  }
  vacio(mensaje) {
    this.dibujar((c) => ({
      graphic: { type: 'text', left: 'center', top: 'middle', style: { text: mensaje, fill: c.tinta3, fontSize: 14, fontFamily: FUENTE } },
    }));
  }
  destruir() {
    vivas.delete(this);
    this.observador.disconnect();
    this.chart.dispose();
  }
}

/** Libera las gráficas que ya se quitaron de la página (otra vista previa, otro filtro) */
function liberarQuitadas() {
  for (const g of [...vivas]) if (g.estuvoEnPagina && !g.div.isConnected) g.destruir();
}

export function redibujarTodas() {
  liberarQuitadas();
  for (const g of vivas) g.redibujar();
}

// ---------------------------------------------------------------------------------------------
// Piezas comunes

export function htmlTooltip(titulo, filas, nota) {
  const renglones = filas
    .map(
      (f) =>
        `<div class="tt-r">${f.color ? `<span class="tt-p" style="background:${f.color}"></span>` : ''}<span>${escapar(f.nombre)}</span><b>${escapar(f.valor)}</b></div>`,
    )
    .join('');
  return `<div class="tt"><div class="tt-t">${escapar(titulo)}</div>${renglones}${nota ? `<div class="tt-n">${escapar(nota)}</div>` : ''}</div>`;
}

const tooltip = (c, extra = {}) => ({
  backgroundColor: c.superficie,
  borderColor: c.borde,
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: c.tinta, fontSize: 13, fontFamily: FUENTE },
  extraCssText: 'border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.14);',
  confine: true,
  ...extra,
});

const leyenda = (c, nombres) =>
  nombres.length >= 2
    ? {
        type: 'scroll',
        top: 0,
        left: 0,
        icon: 'roundRect',
        itemWidth: 12,
        itemHeight: 12,
        itemGap: 16,
        textStyle: { color: c.tinta2, fontSize: 13, fontFamily: FUENTE },
        data: nombres,
      }
    : { show: false };

/** Junta las opciones de un eje con las extra sin perder lo anidado que no se menciona (axisLabel.formatter, etc.) */
const unir = (base, extra) => {
  const r = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const anidado = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object';
    r[k] = anidado ? { ...base[k], ...v } : v;
  }
  return r;
};

const ejeCategoria = (c, datos, formato, extra = {}) =>
  unir(
    {
      type: 'category',
      data: datos,
      axisLine: { lineStyle: { color: c.base } },
      axisTick: { show: false },
      axisLabel: { color: c.ejes, fontSize: 12, fontFamily: FUENTE, formatter: formato, hideOverlap: true },
    },
    extra,
  );

const ejeValor = (c, formato, extra = {}) =>
  unir(
    {
      type: 'value',
      splitLine: { lineStyle: { color: c.rejilla } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: c.ejes, fontSize: 12, fontFamily: FUENTE, formatter: formato, hideOverlap: true },
    },
    extra,
  );

// Ancho de un texto con la fuente de las gráficas, para reservar el espacio de las etiquetas
let lienzo = null;
const anchoTexto = (texto, tamano = 12) => {
  lienzo ??= document.createElement('canvas').getContext('2d');
  lienzo.font = `${tamano}px ${FUENTE}`;
  return lienzo.measureText(String(texto)).width;
};
const anchoMayor = (textos, tamano) => Math.ceil(Math.max(0, ...textos.map((t) => anchoTexto(t, tamano))));

// Marcas de un eje de valores horizontal. ECharts elige el paso solo por el número de marcas y
// después redondea el máximo (10.3 k -> 15 k), así que las etiquetas pueden quedar pegadas
// ('5 k gal10 k gal'); hideOverlap solo oculta las que se cruzan. Aquí se busca el paso redondo
// (1, 2, 2.5 o 5 por una potencia de 10) más chico con el que las etiquetas, medidas con la fuente de
// la gráfica, quedan al menos a SEPARACION px una de otra en el ancho del área de las barras.
const SEPARACION = 12;
function marcasEje(valores, formato, area) {
  const minimo = Math.min(0, ...valores);
  const maximo = Math.max(0, ...valores);
  const rango = maximo - minimo;
  if (!(rango > 0) || !(area > 0)) return null;
  const limpio = (v) => Number(v.toPrecision(12));
  const pasos = [];
  // Desde unas 5 divisiones para abajo: en las gráficas anchas el eje no se llena de marcas
  for (let e = Math.floor(Math.log10(rango / 5)); pasos.length < 12; e++) {
    // Con 2.5 por debajo de 1 saldrían marcas de dos decimales ('Q0.25') que los formatos cortos redondean
    for (const m of e < 0 ? [1, 2, 5] : [1, 2, 2.5, 5]) if (m * 10 ** e >= rango / 5) pasos.push(limpio(m * 10 ** e));
  }
  let eje = null;
  for (const paso of pasos) {
    const min = limpio(Math.floor(minimo / paso + 1e-9) * paso);
    const max = limpio(Math.ceil(maximo / paso - 1e-9) * paso);
    const n = Math.round((max - min) / paso);
    const etiquetas = Array.from({ length: n + 1 }, (_, i) => formato(limpio(min + i * paso)));
    // Dos marcas con el mismo texto: el formato no alcanza a distinguirlas, se prueba un paso mayor
    if (etiquetas.some((t, i) => i > 0 && t === etiquetas[i - 1])) continue;
    eje = { paso, min, max };
    const anchos = etiquetas.map((t) => anchoTexto(t));
    const espacio = (area * paso) / (max - min);
    if (anchos.every((w, i) => i === 0 || espacio - (w + anchos[i - 1]) / 2 >= SEPARACION)) return eje;
    // Con un paso del tamaño del rango ya no hay menos marcas posibles: si ni así caben (gráfica muy
    // angosta), se quita la etiqueta del mínimo (el 0, donde empiezan las barras) y queda la del máximo
    if (paso >= rango) return { ...eje, apretado: true };
  }
  return eje;
}

const base = (c) => ({
  backgroundColor: 'transparent',
  textStyle: { fontFamily: FUENTE, color: c.tinta2 },
  animationDuration: 250,
  animationDurationUpdate: 250,
});

// ---------------------------------------------------------------------------------------------
// Barras apiladas (por producto)

/**
 * @param {Grafica} g
 * @param {{categorias: any[], series: {nombre: string, valores: number[], color?: string}[], formato: (n:number)=>string,
 *          formatoEje?: (n:number)=>string, etiqueta?: (x:any)=>string, titulo?: (x:any, i:number)=>string, nota?: (i:number)=>string|null,
 *          colorDe?: (nombre:string, c:object)=>string}} o
 */
export function barrasApiladas(g, o) {
  if (!o.categorias.length) return g.vacio('Sin datos para este filtro');
  g.dibujar((c) => {
    const colorDe = (s) => s.color ?? (o.colorDe ?? colorProducto)(s.nombre, c);
    // Punta redondeada solo en el segmento de arriba de cada barra
    const arriba = o.categorias.map((_, i) => {
      for (let k = o.series.length - 1; k >= 0; k--) if (o.series[k].valores[i] > 0) return k;
      return -1;
    });
    return {
      ...base(c),
      grid: { left: 4, right: 12, top: o.series.length >= 2 ? 40 : 16, bottom: 4, containLabel: true },
      legend: leyenda(c, o.series.map((s) => s.nombre)),
      tooltip: tooltip(c, {
        trigger: 'axis',
        // La sombra del día señalado va detrás de las barras (z 1; las barras van en z 2)
        axisPointer: { type: 'shadow', z: 1, shadowStyle: { color: c.rejilla, opacity: 0.5 } },
        formatter: (ps) => {
          const i = ps[0].dataIndex;
          const filas = [...ps]
            .reverse()
            .filter((p) => (p.value ?? 0) !== 0)
            .map((p) => ({ color: colorDe(o.series[p.seriesIndex]), nombre: p.seriesName, valor: o.formato(p.value) }));
          const total = o.series.reduce((a, s) => a + (s.valores[i] ?? 0), 0);
          if (o.series.length > 1) filas.push({ nombre: 'Total', valor: o.formato(total) });
          return htmlTooltip(o.titulo ? o.titulo(o.categorias[i], i) : String(o.categorias[i]), filas, o.nota?.(i));
        },
      }),
      xAxis: ejeCategoria(c, o.categorias, o.etiqueta),
      yAxis: ejeValor(c, o.formatoEje ?? o.formato),
      series: o.series.map((s, k) => ({
        name: s.nombre,
        type: 'bar',
        stack: 'total',
        barMaxWidth: 24,
        color: colorDe(s),
        itemStyle: { borderColor: c.superficie, borderWidth: 1 },
        // El tooltip ya lista todos los productos del día: al pasar el mouse no se apaga ninguno
        emphasis: { focus: 'none' },
        data: s.valores.map((v, i) => (arriba[i] === k ? { value: v, itemStyle: { borderRadius: [4, 4, 0, 0] } } : v)),
      })),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Barras horizontales: una medida por categoría (productos, tipo de facturación, clientes)

/**
 * @param {Grafica} g
 * @param {{categorias: string[], valores: number[], formato: (n:number)=>string, formatoEje?: (n:number)=>string,
 *          colorDe?: (categoria:string, i:number, c:object)=>string|null|undefined,
 *          etiqueta?: (i:number)=>string, nota?: (i:number)=>string|null, nombreMedida?: string, anchoEtiqueta?: number}} o
 */
export function barrasHorizontales(g, o) {
  if (!o.categorias.length) return g.vacio('Sin datos para este filtro');
  const limite = o.anchoEtiqueta ?? 28;
  const recortar = (v) => (v.length > limite ? `${v.slice(0, limite - 1)}…` : v);
  const textos = o.valores.map((v, i) => (o.etiqueta ? o.etiqueta(i) : o.formato(v)));
  const formatoEje = o.formatoEje ?? o.formato;
  // A la derecha se reserva el ancho de la etiqueta más larga, medida con la misma fuente: así siempre
  // cabe y el eje no se infla (termina en una marca redonda)
  const derecha = anchoMayor(textos) + 12;
  const anchoNombres = anchoMayor(o.categorias.map(recortar));
  // Los nombres no pasan del 40 % del ancho; el resto (menos los 4 px de la izquierda y los 8 entre
  // nombres y barras) es el área de las barras, y de ella sale el paso del eje
  const medidas = (ancho) => {
    const nombres = ancho > 0 ? Math.min(anchoNombres, Math.floor(ancho * 0.4)) : anchoNombres;
    return { nombres, eje: marcasEje(o.valores, formatoEje, ancho - 4 - nombres - 8 - derecha) };
  };
  const clave = (ancho) => {
    const m = medidas(ancho);
    return `${m.nombres}|${m.eje?.paso}|${m.eje?.apretado}`;
  };
  g.dibujar((c, ancho) => {
    const { nombres, eje } = medidas(ancho);
    // El color se pide con los colores del tema vigente, para que cambie con el tema.
    const color = (i) => o.colorDe?.(o.categorias[i], i, c) ?? c.total;
    return {
      ...base(c),
      grid: { left: 4, right: derecha, top: 4, bottom: 4, containLabel: true },
      tooltip: tooltip(c, {
        trigger: 'item',
        formatter: (p) =>
          htmlTooltip(o.categorias[p.dataIndex], [{ color: p.color, nombre: o.nombreMedida ?? 'Valor', valor: o.formato(p.value) }], o.nota?.(p.dataIndex)),
      }),
      xAxis: ejeValor(
        c,
        formatoEje,
        eje ? { min: eje.min, max: eje.max, interval: eje.paso, ...(eje.apretado ? { axisLabel: { showMinLabel: false } } : {}) } : { splitNumber: 3 },
      ),
      yAxis: ejeCategoria(c, o.categorias, recortar, {
        inverse: true,
        axisLabel: {
          color: c.tinta2,
          hideOverlap: false,
          // Solo si los nombres no caben en su 40 % se cortan a lo ancho, con '…'
          ...(nombres < anchoNombres ? { width: nombres, overflow: 'truncate', ellipsis: '…' } : {}),
        },
      }),
      series: [
        {
          type: 'bar',
          barMaxWidth: 22,
          data: o.valores.map((v, i) => ({
            value: v,
            itemStyle: { color: color(i), borderRadius: [0, 4, 4, 0] },
          })),
          label: {
            show: true,
            position: 'right',
            color: c.tinta2,
            fontSize: 12,
            fontFamily: FUENTE,
            formatter: (p) => textos[p.dataIndex],
          },
        },
      ],
    };
  }, clave);
}

// ---------------------------------------------------------------------------------------------
// Líneas (por producto), con crosshair

export function lineas(g, o) {
  if (!o.categorias.length) return g.vacio('Sin datos para este filtro');
  g.dibujar((c) => ({
    ...base(c),
    grid: { left: 4, right: 76, top: o.series.length >= 2 ? 40 : 16, bottom: 4, containLabel: true },
    // Las etiquetas al final de cada línea no se encimen
    labelLayout: { moveOverlap: 'shiftY' },
    legend: leyenda(c, o.series.map((s) => s.nombre)),
    tooltip: tooltip(c, {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: c.base, width: 1 } },
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const filas = ps
          .filter((p) => p.value !== null && p.value !== undefined)
          .map((p) => ({ color: colorProducto(p.seriesName, c), nombre: p.seriesName, valor: o.formato(p.value) }));
        return htmlTooltip(o.titulo ? o.titulo(o.categorias[i]) : String(o.categorias[i]), filas, o.nota?.(i));
      },
    }),
    xAxis: ejeCategoria(c, o.categorias, o.etiqueta, { boundaryGap: false }),
    yAxis: ejeValor(c, o.formatoEje ?? o.formato, { scale: true }),
    series: o.series.map((s) => ({
      name: s.nombre,
      type: 'line',
      color: colorProducto(s.nombre, c),
      lineStyle: { width: 2 },
      symbol: 'circle',
      symbolSize: 8,
      showSymbol: false,
      itemStyle: { borderColor: c.superficie, borderWidth: 2 },
      emphasis: { focus: 'none' },
      connectNulls: false,
      endLabel: { show: true, color: c.tinta2, fontSize: 12, fontFamily: FUENTE, formatter: (p) => p.seriesName },
      data: s.valores,
    })),
  }));
}

// ---------------------------------------------------------------------------------------------
// Cascada (waterfall): un saldo que sube y baja paso a paso. Los pasos 'total' van del cero al saldo
// (existencia); 'sube' y 'baja' flotan entre el saldo de antes y el de después. Se dibuja con barras
// propias (serie custom) para que un saldo negativo también se vea bien. Una serie por tipo de paso: así
// la leyenda dice qué es cada color y el color nunca va solo (el tooltip lo nombra).

/**
 * 'ajuste' es un paso que puede subir o bajar (por ejemplo, la diferencia contra una toma física); solo sale
 * en la leyenda si algún paso lo usa.
 * @param {Grafica} g
 * @param {{pasos: {etiqueta: string, titulo: string, tipo: 'total'|'sube'|'baja'|'ajuste', antes: number, despues: number, nota?: string}[],
 *          nombres: {total: string, sube: string, baja: string, ajuste?: string}, colorTotal?: (c:object)=>string,
 *          formato: (n:number)=>string, formatoEje?: (n:number)=>string}} o
 */
export function cascada(g, o) {
  if (!o.pasos.length) return g.vacio('Sin datos para este filtro');
  const TIPOS = ['total', 'sube', 'baja', 'ajuste'].filter((t) => t !== 'ajuste' || o.pasos.some((p) => p.tipo === 'ajuste'));
  g.dibujar((c) => {
    const color = { total: o.colorTotal?.(c) ?? c.total, sube: c.bueno, baja: c.critico, ajuste: c.aviso };
    // Valor de cada paso: [índice, desde, hasta]
    const extremos = (p) => (p.tipo === 'total' ? [0, p.despues] : [p.antes, p.despues]);
    const dibujarBarra = (params, api) => {
      // Este paso es de otra serie
      if (!Number.isFinite(api.value(1))) return null;
      const i = api.value(0);
      const [x, y1] = api.coord([i, api.value(1)]);
      const [, y2] = api.coord([i, api.value(2)]);
      const ancho = Math.min(24, api.size([1, 0])[0] * 0.6);
      // Un paso de cero galones se ve como una raya, para que no desaparezca
      const alto = Math.max(1, Math.abs(y2 - y1));
      return {
        type: 'rect',
        shape: { x: x - ancho / 2, y: Math.min(y1, y2), width: ancho, height: alto, r: 2 },
        style: { fill: api.visual('color'), stroke: c.superficie, lineWidth: 1 },
      };
    };
    return {
      ...base(c),
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      legend: leyenda(c, TIPOS.map((t) => o.nombres[t])),
      tooltip: tooltip(c, {
        trigger: 'axis',
        axisPointer: { type: 'shadow', z: 1, shadowStyle: { color: c.rejilla, opacity: 0.5 } },
        formatter: (ps) => {
          const p = o.pasos[ps[0].dataIndex];
          const filas =
            p.tipo === 'total'
              ? [{ color: color.total, nombre: o.nombres.total, valor: o.formato(p.despues) }]
              : [
                  { nombre: 'Antes', valor: o.formato(p.antes) },
                  { color: color[p.tipo], nombre: o.nombres[p.tipo], valor: `${p.despues >= p.antes ? '+' : '−'}${o.formato(Math.abs(p.despues - p.antes))}` },
                  { nombre: 'Después', valor: o.formato(p.despues) },
                ];
          return htmlTooltip(p.titulo, filas, p.nota);
        },
      }),
      xAxis: ejeCategoria(c, o.pasos.map((p) => p.etiqueta)),
      // Sin scale: el eje empieza en cero, como las barras de existencia
      yAxis: ejeValor(c, o.formatoEje ?? o.formato),
      series: TIPOS.map((tipo) => ({
        name: o.nombres[tipo],
        type: 'custom',
        color: color[tipo],
        renderItem: dibujarBarra,
        encode: { x: 0, y: [1, 2] },
        // Solo los pasos de este tipo; los demás quedan vacíos en esta serie
        data: o.pasos.map((p, i) => (p.tipo === tipo ? [i, ...extremos(p)] : [i, null, null])),
      })),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Medidor de porcentaje con semáforo (nivel de un tanque). El arco va de 0 a 100 % con bandas: rojo hasta
// el nivel urgente, amarillo hasta el de pedir pronto, verde hasta el llenado máximo y gris arriba (ahí ya no
// cabe una descarga). La aguja y el número dicen el nivel; el texto de abajo, los galones.

/**
 * @param {Grafica} g
 * @param {{porcentaje: number|null, umbrales: {urgente: number, pronto: number, llenado: number}|null,
 *          texto: string, colorAguja?: (c:object)=>string}} o
 */
export function medidor(g, o) {
  if (o.porcentaje === null || !o.umbrales) return g.vacio(o.texto || 'Sin datos');
  const valor = Math.max(0, Math.min(100, o.porcentaje));
  g.dibujar((c) => {
    const u = o.umbrales;
    const corte = (n) => Math.max(0, Math.min(1, n / 100));
    const bandas = [
      [corte(u.urgente), c.critico],
      [Math.max(corte(u.urgente), corte(u.pronto)), c.aviso],
      [Math.max(corte(u.pronto), corte(u.llenado)), c.bueno],
      [1, c.otro],
    ];
    return {
      ...base(c),
      series: [
        {
          type: 'gauge',
          min: 0,
          max: 100,
          startAngle: 200,
          endAngle: -20,
          radius: '92%',
          center: ['50%', '58%'],
          splitNumber: 4,
          axisLine: { lineStyle: { width: 14, color: bandas } },
          pointer: { width: 5, length: '62%', itemStyle: { color: o.colorAguja?.(c) ?? c.tinta } },
          anchor: { show: true, size: 10, itemStyle: { color: c.superficie, borderColor: o.colorAguja?.(c) ?? c.tinta, borderWidth: 3 } },
          axisTick: { distance: -14, length: 4, lineStyle: { color: c.superficie, width: 1 } },
          splitLine: { distance: -14, length: 14, lineStyle: { color: c.superficie, width: 2 } },
          axisLabel: { distance: 18, color: c.ejes, fontSize: 11, fontFamily: FUENTE, formatter: (v) => `${v}%` },
          title: { offsetCenter: [0, '78%'], color: c.tinta2, fontSize: 12, fontFamily: FUENTE },
          detail: {
            valueAnimation: true,
            offsetCenter: [0, '42%'],
            color: c.tinta,
            fontSize: 22,
            fontWeight: 600,
            fontFamily: FUENTE,
            formatter: () => `${o.porcentaje.toFixed(1)}%`,
          },
          data: [{ value: valor, name: o.texto }],
        },
      ],
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Mapa de calor día de la semana x hora (secuencial de un solo tono)

export function mapaCalor(g, o) {
  if (!o.datos.length) return g.vacio('Sin datos para este filtro');
  const maximo = Math.max(...o.datos.map((d) => d[2]), 1);
  // La escala dice sus extremos con números (el formato de la medida) y se acorta si no caben
  const textoMax = o.formato(maximo);
  const textoMin = o.formato(0);
  const espacioTextos = anchoMayor([textoMax]) + anchoMayor([textoMin]) + 2 * 8 + 24;
  const largo = (ancho) => (ancho > 0 ? Math.max(60, Math.min(160, ancho - espacioTextos)) : 160);
  g.dibujar((c, ancho) => ({
    ...base(c),
    grid: { left: 4, right: 8, top: 8, bottom: 48, containLabel: true },
    tooltip: tooltip(c, {
      trigger: 'item',
      formatter: (p) =>
        htmlTooltip(`${o.y[p.value[1]]} ${o.x[p.value[0]]}`, [{ nombre: o.nombreMedida, valor: o.formato(p.value[2]) }], o.nota?.(p.value)),
    }),
    xAxis: ejeCategoria(c, o.x, (v) => v.slice(0, 2), { splitArea: { show: false } }),
    yAxis: ejeCategoria(c, o.y, undefined, { inverse: true, axisLine: { show: false } }),
    visualMap: {
      min: 0,
      max: maximo,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 12,
      itemHeight: largo(ancho),
      text: [textoMax, textoMin],
      textGap: 8,
      textStyle: { color: c.tinta2, fontSize: 12, fontFamily: FUENTE },
      inRange: { color: c.secuencial },
    },
    series: [
      {
        type: 'heatmap',
        data: o.datos,
        itemStyle: { borderColor: c.superficie, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: c.tinta, borderWidth: 1 } },
      },
    ],
  }), largo);
}

// ---------------------------------------------------------------------------------------------
// Tarjeta con gráfica y su vista de tabla

/**
 * @returns {{el: HTMLElement, grafica: Grafica, controles: HTMLElement, ponerTabla: (html: string) => void, titulo: HTMLElement}}
 */
export function tarjeta({ titulo, subtitulo = '', alto = 300, clase = 'col-12', controles = '' }) {
  const t = el('article', { class: `tarjeta ${clase}` });
  t.innerHTML = `
    <div class="tarjeta-cabeza">
      <div><h3>${escapar(titulo)}</h3>${subtitulo ? `<p class="tarjeta-sub">${escapar(subtitulo)}</p>` : ''}</div>
      <div class="tarjeta-controles">${controles}<button type="button" class="boton boton-chico" data-alternar aria-pressed="false">${ICONOS.tabla}<span>Ver tabla</span></button></div>
    </div>
    <div class="grafica" role="img" aria-label="${escapar(titulo)}"></div>
    <div class="tabla-grafica" hidden></div>`;
  const divGrafica = t.querySelector('.grafica');
  divGrafica.style.height = `${alto}px`;
  const divTabla = t.querySelector('.tabla-grafica');
  const boton = t.querySelector('[data-alternar]');
  const grafica = new Grafica(divGrafica);
  boton.addEventListener('click', () => {
    const verTabla = boton.getAttribute('aria-pressed') !== 'true';
    boton.setAttribute('aria-pressed', String(verTabla));
    boton.innerHTML = verTabla ? `${ICONOS.grafica}<span>Ver gráfica</span>` : `${ICONOS.tabla}<span>Ver tabla</span>`;
    divGrafica.hidden = verTabla;
    divTabla.hidden = !verTabla;
    if (!verTabla) grafica.chart.resize();
  });
  return {
    el: t,
    grafica,
    controles: t.querySelector('.tarjeta-controles'),
    titulo: t.querySelector('h3'),
    ponerTabla: (h) => (divTabla.innerHTML = h),
  };
}

/**
 * Tabla HTML a partir de columnas. Cada columna: {titulo, valor: (fila)=>texto, der?: true, html?: true, clase?: string}
 * (clase va en el encabezado y en cada celda de la columna, por ejemplo para ocultarla en pantallas angostas)
 */
export function tablaHtml(columnas, filas, { pie = null, vacio = 'Sin datos' } = {}) {
  if (!filas.length) return `<p class="vacio">${escapar(vacio)}</p>`;
  const clases = (col) => escapar([col.der ? 'der' : '', col.clase ?? ''].filter(Boolean).join(' '));
  const celda = (col, f) => {
    const v = col.valor(f);
    return `<td class="${clases(col)}">${col.html ? v : escapar(v)}</td>`;
  };
  const cabeza = columnas.map((col) => `<th class="${clases(col)}" scope="col">${escapar(col.titulo)}</th>`).join('');
  const cuerpo = filas.map((f) => `<tr>${columnas.map((col) => celda(col, f)).join('')}</tr>`).join('');
  const piePagina = pie ? `<tfoot><tr>${columnas.map((col) => celda(col, pie)).join('')}</tr></tfoot>` : '';
  return `<div class="tabla-contenedor"><table class="tabla"><thead><tr>${cabeza}</tr></thead><tbody>${cuerpo}</tbody>${piePagina}</table></div>`;
}

/** Punto de color + nombre, para la columna de producto de las tablas (color: varProducto(nombre), que sigue al tema) */
export const conPunto = (nombre, color) => `<span class="punto" style="background:${color}"></span>${escapar(nombre)}`;

/** Botones segmentados; devuelve el HTML y una función para conectarlos */
export function segmentado(nombre, opciones, actual) {
  return `<div class="segmentado" role="group" aria-label="${escapar(nombre)}" data-segmentado="${escapar(nombre)}">${opciones
    .map((o) => `<button type="button" data-valor="${escapar(o.valor)}" aria-pressed="${o.valor === actual}">${escapar(o.texto)}</button>`)
    .join('')}</div>`;
}

export function conectarSegmentado(contenedor, nombre, alCambiar) {
  const grupo = contenedor.querySelector(`[data-segmentado="${nombre}"]`);
  grupo.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-valor]');
    if (!b) return;
    grupo.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    alCambiar(b.dataset.valor);
  });
}
