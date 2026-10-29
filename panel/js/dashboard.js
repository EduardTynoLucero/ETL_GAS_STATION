// Pestaña "Dashboard": indicadores y gráficas sobre lo que ya está cargado en el modelo.
import { bus, conexion, pedir, revisarConexion } from './estado.js';
import {
  barrasApiladas,
  barrasHorizontales,
  colorProducto,
  conectarSegmentado,
  conPunto,
  lineas,
  mapaCalor,
  ordenarProductos,
  pivotar,
  segmentado,
  tablaHtml,
  tarjeta,
  varProducto,
} from './graficas.js';
import { nombreFacturacion, tablaPivote } from './cargar.js';
import { DIAS, diaSemana, escapar, estado, fecha, fechaHora, fmt, ICONOS, nombreRegla, plural, SEVERIDAD } from './util.js';

let raiz;
let opciones = null;
let filtros = {};
let pendiente = true; // hay que volver a consultar el dashboard (primera vez, después de una carga o de un error)
let releerOpciones = true; // hay que volver a pedir /api/opciones (cada vez que se muestra la pestaña)
let barraDe = null; // rango, estaciones y productos con los que se dibujó la barra de filtros
let pedido = 0;
let espera = null; // los filtros se aplican con un respiro, no con cada tecla
let dibujandoBarra = false; // al quitar los controles viejos, un 'blur' no debe aplicar los nuevos vacíos
let fechaEditada = 'desde'; // la última fecha que cambió el usuario: si Desde queda después de Hasta, se mueve la otra

export function iniciar(contenedor) {
  raiz = contenedor;
  raiz.innerHTML = `<div id="dash-filtros"></div><div id="dash-aviso" hidden></div><div id="dash-cuerpo" class="pila"></div>`;
  bus.addEventListener('carga-terminada', () => {
    pendiente = true;
    releerOpciones = true;
    if (!raiz.hidden) cargar();
  });
  // Solo cuando terminó de revisar: el aviso del inicio de la revisión no dispara otra consulta
  bus.addEventListener('conexion', () => {
    if ((pendiente || releerOpciones) && !conexion.revisando && !raiz.hidden) cargar();
  });
}

/** Cada vez que se abre la pestaña se vuelven a pedir las opciones: puede haber cargas hechas desde la consola */
export function mostrar() {
  releerOpciones = true;
  cargar();
}

/** Botón Actualizar: vuelve a leer las opciones y el dashboard aunque nada parezca haber cambiado */
function actualizar() {
  pendiente = true;
  releerOpciones = true;
  cargar();
}

async function cargar() {
  const cuerpo = raiz.querySelector('#dash-cuerpo');
  if (!conexion.datos || conexion.revisando) {
    if (pendiente) cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Revisando la conexión…</div>`;
    return; // se vuelve a intentar cuando llegue el estado de la conexión
  }
  if (!conexion.conectado) {
    pintarSinConexion();
    return;
  }
  const yo = ++pedido;
  try {
    if (releerOpciones || !opciones) {
      if (!opciones) cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Consultando el modelo…</div>`;
      const nuevas = await pedir('/api/opciones');
      if (yo !== pedido) return;
      releerOpciones = false;
      if (ponerOpciones(nuevas)) pendiente = true;
    }
    pintarAvisoVistas();
    if (!opciones.rango.desde) {
      barraDe = null;
      raiz.querySelector('#dash-filtros').innerHTML = '';
      // Con las vistas atrasadas puede haber tickets aunque el resumen esté vacío: basta con el aviso
      cuerpo.innerHTML = opciones.vistasAtrasadas
        ? ''
        : `<div class="tarjeta vacio"><strong>Todavía no hay datos en el modelo</strong>Carga tu primer reporte en la pestaña <a href="#cargar">Cargar reporte</a>.</div>`;
      pendiente = false;
      return;
    }
    if (barraDe !== claveBarra(opciones)) pintarFiltros();
    else sincronizarFiltros();
    if (!pendiente) return;
    cuerpo.innerHTML = `<div class="tarjeta cargando"><span class="girador"></span>Consultando el modelo…</div>`;
    const q = new URLSearchParams();
    for (const k of ['desde', 'hasta', 'estacion', 'producto']) if (filtros[k]) q.set(k, filtros[k]);
    const datos = await pedir(`/api/dashboard?${q}`);
    if (yo !== pedido) return;
    pendiente = false;
    pintar(datos);
  } catch (err) {
    if (yo !== pedido) return;
    pendiente = true;
    cuerpo.innerHTML = `<div class="veredicto veredicto-critico">${ICONOS.critico}<div><h2>No se pudo consultar el dashboard</h2><p>${escapar(err.message)}</p></div>
      <div class="veredicto-acciones"><button type="button" class="boton" id="dash-reintentar">Reintentar</button></div></div>`;
    // Solo se revisa la conexión: al terminar, el aviso de 'conexion' vuelve a consultar (un pedido por clic)
    const boton = cuerpo.querySelector('#dash-reintentar');
    boton.addEventListener('click', () => {
      boton.disabled = true;
      revisarConexion();
    });
  }
}

