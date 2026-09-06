/* ============================================================
   Un DOM de mentira, chico, para poder probar la pagina.

   `paginas/chat/chat.js` son casi 700 renglones que deciden lo que se
   ve: en que lista entra cada mensaje, cuando se pausa el scroll, que
   dice el indicador de salud, que pasa con un 429. Nada de eso se
   puede probar desde el servidor, y hasta ahora no se probaba en
   ningun lado: el bug de la lista que quedaba vacia al cambiar de
   vista lo encontro una persona mirando la pantalla.

   Tres decisiones, y las tres son para que el test no mienta:

   1. EL ARBOL SALE DEL HTML DE VERDAD. Se parsea `paginas/chat.html`,
      no una maqueta escrita en el test. Si alguien saca un id o
      cambia la estructura, los tests se caen, que es exactamente lo
      que tienen que hacer.

   2. `innerHTML` NO EXISTE Y TIRA. El texto de un mensaje lo escribe
      gente desconocida; la pagina lo pone con textContent a
      proposito. Si alguien vuelve a innerHTML, el test explota en vez
      de pasar.

   3. Se corre el archivo de verdad, con `node:vm`, en un contexto que
      tiene lo que un navegador le da y nada mas. Los scripts que la
      pagina carga sola (chat/demo.js) se cargan de verdad.

   No es un navegador: no hay layout, ni CSS, ni eventos que burbujeen.
   El scroll se simula poniendo scrollHeight/clientHeight a mano, que
   es lo unico que la pagina mira.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const PAGINAS = path.resolve(AQUI, '..', '..', 'paginas');

/* --------------------------------------------------------- nodos */

class NodoTexto {
  constructor(datos) { this.datos = String(datos); this.padre = null; }
  get textContent() { return this.datos; }
  set textContent(v) { this.datos = String(v); }
  clonar() { return new NodoTexto(this.datos); }
}

class Elemento {
  constructor(etiqueta) {
    this.tagName = String(etiqueta).toUpperCase();
    this.hijos = [];
    this.padre = null;
    this.atributos = new Map();
    this.dataset = {};
    this.style = new Estilo();
    this.escuchas = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    /* El layout no existe: la pagina solo mira estos tres numeros y
       el test los pone a mano para simular que alguien subio. */
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
  }

  /* ---- innerHTML es la puerta del XSS: aca directamente no existe */
  get innerHTML() { throw new Error('innerHTML no se usa en esta pagina: todo va por textContent'); }
  set innerHTML(_) { throw new Error('innerHTML no se usa en esta pagina: todo va por textContent'); }

  get className() { return this.atributos.get('class') ?? ''; }
  set className(v) { this.atributos.set('class', String(v)); }

  get classList() {
    const clases = () => this.className.split(/\s+/).filter(Boolean);
    const guardar = lista => { this.className = lista.join(' '); };
    return {
      contains: c => clases().includes(c),
      add: c => { if (!clases().includes(c)) guardar([...clases(), c]); },
      remove: c => guardar(clases().filter(x => x !== c)),
      toggle: (c, forzar) => {
        const tiene = clases().includes(c);
        const querer = forzar === undefined ? !tiene : Boolean(forzar);
        if (querer && !tiene) guardar([...clases(), c]);
        if (!querer && tiene) guardar(clases().filter(x => x !== c));
        return querer;
      },
    };
  }

  get id() { return this.atributos.get('id') ?? ''; }

  setAttribute(nombre, valor) { this.atributos.set(nombre, String(valor)); }
  getAttribute(nombre) { return this.atributos.has(nombre) ? this.atributos.get(nombre) : null; }
  removeAttribute(nombre) { this.atributos.delete(nombre); }

