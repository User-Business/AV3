import type { EstadoFisico, TipoEquipamento } from '../generated/prisma/enums.js';
import { ORDEM_ESTADO_FISICO } from './equipamento.js';
import { arredondar, minimosQuadrados, resumir, suavizacaoExponencial, type Resumo } from './estatistica.js';

/*
 * Regras analíticas puras: recebem dados já carregados e devolvem métricas,
 * sem acesso a banco. O mesmo código serve ao agendador, aos endpoints e aos
 * relatórios assíncronos, e é testado isoladamente.
 */

const HORA_MS = 3_600_000;
const ANO_MS = 365.25 * 24 * HORA_MS;

/** Nível ordinal do estado físico: 0 (NOVO) ... 6 (INSERVIVEL). */
export function nivelEstado(estado: EstadoFisico): number {
  return ORDEM_ESTADO_FISICO.indexOf(estado);
}
export const NIVEL_INSERVIVEL = ORDEM_ESTADO_FISICO.length - 1;

/** Idade em anos; sem data exata de fabricação, assume-se o meio do ano. */
export function idadeEmAnos(anoFabricacao: number, referencia: Date): number {
  return Math.max(0, (referencia.getTime() - Date.UTC(anoFabricacao, 6, 1)) / ANO_MS);
}

// ---------------------------------------------------------------------------
// 1) Eficiência operacional
// ---------------------------------------------------------------------------

export interface LoteTriado {
  dataEntrada: Date;
  conclusaoTriagemEm: Date;
  responsavelTriagem: string | null;
}

export interface GrupoEficiencia extends Resumo {
  dimensao: 'GERAL' | 'OPERADOR' | 'MES';
  chave: string;
  rotulo: string;
  gargalo: boolean;
}

/**
 * Um grupo (operador ou mês) é gargalo quando sua mediana supera em 25% a
 * mediana dos DEMAIS lotes. Duas escolhas deliberadas:
 *  - mediana, e não média: um lote isolado parado semanas aguardando triagem
 *    não distorce a referência;
 *  - comparação com os demais, e não com o total: um operador que processa
 *    boa parte dos lotes não "puxa" para si a referência com que é comparado.
 */
export const FATOR_GARGALO = 1.25;
/** Grupos com poucos lotes não são sinalizados (evita alarme por caso isolado). */
export const LOTES_MINIMOS_GARGALO = 3;

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/**
 * Tempo de processamento = entrada do lote até a conclusão da triagem,
 * agregado no geral, por operador (responsável pela conclusão) e por mês.
 */
export function calcularEficiencia(lotes: readonly LoteTriado[]): GrupoEficiencia[] {
  const horas = (l: LoteTriado) => (l.conclusaoTriagemEm.getTime() - l.dataEntrada.getTime()) / HORA_MS;
  const validos = lotes.filter((l) => horas(l) >= 0);
  const geral = resumir(validos.map(horas));

  const agrupar = (dimensao: 'OPERADOR' | 'MES', chaveDe: (l: LoteTriado) => [string, string]) => {
    const grupos = new Map<string, { rotulo: string; valores: number[] }>();
    for (const lote of validos) {
      const [chave, rotulo] = chaveDe(lote);
      const grupo = grupos.get(chave) ?? { rotulo, valores: [] };
      grupo.valores.push(horas(lote));
      grupos.set(chave, grupo);
    }
    return [...grupos.entries()]
      .map(([chave, g]): GrupoEficiencia => {
        const r = resumir(g.valores);
        const demais = validos.filter((l) => chaveDe(l)[0] !== chave).map(horas);
        const gargalo = r.n >= LOTES_MINIMOS_GARGALO && demais.length > 0 && r.mediana > resumir(demais).mediana * FATOR_GARGALO;
        return { ...r, dimensao, chave, rotulo: g.rotulo, gargalo };
      })
      .sort((a, b) => a.chave.localeCompare(b.chave));
  };

  return [
    { ...geral, dimensao: 'GERAL', chave: 'geral', rotulo: 'Todos os lotes', gargalo: false },
    ...agrupar('OPERADOR', (l) => [l.responsavelTriagem ?? 'desconhecido', l.responsavelTriagem ?? 'Não informado']),
    ...agrupar('MES', (l) => {
      const d = l.conclusaoTriagemEm;
      const mes = d.getUTCMonth();
      return [`${d.getUTCFullYear()}-${String(mes + 1).padStart(2, '0')}`, `${MESES[mes]}/${d.getUTCFullYear()}`];
    }),
  ];
}

// ---------------------------------------------------------------------------
// 2) Rentabilidade por tipo de equipamento
// ---------------------------------------------------------------------------

export interface ItemRecuperado {
  tipo: TipoEquipamento;
  estadoFisico: EstadoFisico;
  marca: string;
  modelo: string;
  valor: number;
  pesoKg: number;
}

export interface GrupoRentabilidade {
  tipo: TipoEquipamento;
  estadoFisico: EstadoFisico | null;
  marca: string | null;
  modelo: string | null;
  amostras: number;
  valorMedio: number;
  valorMediano: number;
  desvioPadrao: number;
  valorTotal: number;
  valorMedioPorKg: number;
}

type ChaveRentabilidade = Pick<GrupoRentabilidade, 'tipo' | 'estadoFisico' | 'marca' | 'modelo'>;

/**
 * Agrega o valor recuperado por tipo; por tipo e estado físico; e por tipo,
 * marca e modelo. Ordenado do maior para o menor valor médio (ranking).
 */