function pintarSinConexion() {
  pendiente = true;
  releerOpciones = true;
  barraDe = null;
  raiz.querySelector('#dash-filtros').innerHTML = '';
  raiz.querySelector('#dash-aviso').hidden = true;
  raiz.querySelector('#dash-cuerpo').innerHTML = `<div class="tarjeta vacio"><strong>El dashboard necesita la base de datos</strong>${escapar(
    conexion.datos?.error ?? 'Sin conexión.',
  )}<p style="margin-top:12px"><button type="button" class="boton" id="dash-reintentar">Reintentar</button></p></div>`;
  const boton = raiz.querySelector('#dash-reintentar');
  // Igual que arriba: si la conexión vuelve, el aviso de 'conexion' consulta el dashboard una sola vez
  boton.addEventListener('click', () => {
    boton.disabled = true;
    revisarConexion();
  });
}

/** Aviso cuando las vistas de mart no cuadran con los tickets y no se pudieron refrescar */
function pintarAvisoVistas() {
  const aviso = raiz.querySelector('#dash-aviso');
  aviso.hidden = !opciones.vistasAtrasadas;
  if (!opciones.vistasAtrasadas) {
    aviso.innerHTML = '';
    return;
  }
  aviso.innerHTML = `<div class="veredicto veredicto-aviso" role="status">${ICONOS.aviso}<div>
      <h2>Los totales pueden estar atrasados</h2>
      <p>Los indicadores, Ventas por día, Por producto y Utilidad por galón salen de un resumen que no tiene todo lo que hay en la base, y no se pudo poner al día solo. Las demás gráficas leen los tickets directamente: los totales pueden no cuadrar entre sí y el rango de fechas puede no llegar al último día cargado.</p>
      <p class="nota">Presiona Actualizar para intentarlo otra vez. Si sigue igual, quien administra la base puede ejecutar CALL mart.refrescar();${
        opciones.avisoVistas ? ` Detalle: ${escapar(opciones.avisoVistas)}` : ''
      }</p></div>
      <div class="veredicto-acciones"><button type="button" class="boton" id="dash-aviso-actualizar">Actualizar</button></div></div>`;
  aviso.querySelector('#dash-aviso-actualizar').addEventListener('click', actualizar);
}

// ---------------------------------------------------------------------------------------------
// Filtros: una sola fila arriba de todo. Se dibuja una vez por cada rango de datos; después solo se
// sincronizan los valores, para no perder el foco ni lo que el usuario está escribiendo

const iso = (d) => d.toISOString().slice(0, 10);
const deIso = (t) => new Date(`${t}T00:00:00Z`);
const masDias = (t, n) => iso(new Date(deIso(t).getTime() + n * 86400000));
const claveBarra = (o) => JSON.stringify([o.rango, o.estaciones, o.productos]);

const RAPIDOS = [
  { valor: 'todo', texto: 'Todo' },
  { valor: '7', texto: 'Últimos 7 días' },
  { valor: '30', texto: 'Últimos 30 días' },
  { valor: 'mes', texto: 'Este mes' },
  { valor: 'anterior', texto: 'Mes anterior' },
];

/** Rango de un botón rápido, dentro de los datos; null si no hay datos para ese rango */
function rangoRapido(tipo) {
  const { desde: min, hasta: max } = opciones.rango;
  const limitar = (d) => (d < min ? min : d);
  if (tipo === '7') return { desde: limitar(masDias(max, -6)), hasta: max };
  if (tipo === '30') return { desde: limitar(masDias(max, -29)), hasta: max };
  if (tipo === 'mes') return { desde: limitar(`${max.slice(0, 7)}-01`), hasta: max };
  if (tipo === 'anterior') {
    // Nunca se recorta hacia el mes actual: sin datos del mes anterior, el botón queda desactivado
    const finAnterior = masDias(`${max.slice(0, 7)}-01`, -1);
    if (finAnterior < min) return null;
    return { desde: limitar(`${finAnterior.slice(0, 7)}-01`), hasta: finAnterior };
  }
  return { desde: min, hasta: max };
}

/** Guarda las opciones nuevas y ajusta los filtros, que se conservan mientras sigan dentro de lo cargado */
function ponerOpciones(nuevas) {
  if (opciones && JSON.stringify(opciones) === JSON.stringify(nuevas)) return false;
  const primeraVez = !opciones?.rango.desde;
  opciones = nuevas;
  const { desde: min, hasta: max } = nuevas.rango;
  if (!min) return true;
  const todo = { desde: min, hasta: max, rapido: 'todo' };
  const f = { ...filtros };
  if (primeraVez || !f.desde) Object.assign(f, todo);
  else if (f.rapido) {
    // Un rango rápido se calcula otra vez: "Todo" o "Últimos 7 días" llegan hasta el último día nuevo
    const r = rangoRapido(f.rapido);
    Object.assign(f, r ?? todo, { rapido: r ? f.rapido : 'todo' });
  } else if (f.hasta < min || f.desde > max) Object.assign(f, todo);
  else Object.assign(f, { desde: f.desde < min ? min : f.desde, hasta: f.hasta > max ? max : f.hasta });
  if (f.estacion && !nuevas.estaciones.some((e) => e.codigo === f.estacion)) delete f.estacion;
  if (f.producto && !nuevas.productos.includes(f.producto)) delete f.producto;
  filtros = f;
  return true;
}