  get children() { return this.hijos.filter(h => h instanceof Elemento); }
  get childNodes() { return this.hijos.slice(); }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return this.padre; }

  appendChild(nodo) {
    if (nodo.padre) nodo.padre.removeChild(nodo);
    nodo.padre = this;
    this.hijos.push(nodo);
    if (this.alAgregar) this.alAgregar(nodo);
    if (this.raiz?.alAgregar) this.raiz.alAgregar(nodo);
    return nodo;
  }

  removeChild(nodo) {
    const i = this.hijos.indexOf(nodo);
    if (i >= 0) this.hijos.splice(i, 1);
    nodo.padre = null;
    return nodo;
  }

  get textContent() {
    return this.hijos.map(h => h.textContent).join('');
  }

  set textContent(v) {
    for (const h of this.hijos) h.padre = null;
    this.hijos = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new NodoTexto(v));
  }

  /** Solo acepta '.clase', que es lo unico que usa la pagina. */
  closest(selector) {
    const clase = selector.startsWith('.') ? selector.slice(1) : null;
    if (!clase) throw new Error(`el DOM de mentira solo entiende selectores de clase: ${selector}`);
    let n = this;
    while (n) {
      if (n.classList.contains(clase)) return n;
      n = n.padre;
    }
    return null;
  }

  cloneNode(profundo) {
    const c = new Elemento(this.tagName);
    c.atributos = new Map(this.atributos);
    c.dataset = { ...this.dataset };
    c.style = new Estilo(this.style.props);
    c.hidden = this.hidden;
    c.raiz = this.raiz;
    if (profundo) for (const h of this.hijos) c.appendChild(h instanceof Elemento ? h.cloneNode(true) : h.clonar());
    return c;
  }

  addEventListener(tipo, fn) {
    if (!this.escuchas.has(tipo)) this.escuchas.set(tipo, []);
    this.escuchas.get(tipo).push(fn);
  }

  /** Lo que usa el test para simular a la persona. */
  disparar(tipo, evento = {}) {
    const ev = { type: tipo, preventDefault() {}, target: this, ...evento };
    for (const fn of this.escuchas.get(tipo) ?? []) fn(ev);
    return ev;
  }
}

class Estilo {
  constructor(props = {}) { this.props = { ...props }; }
  setProperty(nombre, valor) { this.props[nombre] = String(valor); }
  getPropertyValue(nombre) { return this.props[nombre] ?? ''; }
  removeProperty(nombre) { delete this.props[nombre]; }
  /* height, color y compañia se escriben como propiedades sueltas; se
     guardan igual para poder mirarlas desde el test. */
  set height(v) { this.props.height = String(v); }
  get height() { return this.props.height ?? ''; }
  set color(v) { this.props.color = String(v); }
  get color() { return this.props.color ?? ''; }
}

/* --------------------------------------------------- parseo de HTML

   Alcanza con lo que hay en paginas/: etiquetas bien cerradas,
   comentarios, y los vacios de siempre. No pretende ser un parser de
   HTML; pretende no dejar que el test invente el arbol. */

const VACIOS = new Set(['meta', 'link', 'br', 'img', 'input', 'hr', 'source']);

