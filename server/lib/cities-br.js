'use strict';

/*
 * Curated city list for the weather widget.
 *
 * COORDINATES, NOT NAMES. wttr.in resolves a name to whatever it thinks is nearest, and that is
 * ambiguous in ways that fail silently: "Pinheiros" is a town in Espírito Santo AND a well-known
 * district of São Paulo, 800km apart. A name lookup would happily return the wrong one and the
 * screen would show a plausible-looking temperature that is simply not the customer's weather.
 * Fixed lat/lon removes the guess entirely.
 *
 * `label` is what the SCREEN shows — deliberately not the weather station's name. The nearest
 * station to Pinheiros/ES is called Jundiá; the customer picked "Pinheiros", so that is what they
 * should read.
 *
 * The list is a convenience for the picker, NOT a prefetch list: lib/weather.js only ever fetches
 * the cities a widget is actually configured with.
 */

// The four the operator asked for by name, kept at the top of the picker because they are the
// ones this install actually serves.
const PRIORITY = [
  { id: 'montanha-es',   label: 'Montanha',              uf: 'ES', lat: -18.1297, lon: -40.3644 },
  { id: 'pinheiros-es',  label: 'Pinheiros',             uf: 'ES', lat: -18.4133, lon: -40.2181 },
  { id: 'nanuque-mg',    label: 'Nanuque',               uf: 'MG', lat: -17.8386, lon: -40.3539 },
  { id: 'sgp-es',        label: 'São Gabriel da Palha',  uf: 'ES', lat: -19.0186, lon: -40.5364 },
];

// Every state capital plus the Federal District, alphabetical by city.
const CAPITALS = [
  { id: 'aracaju-se',        label: 'Aracaju',         uf: 'SE', lat: -10.9472, lon: -37.0731 },
  { id: 'belem-pa',          label: 'Belém',           uf: 'PA', lat:  -1.4558, lon: -48.5044 },
  { id: 'belo-horizonte-mg', label: 'Belo Horizonte',  uf: 'MG', lat: -19.9167, lon: -43.9345 },
  { id: 'boa-vista-rr',      label: 'Boa Vista',       uf: 'RR', lat:   2.8235, lon: -60.6758 },
  { id: 'brasilia-df',       label: 'Brasília',        uf: 'DF', lat: -15.7975, lon: -47.8919 },
  { id: 'campo-grande-ms',   label: 'Campo Grande',    uf: 'MS', lat: -20.4697, lon: -54.6201 },
  { id: 'cuiaba-mt',         label: 'Cuiabá',          uf: 'MT', lat: -15.6014, lon: -56.0979 },
  { id: 'curitiba-pr',       label: 'Curitiba',        uf: 'PR', lat: -25.4284, lon: -49.2733 },
  { id: 'florianopolis-sc',  label: 'Florianópolis',   uf: 'SC', lat: -27.5954, lon: -48.5480 },
  { id: 'fortaleza-ce',      label: 'Fortaleza',       uf: 'CE', lat:  -3.7319, lon: -38.5267 },
  { id: 'goiania-go',        label: 'Goiânia',         uf: 'GO', lat: -16.6869, lon: -49.2648 },
  { id: 'joao-pessoa-pb',    label: 'João Pessoa',     uf: 'PB', lat:  -7.1195, lon: -34.8450 },
  { id: 'macapa-ap',         label: 'Macapá',          uf: 'AP', lat:   0.0389, lon: -51.0664 },
  { id: 'maceio-al',         label: 'Maceió',          uf: 'AL', lat:  -9.6498, lon: -35.7089 },
  { id: 'manaus-am',         label: 'Manaus',          uf: 'AM', lat:  -3.1190, lon: -60.0217 },
  { id: 'natal-rn',          label: 'Natal',           uf: 'RN', lat:  -5.7945, lon: -35.2110 },
  { id: 'palmas-to',         label: 'Palmas',          uf: 'TO', lat: -10.1849, lon: -48.3336 },
  { id: 'porto-alegre-rs',   label: 'Porto Alegre',    uf: 'RS', lat: -30.0346, lon: -51.2177 },
  { id: 'porto-velho-ro',    label: 'Porto Velho',     uf: 'RO', lat:  -8.7612, lon: -63.9004 },
  { id: 'recife-pe',         label: 'Recife',          uf: 'PE', lat:  -8.0476, lon: -34.8770 },
  { id: 'rio-branco-ac',     label: 'Rio Branco',      uf: 'AC', lat:  -9.9754, lon: -67.8249 },
  { id: 'rio-de-janeiro-rj', label: 'Rio de Janeiro',  uf: 'RJ', lat: -22.9068, lon: -43.1729 },
  { id: 'salvador-ba',       label: 'Salvador',        uf: 'BA', lat: -12.9777, lon: -38.5016 },
  { id: 'sao-luis-ma',       label: 'São Luís',        uf: 'MA', lat:  -2.5307, lon: -44.3068 },
  { id: 'sao-paulo-sp',      label: 'São Paulo',       uf: 'SP', lat: -23.5505, lon: -46.6333 },
  { id: 'teresina-pi',       label: 'Teresina',        uf: 'PI', lat:  -5.0892, lon: -42.8019 },
  { id: 'vitoria-es',        label: 'Vitória',         uf: 'ES', lat: -20.3155, lon: -40.3128 },
];

const CITIES = [...PRIORITY, ...CAPITALS];
const BY_ID = new Map(CITIES.map((c) => [c.id, c]));

function findCity(id) {
  return BY_ID.get(String(id || '').trim()) || null;
}

/* "Montanha — ES", for the picker and for the screen. */
function cityLabel(city) {
  return city ? `${city.label} — ${city.uf}` : '';
}

module.exports = { CITIES, PRIORITY, CAPITALS, findCity, cityLabel };