function pintarFiltros() {
  const cont = raiz.querySelector('#dash-filtros');
  const { desde: min, hasta: max } = opciones.rango;
  // Si el foco estaba en la barra, vuelve al mismo control después de dibujarla
  const foco = cont.contains(document.activeElement) ? document.activeElement.id : '';
  dibujandoBarra = true;
  cont.innerHTML = `
    <div class="filtros" role="search" aria-label="Filtros del dashboard">
      <label class="campo">Desde<input type="date" id="f-desde" min="${escapar(min)}" max="${escapar(max)}" /></label>
      <label class="campo">Hasta<input type="date" id="f-hasta" min="${escapar(min)}" max="${escapar(max)}" /></label>
      <label class="campo">Estación<select id="f-estacion"><option value="">Todas</option>${opciones.estaciones
        .map((e) => `<option value="${escapar(e.codigo)}">${escapar(`${e.codigo} · ${e.nombre}`)}</option>`)
        .join('')}</select></label>
      <label class="campo">Producto<select id="f-producto"><option value="">Todos</option>${opciones.productos
        .map((p) => `<option value="${escapar(p)}">${escapar(p)}</option>`)
        .join('')}</select></label>
      <div class="campo">Rango rápido${segmentado('rango', RAPIDOS, '')}</div>
      <span class="separador"></span>
      <span class="filtros-nota">Datos del ${escapar(fecha(min, true))} al ${escapar(fecha(max, true))}</span>
      <button type="button" class="boton boton-chico" id="f-actualizar" title="Vuelve a leer el modelo, por ejemplo después de una carga hecha desde la consola">Actualizar</button>
    </div>`;
  dibujandoBarra = false;
  barraDe = claveBarra(opciones);
  if (!rangoRapido('anterior')) {
    const b = cont.querySelector('[data-segmentado="rango"] button[data-valor="anterior"]');
    b.disabled = true;
    b.title = `No hay datos del mes anterior: los datos empiezan el ${fecha(min, true)}`;
  }
  for (const id of ['#f-desde', '#f-hasta']) {
    const campo = cont.querySelector(id);
    // Al escribir la fecha a mano, el primer número ya forma una fecha válida: se espera a que termine
    const alEscribir = () => {
      fechaEditada = id === '#f-desde' ? 'desde' : 'hasta';
      marcarRapido('');
      programar(700, false);
    };
    campo.addEventListener('input', alEscribir);
    campo.addEventListener('change', alEscribir);
    // relatedTarget es el control que recibe el foco: no se le cambia el valor (con el mouse perdería el foco)
    campo.addEventListener('blur', (ev) => aplicar(true, ev.relatedTarget));
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') aplicar(true);
    });
  }
  // Con el teclado, cada flecha sobre un select cerrado cambia el valor: se consulta cuando se detiene
  for (const id of ['#f-estacion', '#f-producto']) cont.querySelector(id).addEventListener('change', () => programar(300, true));
  conectarSegmentado(cont, 'rango', (v) => {
    const r = rangoRapido(v);
    if (!r) return;
    filtros.rapido = v;
    cont.querySelector('#f-desde').value = r.desde;
    cont.querySelector('#f-hasta').value = r.hasta;
    aplicar(true);
  });
  cont.querySelector('#f-actualizar').addEventListener('click', actualizar);
  sincronizarFiltros(true);
  if (foco) cont.querySelector(`#${foco}`)?.focus();
}

/**
 * Pone en la barra los valores de filtros; el control con el foco no se toca salvo que el usuario ya terminó.
 * destino (el control que está recibiendo el foco) nunca se toca.
 */
function sincronizarFiltros(incluirFoco = false, destino = null) {
  const cont = raiz.querySelector('#dash-filtros');
  const poner = (sel, v) => {
    const e = cont.querySelector(sel);
    if (e && e !== destino && e.value !== v && (incluirFoco || e !== document.activeElement)) e.value = v;
  };
  poner('#f-desde', filtros.desde);
  poner('#f-hasta', filtros.hasta);
  poner('#f-estacion', filtros.estacion ?? '');
  poner('#f-producto', filtros.producto ?? '');
  marcarRapido(filtros.rapido ?? '');
}