function parsearAtributos(crudo) {
  const salida = new Map();
  const re = /([a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(crudo))) {
    const valor = m[2] === undefined ? '' : m[2].replace(/^["']|["']$/g, '');
    salida.set(m[1], valor);
  }
  return salida;
}

export function parsearHtml(html) {
  const raiz = new Elemento('root');
  const porId = new Map();
  const pila = [raiz];

  const anotar = el => {
    const atributos = el.atributos;
    if (atributos.has('id')) porId.set(atributos.get('id'), el);
    if (atributos.has('hidden')) el.hidden = true;
    for (const [k, v] of atributos) {
      if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
  };

  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [todo, cierre, apertura, atributos, barra, texto] = m;
    if (todo.startsWith('<!')) continue;

    if (cierre) {
      if (pila.length > 1) pila.pop();
      continue;
    }
    if (apertura) {
      const el = new Elemento(apertura);
      el.atributos = parsearAtributos(atributos ?? '');
      anotar(el);
      pila.at(-1).appendChild(el);
      if (!VACIOS.has(apertura.toLowerCase()) && !barra) pila.push(el);
      continue;
    }
    if (texto && texto.trim()) pila.at(-1).appendChild(new NodoTexto(texto.trim()));
  }

  return { raiz, porId };
}

/* --------------------------------------------------------- la pagina */

/**
 * Levanta chat.html en un DOM de mentira y corre un script de
 * `paginas/` adentro.
 *
 * @param {object} opciones
 * @param {string} [opciones.archivo]   html a montar (por defecto chat.html)
 * @param {string} [opciones.script]    js a correr (por defecto chat/chat.js)
 * @param {string} [opciones.busqueda]  el `?...` de la URL
 * @param {function} [opciones.fetch]   el fetch que ve la pagina
 * @param {object} [opciones.Sala]      el cliente del bus SSE
 */
export function abrirPagina({
  archivo = 'chat.html',
  script = 'chat/chat.js',
  busqueda = '',
  fetch: elFetch = async () => { throw new Error('la pagina no deberia pedir nada'); },
  Sala = null,
} = {}) {
  const html = fs.readFileSync(path.join(PAGINAS, archivo), 'utf8');
  const { raiz, porId } = parsearHtml(html);

  const buscar = (nodo, etiqueta) => {
    if (nodo.tagName === etiqueta) return nodo;
    for (const h of nodo.children) {
      const encontrado = buscar(h, etiqueta);
      if (encontrado) return encontrado;
    }
    return null;
  };
  const documentElement = buscar(raiz, 'HTML') ?? raiz;
  const cabeza = buscar(raiz, 'HEAD') ?? documentElement;

  /* Las variables de marca salen de la hoja de estilos de verdad: si
     alguien cambia --kick en base.css, la pagina de este test tambien
     lo ve. */
  const base = fs.readFileSync(path.join(PAGINAS, 'comun', 'base.css'), 'utf8');
  for (const nombre of ['--kick', '--twitch']) {
    const m = new RegExp(`${nombre}\\s*:\\s*([^;]+);`).exec(base);
    if (m) documentElement.style.setProperty(nombre, m[1].trim());
  }

  const temporizadores = new Set();

  const documento = {
    documentElement,
    head: cabeza,
    body: raiz,
    getElementById: id => porId.get(id) ?? null,
    createElement: etiqueta => {
      const el = new Elemento(etiqueta);
      el.raiz = documento;
      return el;
    },
    createTextNode: t => new NodoTexto(t),
    /* Un <script src> agregado a la cabeza se carga de verdad: asi
       ?demo=1 corre el demo.js que existe, no una imitacion. */
    alAgregar: nodo => {
      if (!(nodo instanceof Elemento) || nodo.tagName !== 'SCRIPT' || !nodo.src) return;
      const ruta = path.join(PAGINAS, nodo.src);
      const codigo = fs.readFileSync(ruta, 'utf8');
      vm.runInContext(codigo, contexto, { filename: nodo.src });
      nodo.onload?.();
    },
  };
  cabeza.raiz = documento;
  raiz.raiz = documento;

  const almacenLocal = new Map();

  const caja = {
    console,
    URL, URLSearchParams, Response, TextDecoder,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); temporizadores.add(t); t.unref?.(); return t; },
    clearTimeout: t => { temporizadores.delete(t); return clearTimeout(t); },
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); temporizadores.add(t); t.unref?.(); return t; },
    clearInterval: t => { temporizadores.delete(t); return clearInterval(t); },
    queueMicrotask,
    document: documento,
    location: { search: busqueda, pathname: '/chat', href: 'https://sala.example/chat' + busqueda },
    history: { urls: [], replaceState(_a, _b, url) { this.urls.push(url); } },
    navigator: {},                       // sin serviceWorker: como file://
    localStorage: {
      getItem: k => (almacenLocal.has(k) ? almacenLocal.get(k) : null),
      setItem: (k, v) => almacenLocal.set(k, String(v)),
      removeItem: k => almacenLocal.delete(k),
    },
    getComputedStyle: el => el.style,
    fetch: (...a) => elFetch(...a),
  };
  caja.window = caja;
  if (Sala) caja.Sala = Sala;

  const contexto = vm.createContext(caja);
  vm.runInContext(fs.readFileSync(path.join(PAGINAS, script), 'utf8'), contexto, { filename: script });

  return {
    ventana: caja,
    documento,
    porId,
    el: id => {
      const e = porId.get(id);
      if (!e) throw new Error(`la pagina no tiene ningun elemento con id "${id}"`);
      return e;
    },
    /** Apaga los intervalos que dejo prendidos la pagina. */
    cerrar() {
      for (const t of temporizadores) { clearTimeout(t); clearInterval(t); }
      temporizadores.clear();
    },
  };
}
