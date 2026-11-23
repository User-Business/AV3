import { mean, median, quantileSorted, sampleStandardDeviation } from 'simple-statistics';

/*
 * Primitivas estatísticas da camada analítica. A biblioteca simple-statistics
 * cobre a estatística descritiva; a regressão por mínimos quadrados é escrita
 * aqui para que o método fique explícito e auditável (e é conferida contra a
 * própria biblioteca nos testes).
 */

export interface Resumo {
  n: number;
  media: number;
  mediana: number;
  desvioPadrao: number;
  percentil90: number;
  total: number;
}

export function arredondar(valor: number, casas = 4): number {
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}

/** Estatística descritiva; amostra vazia devolve zeros. */
export function resumir(valores: readonly number[]): Resumo {
  if (valores.length === 0) return { n: 0, media: 0, mediana: 0, desvioPadrao: 0, percentil90: 0, total: 0 };
  const ordenados = [...valores].sort((a, b) => a - b);
  return {
    n: valores.length,
    media: arredondar(mean([...valores])),
    mediana: arredondar(median(ordenados)),
    // Desvio padrão amostral (n - 1): exige ao menos dois pontos
    desvioPadrao: valores.length > 1 ? arredondar(sampleStandardDeviation([...valores])) : 0,
    percentil90: arredondar(quantileSorted(ordenados, 0.9)),
    total: arredondar(valores.reduce((a, b) => a + b, 0)),
  };
}

export interface Regressao {
  coeficienteAngular: number;
  intercepto: number;
  r2: number;
  n: number;
}

/**
 * Regressão linear simples por mínimos quadrados ordinários:
 *   b = Σ(x − x̄)(y − ȳ) / Σ(x − x̄)²      a = ȳ − b·x̄      R² = 1 − SQres/SQtot
 * Devolve null com menos de 2 pontos ou sem variação em x.
 */
export function minimosQuadrados(pontos: ReadonlyArray<readonly [number, number]>): Regressao | null {
  const n = pontos.length;
  if (n < 2) return null;
  const mediaX = pontos.reduce((s, [x]) => s + x, 0) / n;
  const mediaY = pontos.reduce((s, [, y]) => s + y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pontos) {
    sxy += (x - mediaX) * (y - mediaY);
    sxx += (x - mediaX) ** 2;
  }
  if (sxx === 0) return null;

  const b = sxy / sxx;
  const a = mediaY - b * mediaX;
  let sqRes = 0;
  let sqTot = 0;
  for (const [x, y] of pontos) {
    sqRes += (y - (a + b * x)) ** 2;
    sqTot += (y - mediaY) ** 2;
  }
  return { coeficienteAngular: b, intercepto: a, r2: sqTot === 0 ? 1 : 1 - sqRes / sqTot, n };
}

/** Suavização exponencial simples: Sₜ = α·xₜ + (1 − α)·Sₜ₋₁. */
export function suavizacaoExponencial(serie: readonly number[], alfa = 0.3): number | null {
  if (alfa <= 0 || alfa > 1) throw new RangeError('alfa deve estar no intervalo (0, 1]');
  const [primeiro, ...resto] = serie;
  if (primeiro === undefined) return null;
  return resto.reduce((s, x) => alfa * x + (1 - alfa) * s, primeiro);
}