function marcarRapido(v) {
  filtros.rapido = v;
  raiz.querySelectorAll('#dash-filtros [data-segmentado="rango"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.valor === v)));
}

function programar(ms, final) {
  clearTimeout(espera);
  espera = setTimeout(() => aplicar(final), ms);
}

/**
 * Lee la barra y consulta si algo cambió. final = el usuario terminó (salió del campo, Enter, eligió una
 * opción): las fechas fuera de los datos se ajustan al rango. Mientras escribe, una fecha a medias o fuera
 * del rango solo espera. destino = el control que recibe el foco al salir de un campo, que no se toca.
 */
function aplicar(final, destino = null) {
  clearTimeout(espera);
  const cont = raiz.querySelector('#dash-filtros');
  if (dibujandoBarra || !opciones?.rango.desde || !cont.querySelector('#f-desde')) return;
  const { desde: min, hasta: max } = opciones.rango;
  let desde = cont.querySelector('#f-desde').value;
  let hasta = cont.querySelector('#f-hasta').value;
  const enRango = (v) => v >= min && v <= max;
  if (!final && (!enRango(desde) || !enRango(hasta) || desde > hasta)) return;
  const limitar = (v, vacio) => (!v ? vacio : v < min ? min : v > max ? max : v);
  desde = limitar(desde, min);
  hasta = limitar(hasta, max);
  if (desde > hasta) {
    // Nunca se intercambian: la otra fecha pasa a ser la que se acaba de editar. Si el foco va justo a esa
    // otra fecha, el usuario la va a cambiar: se espera a que salga de ella
    const otra = cont.querySelector(fechaEditada === 'hasta' ? '#f-desde' : '#f-hasta');
    if (destino === otra) return;
    if (fechaEditada === 'hasta') desde = hasta;
    else hasta = desde;
  }
  const nuevos = {
    desde,
    hasta,
    estacion: cont.querySelector('#f-estacion').value || undefined,
    producto: cont.querySelector('#f-producto').value || undefined,
    rapido: filtros.rapido,
  };
  const cambio = ['desde', 'hasta', 'estacion', 'producto'].some((k) => (nuevos[k] ?? '') !== (filtros[k] ?? ''));
  filtros = nuevos;
  if (final) sincronizarFiltros(true, destino);
  if (cambio) {
    pendiente = true;
    cargar();
  }
}

// ---------------------------------------------------------------------------------------------

function pintar(d) {
  const cuerpo = raiz.querySelector('#dash-cuerpo');
  cuerpo.innerHTML = '';
  if (!d.kpis.tickets) {
    cuerpo.innerHTML = `<div class="tarjeta vacio"><strong>Sin ventas con estos filtros</strong>Prueba con otro rango de fechas o quita el filtro de producto.</div>`;
    return;
  }
  cuerpo.append(indicadores(d));
  const fila1 = rejilla();
  fila1.append(ventasPorDia(d), mezclaProductos(d));
  const fila2 = rejilla();
  fila2.append(utilidadPorGalon(d), calor(d));
  const fila3 = rejilla();
  fila3.append(ventasPorTurno(d));
  const fila4 = rejilla();
  fila4.append(facturacion(d), clientes(d));
  const fila5 = rejilla();
  fila5.append(...revisiones(d));
  cuerpo.append(fila1, fila2, fila3, fila4, fila5);
}

const rejilla = () => Object.assign(document.createElement('div'), { className: 'rejilla' });
const pct = (parte, total) => (total ? (100 * parte) / total : 0);

// Por qué no hay comparación (el servidor solo compara dos periodos con los mismos días cargados)
const SIN_COMPARAR = { 'sin-datos': 'sin periodo anterior cargado', parcial: 'faltan días por cargar, sin comparar' };

// El último día cargado puede venir a medias: el servidor cuenta el último día del periodo anterior solo
// hasta la hora del último ticket (cortes, una por estación) y aquí se avisa
function notaCorte(cortes) {
  const horas = [...new Set((cortes ?? []).map((c) => c.hora))];
  if (!horas.length) return '';
  if (horas.length > 1) return 'último día comparado hasta la misma hora en cada estación';
  return `comparado hasta ${horas[0].startsWith('01:') ? 'la' : 'las'} ${horas[0]} del último día`;
}

function indicadores(d) {
  const k = d.kpis;
  const a = d.anterior?.kpis?.tickets ? d.anterior : null;
  const cambio = (actual, previo) => {
    if (!a || !previo) return '';
    const p = ((actual - previo) / Math.abs(previo)) * 100;
    const flecha = p > 0.05 ? '▲' : p < -0.05 ? '▼' : '';
    return `<span class="${p >= 0 ? 'sube' : 'baja'}">${flecha} ${escapar(fmt.pct(Math.abs(p)))}</span> vs. ${escapar(`${fecha(a.filtros.desde)} al ${fecha(a.filtros.hasta)}`)}`;
  };
  const notaVenta = [`${plural(k.dias, 'día', 'días')} con ventas`, a ? null : SIN_COMPARAR[d.sinComparar]].filter(Boolean).join(' · ');
  const tile = (titulo, valor, nota, otraNota = '') =>
    `<div class="indicador"><div class="indicador-titulo">${escapar(titulo)}</div><div class="indicador-valor">${escapar(valor)}</div><div class="indicador-nota">${nota}</div>${
      otraNota ? `<div class="indicador-nota">${escapar(otraNota)}</div>` : ''
    }</div>`;
  const vsVenta = cambio(k.venta, a?.kpis.venta);
  const div = document.createElement('div');
  div.className = 'indicadores';
  div.innerHTML = [
    // La nota del corte va una vez, en la primera tarjeta: vale para las tres comparaciones
    tile('Venta total', fmt.moneda(k.venta), vsVenta || escapar(notaVenta), vsVenta ? notaCorte(a.cortes) : ''),
    tile('Galones', fmt.numero(k.galones, 2), cambio(k.galones, a?.kpis.galones) || escapar(`Precio promedio ${fmt.porGalon(k.venta / k.galones)}`)),
    tile('Tickets', fmt.entero(k.tickets), cambio(k.tickets, a?.kpis.tickets) || escapar(`Ticket promedio ${fmt.moneda(k.venta / k.tickets)}`)),
    tile('Utilidad', fmt.moneda(k.utilidad), escapar(`Margen ${fmt.pct(pct(k.utilidad, k.neto))} sobre la venta neta`)),
    tile('Venta sin factura', fmt.moneda(k.venta_sin_factura), escapar(`${fmt.pct(pct(k.venta_sin_factura, k.venta))} de la venta · ${plural(k.tickets_sin_factura, 'ticket', 'tickets')}`)),
    tile(
      'Descuentos de pricebook',
      fmt.moneda(k.descuento_pricebook),
      escapar(k.recargo_pricebook > 0 ? `Rebaja contra el precio de lista. Recargos cobrados aparte: ${fmt.moneda(k.recargo_pricebook)}` : 'Rebaja contra el precio de lista'),
    ),
  ].join('');
  return div;
}

const MEDIDAS_DIA = [
  { valor: 'venta', texto: 'Venta' },
  { valor: 'galones', texto: 'Galones' },
  { valor: 'utilidad', texto: 'Utilidad' },
  { valor: 'venta_sin_factura', texto: 'Sin factura' },
];
const formatoDe = (m) => (m === 'galones' ? fmt.galones : fmt.moneda);
const ejeDe = (m) => (m === 'galones' ? fmt.galonesCorto : fmt.monedaCorta);
const nombreMedida = (m) => MEDIDAS_DIA.find((x) => x.valor === m)?.texto ?? m;

function ventasPorDia(d) {
  const t = tarjeta({ titulo: 'Ventas por día', subtitulo: 'Por producto, según la fecha del ticket', alto: 300, clase: 'col-8', controles: segmentado('medida', MEDIDAS_DIA, 'venta') });
  const dibujar = (m) => {
    const { categorias, series } = pivotar(d.diario, 'fecha', m);
    barrasApiladas(t.grafica, {
      categorias,
      series,
      formato: formatoDe(m),
      formatoEje: ejeDe(m),
      etiqueta: (x) => fecha(x),
      titulo: (x) => `${diaSemana(x)} ${fecha(x, true)} · ${nombreMedida(m)}`,
    });
    t.ponerTabla(tablaPivote(categorias, series, (x) => `${diaSemana(x)} ${fecha(x, true)}`, 'Fecha', formatoDe(m)));
  };
  conectarSegmentado(t.el, 'medida', dibujar);
  dibujar('venta');
  return t.el;
}

function mezclaProductos(d) {
  const medidas = MEDIDAS_DIA.slice(0, 3);
  const t = tarjeta({ titulo: 'Por producto', subtitulo: 'Participación en el periodo', alto: 300, clase: 'col-4', controles: segmentado('medida', medidas, 'venta') });
  const productos = d.productos;
  const dibujar = (m) => {
    const lista = [...productos].sort((x, y) => y[m] - x[m]);
    const total = lista.reduce((s, p) => s + p[m], 0);
    barrasHorizontales(t.grafica, {
      categorias: lista.map((p) => p.producto),
      valores: lista.map((p) => p[m]),
      // El color sigue al producto con los colores del tema vigente (se repinta al cambiar de tema)
      colorDe: (producto, _i, c) => colorProducto(producto, c),
      formato: formatoDe(m),
      formatoEje: ejeDe(m),
      nombreMedida: nombreMedida(m),
      // Valor exacto en la etiqueta de cada barra (el eje sí va corto)
      etiqueta: (i) => `${formatoDe(m)(lista[i][m])} · ${fmt.pct(pct(lista[i][m], total))}`,
      nota: (i) => `Margen ${fmt.pct(lista[i].margen_pct)} · ${fmt.porGalon(lista[i].utilidad_por_galon)} de utilidad`,
    });
  };
  conectarSegmentado(t.el, 'medida', dibujar);
  dibujar('venta');
  const pie = productos.reduce(
    (s, p) => ({ ...s, tickets: s.tickets + p.tickets, galones: s.galones + p.galones, venta: s.venta + p.venta, utilidad: s.utilidad + p.utilidad, neto: s.neto + p.neto, venta_sin_factura: s.venta_sin_factura + p.venta_sin_factura }),
    { esPie: true, producto: 'Total', tickets: 0, galones: 0, venta: 0, utilidad: 0, neto: 0, venta_sin_factura: 0 },
  );
  pie.margen_pct = pct(pie.utilidad, pie.neto);
  t.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Producto', valor: (p) => (p.esPie ? 'Total' : conPunto(p.producto, varProducto(p.producto))), html: true },
        { titulo: 'Tickets', valor: (p) => fmt.entero(p.tickets), der: true },
        { titulo: 'Galones', valor: (p) => fmt.numero(p.galones), der: true },
        { titulo: 'Venta', valor: (p) => fmt.moneda(p.venta), der: true },
        { titulo: 'Utilidad', valor: (p) => fmt.moneda(p.utilidad), der: true },
        { titulo: 'Margen', valor: (p) => fmt.pct(p.margen_pct), der: true },
        { titulo: 'Sin factura', valor: (p) => fmt.moneda(p.venta_sin_factura), der: true },
      ],
      productos,
      { pie },
    ),
  );
  return t.el;
}