export function calcularRentabilidade(itens: readonly ItemRecuperado[]): GrupoRentabilidade[] {
  const grupos = new Map<string, { chave: ChaveRentabilidade; valores: number[]; peso: number }>();
  const adicionar = (chave: ChaveRentabilidade, item: ItemRecuperado) => {
    const id = [chave.tipo, chave.estadoFisico ?? '*', chave.marca ?? '*', chave.modelo ?? '*'].join('|');
    const grupo = grupos.get(id) ?? { chave, valores: [], peso: 0 };
    grupo.valores.push(item.valor);
    grupo.peso += item.pesoKg;
    grupos.set(id, grupo);
  };
  for (const item of itens) {
    adicionar({ tipo: item.tipo, estadoFisico: null, marca: null, modelo: null }, item);
    adicionar({ tipo: item.tipo, estadoFisico: item.estadoFisico, marca: null, modelo: null }, item);
    adicionar({ tipo: item.tipo, estadoFisico: null, marca: item.marca, modelo: item.modelo }, item);
  }
  return [...grupos.values()]
    .map(({ chave, valores, peso }) => {
      const r = resumir(valores);
      return {
        ...chave,
        amostras: r.n,
        valorMedio: r.media,
        valorMediano: r.mediana,
        desvioPadrao: r.desvioPadrao,
        valorTotal: r.total,
        valorMedioPorKg: peso > 0 ? arredondar(r.total / peso) : 0,
      };
    })
    .sort((a, b) => b.valorMedio - a.valorMedio);
}

// ---------------------------------------------------------------------------
// 3) Vida útil remanescente
// ---------------------------------------------------------------------------

export interface ObservacaoDepreciacao {
  tipo: TipoEquipamento;
  idadeAnos: number;
  nivel: number;
}

export interface ModeloVidaUtil {
  tipo: TipoEquipamento;
  metodo: 'MINIMOS_QUADRADOS' | 'SUAVIZACAO_EXPONENCIAL';
  amostras: number;
  coeficienteAngular: number | null;
  intercepto: number | null;
  r2: number | null;
  idadeInservivelAnos: number | null;
  suficiente: boolean;
  observacao: string | null;
}

export const AMOSTRAS_MINIMAS_REGRESSAO = 5;

/**
 * Por tipo, ajusta nível = a + b·idade e projeta a idade de inservibilidade
 * (6 − a) / b. Com poucas observações ou sem tendência de degradação (b ≤ 0),
 * estima a taxa nível/idade por suavização exponencial.
 */
export function ajustarModelosVidaUtil(observacoes: readonly ObservacaoDepreciacao[]): ModeloVidaUtil[] {
  const porTipo = new Map<TipoEquipamento, ObservacaoDepreciacao[]>();
  for (const o of observacoes) porTipo.set(o.tipo, [...(porTipo.get(o.tipo) ?? []), o]);

  return [...porTipo.entries()].map(([tipo, obs]): ModeloVidaUtil => {
    const reg = obs.length >= AMOSTRAS_MINIMAS_REGRESSAO
      ? minimosQuadrados(obs.map((o) => [o.idadeAnos, o.nivel] as const))
      : null;

    if (reg && reg.coeficienteAngular > 0) {
      return {
        tipo,
        metodo: 'MINIMOS_QUADRADOS',
        amostras: obs.length,
        coeficienteAngular: arredondar(reg.coeficienteAngular),
        intercepto: arredondar(reg.intercepto),
        r2: arredondar(reg.r2),
        idadeInservivelAnos: arredondar(Math.max(0, (NIVEL_INSERVIVEL - reg.intercepto) / reg.coeficienteAngular), 2),
        suficiente: true,
        observacao: reg.r2 < 0.3 ? 'Ajuste fraco (R² < 0,3): usar com cautela' : null,
      };
    }

    const taxas = obs
      .filter((o) => o.idadeAnos > 0.1 && o.nivel > 0)
      .sort((a, b) => a.idadeAnos - b.idadeAnos)
      .map((o) => o.nivel / o.idadeAnos);
    const taxa = suavizacaoExponencial(taxas);
    return {
      tipo,
      metodo: 'SUAVIZACAO_EXPONENCIAL',
      amostras: obs.length,
      coeficienteAngular: taxa === null ? null : arredondar(taxa),
      intercepto: taxa === null ? null : 0,
      r2: null,
      idadeInservivelAnos: taxa ? arredondar(NIVEL_INSERVIVEL / taxa, 2) : null,
      suficiente: false,
      observacao: taxa === null
        ? 'Sem observações de degradação para este tipo'
        : `Menos de ${AMOSTRAS_MINIMAS_REGRESSAO} observações ou sem tendência de degradação; estimativa por suavização exponencial`,
    };
  });
}

/** Vida remanescente: níveis que faltam até INSERVIVEL ÷ taxa anual de degradação do tipo. */
export function projetarVidaRemanescente(
  modelo: Pick<ModeloVidaUtil, 'coeficienteAngular'> | undefined,
  nivelAtual: number,
  referencia: Date,
): { anos: number | null; dataPrevista: Date | null } {
  if (nivelAtual >= NIVEL_INSERVIVEL) return { anos: 0, dataPrevista: referencia };
  const taxa = modelo?.coeficienteAngular;
  if (!taxa || taxa <= 0) return { anos: null, dataPrevista: null };
  const anos = (NIVEL_INSERVIVEL - nivelAtual) / taxa;
  return { anos: arredondar(anos, 2), dataPrevista: new Date(referencia.getTime() + anos * ANO_MS) };
}

/** Erro absoluto médio entre idade prevista e idade real ao se tornar inservível. */
export function erroAbsolutoMedio(pares: ReadonlyArray<{ previsto: number; real: number }>): number | null {
  if (pares.length === 0) return null;
  return arredondar(pares.reduce((s, p) => s + Math.abs(p.previsto - p.real), 0) / pares.length, 3);
}