function utilidadPorGalon(d) {
  const t = tarjeta({
    titulo: 'Utilidad por galón',
    subtitulo: 'Por día y producto: venta neta menos costo, entre galones. Un salto brusco suele ser un costo mal cargado en la compra.',
    alto: 300,
    clase: 'col-6',
  });
  const filas = d.diario.filter((f) => f.producto !== 'SIN PRODUCTO' && f.galones > 0);
  const categorias = [...new Set(filas.map((f) => f.fecha))].sort();
  const productos = ordenarProductos(filas.map((f) => f.producto));
  const series = productos.map((p) => ({
    nombre: p,
    valores: categorias.map((x) => filas.find((f) => f.fecha === x && f.producto === p)?.utilidad_por_galon ?? null),
  }));
  lineas(t.grafica, {
    categorias,
    series,
    formato: fmt.porGalon,
    // Con un rango chico las marcas son fraccionarias (Q4.20, Q4.40): sin decimales se leerían repetidas
    formatoEje: (v) => (Number.isInteger(v) ? fmt.monedaEntera(v) : fmt.moneda(v)),
    etiqueta: (x) => fecha(x),
    titulo: (x) => `${diaSemana(x)} ${fecha(x, true)}`,
  });
  t.ponerTabla(
    tablaHtml(
      [{ titulo: 'Fecha', valor: (f) => `${diaSemana(f.x)} ${fecha(f.x, true)}` }, ...series.map((s, k) => ({ titulo: s.nombre, valor: (f) => fmt.porGalon(f.v[k]), der: true }))],
      categorias.map((x, i) => ({ x, v: series.map((s) => s.valores[i]) })),
    ),
  );
  return t.el;
}

// Para el tooltip del mapa de calor: "Promedio de 4 jueves con datos a esa hora"
const DIAS_LARGOS = [
  ['lunes', 'lunes'],
  ['martes', 'martes'],
  ['miércoles', 'miércoles'],
  ['jueves', 'jueves'],
  ['viernes', 'viernes'],
  ['sábado', 'sábados'],
  ['domingo', 'domingos'],
];

function calor(d) {
  const medidas = [
    { valor: 'tickets', texto: 'Tickets' },
    { valor: 'venta', texto: 'Venta' },
    { valor: 'galones', texto: 'Galones' },
  ];
  const t = tarjeta({
    titulo: '¿Cuándo se vende?',
    subtitulo: 'Promedio por día, según el día de la semana y la hora del despacho',
    alto: 300,
    clase: 'col-6',
    controles: segmentado('medida', medidas, 'tickets'),
  });
  const horas = [...new Set(d.mapaDeCalor.map((f) => f.hora))].sort((a, b) => a - b);
  const desde = horas[0] ?? 0;
  const hasta = horas[horas.length - 1] ?? 23;
  const x = Array.from({ length: hasta - desde + 1 }, (_, i) => `${String(desde + i).padStart(2, '0')}:00`);
  // Cada celda ya viene dividida entre las fechas de ese día de la semana cuyos datos cubren esa hora (dias).
  // Un día cargado a medias (el primero o el último) no cuenta en las horas que no trae: ahí dias es menor
  const diasCelda = new Map(d.mapaDeCalor.map((f) => [`${f.dia}-${f.hora}`, f.dias]));
  const veces = DIAS.map((_, i) => Math.max(0, ...d.mapaDeCalor.filter((f) => f.dia === i + 1).map((f) => f.dias)));
  const aMedias = d.mapaDeCalor.some((f) => f.dias < veces[f.dia - 1]);
  const textoDias = (n, i) => `${n} ${DIAS_LARGOS[i][n === 1 ? 0 : 1]}`;
  const formato = (m) => (m === 'tickets' ? (v) => `${fmt.numero(v, 1)} tickets` : m === 'galones' ? fmt.galones : fmt.moneda);
  const celda = (m) => (m === 'venta' ? fmt.monedaEntera : (v) => fmt.numero(v, 1));
  const dibujar = (m) => {
    const nombre = medidas.find((o) => o.valor === m).texto;
    mapaCalor(t.grafica, {
      x,
      y: DIAS,
      datos: d.mapaDeCalor.map((f) => [f.hora - desde, f.dia - 1, f[m]]),
      formato: formato(m),
      nombreMedida: `${nombre} (promedio por día)`,
      nota: (v) => `Promedio de ${textoDias(diasCelda.get(`${v[1] + 1}-${v[0] + desde}`) ?? 0, v[1])} con datos a esa hora`,
    });
    // Tabla equivalente: un renglón por día y una columna por hora, con la medida elegida
    const valor = new Map(d.mapaDeCalor.map((f) => [`${f.dia}-${f.hora}`, f[m]]));
    const filas = DIAS.map((dia, i) => ({ dia, i, valores: x.map((_, k) => valor.get(`${i + 1}-${desde + k}`) ?? 0) }));
    const ver = (f, v) => (veces[f.i] ? celda(m)(v) : '–');
    t.ponerTabla(
      tablaHtml(
        [
          { titulo: 'Día', valor: (f) => f.dia },
          { titulo: 'Días con ventas', valor: (f) => fmt.entero(veces[f.i]), der: true },
          ...x.map((h, k) => ({ titulo: h.slice(0, 2), valor: (f) => ver(f, f.valores[k]), der: true })),
          { titulo: 'Todo el día', valor: (f) => ver(f, f.valores.reduce((s, v) => s + v, 0)), der: true },
        ],
        filas,
      ) +
        (aMedias
          ? '<p class="nota" style="margin-top:6px">En las horas que no trae un día cargado a medias (el primero o el último cargado), el promedio no cuenta ese día.</p>'
          : ''),
    );
  };
  conectarSegmentado(t.el, 'medida', dibujar);
  dibujar('tickets');
  return t.el;
}

function ventasPorTurno(d) {
  const medidas = [
    { valor: 'venta', texto: 'Venta' },
    { valor: 'galones', texto: 'Galones' },
    { valor: 'venta_sin_factura', texto: 'Sin factura' },
  ];
  const t = tarjeta({
    titulo: 'Ventas por turno',
    subtitulo:
      'Por producto, con los tickets cuya fecha cae en el rango (igual que los indicadores). Un turno que cruza la medianoche puede salir en parte; su fecha operativa es el día con más tickets.',
    alto: 300,
    clase: 'col-12',
    controles: segmentado('medida', medidas, 'venta'),
  });
  // El número de turno se repite entre estaciones: la categoría es estación + turno, y con más de una
  // estación en el rango la etiqueta lleva el código
  const varias = new Set(d.turnos.map((f) => f.estacion)).size > 1;
  const filas = d.turnos.map((f) => ({ ...f, clave: `${f.estacion} ${f.turno}` }));
  const info = new Map();
  for (const f of filas) {
    const i = info.get(f.clave) ?? { ...f, enRango: 0 };
    i.enRango += f.tickets;
    info.set(f.clave, i);
  }
  const numero = (i) => (i.turno === -1 ? 'Sin turno' : String(i.turno));
  const etiqueta = (clave) => {
    const i = info.get(clave);
    return varias ? `${i.estacion} ${numero(i)}` : numero(i);
  };
  const orden = (a, b) => info.get(a).estacion.localeCompare(info.get(b).estacion) || info.get(a).turno - info.get(b).turno;
  const enParte = (i) => i.enRango < i.tickets_turno;
  const titulo = (clave) => {
    const i = info.get(clave);
    return [i.turno === -1 ? 'Sin turno' : `Turno ${i.turno}`, varias ? i.estacion : null, i.fecha_operativa ? `fecha operativa ${fecha(i.fecha_operativa, true)}` : null]
      .filter(Boolean)
      .join(' · ');
  };
  const nota = (clave) => {
    const i = info.get(clave);
    const partes = [];
    if (i.desde && i.hasta) partes.push(`Tickets del ${fechaHora(i.desde, false)} al ${fechaHora(i.hasta, false)}`);
    if (enParte(i)) partes.push(`En el rango: ${fmt.entero(i.enRango)} de sus ${fmt.entero(i.tickets_turno)} tickets`);
    return partes.join('. ') || null;
  };
  const dibujar = (m) => {
    const { categorias, series } = pivotar(filas, 'clave', m, orden);
    barrasApiladas(t.grafica, { categorias, series, formato: formatoDe(m), formatoEje: ejeDe(m), etiqueta, titulo, nota: (k) => nota(categorias[k]) });
    t.ponerTabla(
      tablaPivote(
        categorias,
        series,
        (clave) => `${etiqueta(clave)} · ${fecha(info.get(clave).fecha_operativa)}${enParte(info.get(clave)) ? ' (en parte)' : ''}`,
        'Turno',
        formatoDe(m),
      ),
    );
  };
  conectarSegmentado(t.el, 'medida', dibujar);
  dibujar('venta');
  return t.el;
}

function facturacion(d) {
  const t = tarjeta({ titulo: 'Facturación', subtitulo: 'Venta según cómo se facturó el ticket', alto: 260, clase: 'col-4' });
  const ORDEN = ['FACTURA INDIVIDUAL', 'FACTURA GLOBAL', 'SIN FACTURA'];
  const lista = [...d.facturacion].sort((a, b) => ORDEN.indexOf(a.tipo) - ORDEN.indexOf(b.tipo));
  const total = lista.reduce((s, f) => s + f.venta, 0);
  barrasHorizontales(t.grafica, {
    categorias: lista.map((f) => nombreFacturacion(f.tipo)),
    valores: lista.map((f) => f.venta),
    formato: fmt.moneda,
    formatoEje: fmt.monedaCorta,
    nombreMedida: 'Venta',
    etiqueta: (i) => `${fmt.monedaCorta(lista[i].venta)} · ${fmt.pct(pct(lista[i].venta, total))}`,
    nota: (i) => plural(lista[i].tickets, 'ticket', 'tickets'),
  });
  t.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Facturación', valor: (f) => nombreFacturacion(f.tipo) },
        { titulo: 'Tickets', valor: (f) => fmt.entero(f.tickets), der: true },
        { titulo: 'Venta', valor: (f) => fmt.moneda(f.venta), der: true },
        { titulo: '% de la venta', valor: (f) => fmt.pct(pct(f.venta, total)), der: true },
      ],
      lista,
    ),
  );
  return t.el;
}

function clientes(d) {
  const t = tarjeta({
    titulo: 'Clientes con código: los 10 que más compran',
    subtitulo: 'Sin consumidor final, con su nombre y NIT actuales. En el detalle: venta sin factura, descuentos y recargos de pricebook.',
    alto: 260,
    clase: 'col-8',
  });
  const lista = d.clientes;
  const conRecargo = lista.some((c) => c.recargo > 0);
  barrasHorizontales(t.grafica, {
    categorias: lista.map((c) => c.nombre),
    valores: lista.map((c) => c.venta),
    formato: fmt.moneda,
    formatoEje: fmt.monedaCorta,
    nombreMedida: 'Venta',
    anchoEtiqueta: 32,
    etiqueta: (i) => fmt.monedaCorta(lista[i].venta),
    nota: (i) => {
      const c = lista[i];
      return [
        c.codigo,
        plural(c.tickets, 'ticket', 'tickets'),
        `sin factura ${fmt.moneda(c.venta_sin_factura)}`,
        `descuento ${fmt.moneda(c.descuento)}`,
        c.recargo > 0 ? `recargo ${fmt.moneda(c.recargo)}` : null,
      ]
        .filter(Boolean)
        .join(' · ');
    },
  });
  t.ponerTabla(
    tablaHtml(
      [
        { titulo: 'Cliente', valor: (c) => c.nombre },
        { titulo: 'Código', valor: (c) => c.codigo },
        { titulo: 'NIT', valor: (c) => c.nit ?? '–' },
        { titulo: 'Tickets', valor: (c) => fmt.entero(c.tickets), der: true },
        { titulo: 'Galones', valor: (c) => fmt.numero(c.galones), der: true },
        { titulo: 'Venta', valor: (c) => fmt.moneda(c.venta), der: true },
        { titulo: 'Sin factura', valor: (c) => fmt.moneda(c.venta_sin_factura), der: true },
        { titulo: 'Descuento', valor: (c) => fmt.moneda(c.descuento), der: true },
        ...(conRecargo ? [{ titulo: 'Recargo', valor: (c) => fmt.moneda(c.recargo), der: true }] : []),
      ],
      lista,
    ),
  );
  return t.el;
}

// Severidad de cada alerta: la misma que tiene su regla en la revisión de la carga (src/reportes/
// consulta-tickets/reglas.ts), para que un ticket se vea igual aquí, en Cargar reporte y en el Historial
const SEVERIDAD_ALERTA = {
  'MARGEN NEGATIVO': 'INFO',
  'PRECIO FUERA DE PRICEBOOK': 'ADVERTENCIA',
  'POSIBLE DUPLICADO': 'ADVERTENCIA',
  'SIN PRODUCTO': 'ADVERTENCIA',
};
const severidadDe = (alerta) => SEVERIDAD_ALERTA[alerta] ?? 'ADVERTENCIA';
const nombreAlerta = (alerta) => nombreRegla(alerta.replace(/ /g, '_'));

function revisiones(d) {
  const a = d.alertas;
  // Primero las advertencias y después las informativas, como en el historial
  const resumen = [...a.resumen].sort((x, y) => (severidadDe(x.alerta) === 'INFO') - (severidadDe(y.alerta) === 'INFO') || y.tickets - x.tickets);
  const alertas = document.createElement('section');
  alertas.className = 'tarjeta col-7';
  alertas.innerHTML = `
    <div class="tarjeta-cabeza"><div><h3>Tickets para revisar</h3><p class="tarjeta-sub">Reglas sobre lo cargado, en el rango de fechas elegido (el filtro de producto no aplica aquí).</p></div></div>
    ${
      resumen.length
        ? `<ul class="lista-incidencias">${resumen
            .map((r) => {
              const s = SEVERIDAD[severidadDe(r.alerta)];
              return `<li><details><summary>${estado(s.tipo, s.texto)}<span>${escapar(nombreAlerta(r.alerta))}</span><span class="cuenta">${plural(r.tickets, 'ticket', 'tickets')} · ${escapar(fmt.moneda(r.monto))}</span></summary>
                ${tablaHtml(
                  [
                    { titulo: 'Ticket', valor: (x) => x.ticket },
                    { titulo: 'Fecha', valor: (x) => fechaHora(x.fecha_hora) },
                    { titulo: 'Detalle', valor: (x) => x.detalle },
                    { titulo: 'Monto', valor: (x) => fmt.moneda(x.monto), der: true },
                  ],
                  a.recientes.filter((x) => x.alerta === r.alerta).slice(0, 25),
                  { vacio: 'Los más recientes de este tipo no entran en la lista de 100' },
                )}
                ${r.tickets > 25 ? `<p class="nota" style="margin:6px 0 12px">Se muestran los más recientes. El detalle completo está en la vista mart.v_alertas_ticket.</p>` : ''}
              </details></li>`;
            })
            .join('')}</ul>`
        : `<p>${estado('bueno', 'Ningún ticket con alertas en este rango')}</p>`
    }`;

  const faltantes = document.createElement('section');
  faltantes.className = 'tarjeta col-5';
  const total = d.faltantes.reduce((s, f) => s + f.tickets_faltantes, 0);
  faltantes.innerHTML = `
    <div class="tarjeta-cabeza"><div><h3>Tickets que faltan</h3><p class="tarjeta-sub">Huecos en la numeración: pueden ser tickets anulados o borrados en BISS.</p></div></div>
    <p style="margin-bottom:10px">${total ? estado('aviso', `${plural(total, 'ticket falta', 'tickets faltan')} en la numeración`) : estado('bueno', 'La numeración está completa')}</p>
    ${
      d.faltantes.length
        ? tablaHtml(
            [
              { titulo: 'Turno', valor: (f) => f.turno },
              { titulo: 'Falta', valor: (f) => (f.falta_desde === f.falta_hasta ? f.falta_desde : `${f.falta_desde} a ${f.falta_hasta}`) },
              {
                titulo: 'Entre',
                valor: (f) =>
                  `${fechaHora(f.ultimo_antes, false)} y ${f.primero_despues.slice(0, 10) === f.ultimo_antes.slice(0, 10) ? f.primero_despues.slice(11) : fechaHora(f.primero_despues, false)}`,
              },
            ],
            d.faltantes,
          )
        : ''
    }`;
  return [alertas, faltantes];
}
